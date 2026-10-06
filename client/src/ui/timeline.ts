// Plain absolutely-positioned DOM timeline. Isolated so it can be redesigned.
import {
  addClip, addTrack, deleteClip, getClips, getSamples, getTracks, moveClip, trimClip, updateTrack, deleteTrack,
  clipsMap, tracksMap, samplesMap, type Track,
} from '@mobdaw/shared'
import { engine } from '../audio/engine'
import { h } from '../dom'
import { getSampleBuffer, importFile, peekBuffer, playable } from '../samples'
import type { Session } from '../project/session'

const HEADER = 140
const EDGE = 8
const MIN_DUR = 0.05

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
const audioFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(f.name))
const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

type Lane = { el: HTMLElement; body: HTMLElement; name: HTMLElement; mute: HTMLButtonElement; gain: HTMLInputElement }

export function mountTimeline(s: Session, projectName: string, readOnly = false) {
  const { doc, undo } = s
  let pps = 80
  let selection: string[] = []
  const lanes = new Map<string, Lane>()
  const clipEls = new Map<string, HTMLElement>()
  const requested = new Set<string>()
  let raf = 0
  let destroyed = false

  // --- static structure
  const playBtn = h('button', { className: 'play', onclick: () => toggle() }, 'Play')
  const time = h('span', { className: 'time' }, fmt(0))
  const status = h('span', { className: 'dim' })
  const presence = h('span', { className: 'presence' })
  // "+ audio": into the selected clip's track (else a new track), at the playhead.
  const fileInput = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true })
  fileInput.onchange = () => {
    const trackId = getClips(doc).find((c) => c.id === selection[0])?.trackId ?? null
    void dropFiles(audioFiles(fileInput.files), trackId, engine.currentTime())
    fileInput.value = ''
  }
  const addAudio = readOnly ? null : h('button', { onclick: () => fileInput.click() }, '+ audio')
  const bar = h('header', { className: 'bar' },
    h('a', { href: '#/projects' }, '←'), h('strong', {}, projectName), playBtn, time, addAudio, status,
    readOnly ? h('span', { className: 'dim' }, 'view only') : null, h('span', { className: 'grow' }), presence)
  const ruler = h('div', { className: 'ruler' }, h('div', { className: 'corner' }))
  const rulerBody = h('div', { className: 'ruler-body' })
  ruler.append(rulerBody)
  const laneBox = h('div', { className: 'lanes' })
  const addLink = h('a', { className: 'add-track', href: '#', onclick: (e: Event) => {
    e.preventDefault()
    addTrack(doc, `Track ${getTracks(doc).length + 1}`)
  } }, '+ track')
  const overlay = h('div', { className: 'overlay' })
  const playhead = h('div', { className: 'playhead' })
  overlay.append(playhead)
  const hint = h('div', { className: 'hint dim' }, readOnly ? 'Nothing here yet.' : 'Drop audio files here, or use + audio.')
  const content = h('div', { className: 'content' }, ruler, laneBox, hint, readOnly ? null : addLink, overlay)
  const scroll = h('div', { className: 'scroll' }, content)
  // Drops outside any lane start a new track.
  scroll.ondragover = (e) => e.preventDefault()
  scroll.ondrop = (e) => {
    e.preventDefault()
    if (readOnly) return
    void dropFiles(audioFiles(e.dataTransfer?.files), null, Math.max(0, (e.clientX - rulerBody.getBoundingClientRect().left) / pps))
  }
  const el = h('div', { className: 'timeline' }, bar, scroll)

  const project = () => ({ tracks: getTracks(doc), clips: getClips(doc) })
  const x = (t: number) => t * pps

  // --- transport
  function toggle() {
    if (engine.playing) stop()
    else {
      engine.play(engine.currentTime(), project(), peekBuffer)
      playBtn.textContent = 'Stop'
      tick()
    }
  }
  function stop() {
    engine.stop()
    playBtn.textContent = 'Play'
    s.setLocal({ playhead: null })
    draw()
  }
  let lastAware = 0
  function tick() {
    if (destroyed || !engine.playing) return
    drawPlayhead()
    const now = performance.now()
    if (now - lastAware > 100) {
      lastAware = now
      s.setLocal({ playhead: engine.currentTime() })
    }
    requestAnimationFrame(tick)
  }
  function drawPlayhead() {
    const t = engine.currentTime()
    playhead.style.left = `${HEADER + x(t)}px`
    time.textContent = fmt(t)
  }
  function seek(t: number) {
    if (engine.playing) engine.play(t, project(), peekBuffer)
    else engine.seek(t)
    drawPlayhead()
  }

  // --- rendering (keyed reuse; scheduled via rAF)
  function schedule() {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), draw()))
  }

  function laneFor(t: Track): Lane {
    let l = lanes.get(t.id)
    if (l) return l
    const name = h('span', { className: 'name', ondblclick: () => readOnly || rename(t.id) })
    const mute = h('button', { className: 'mute', title: 'mute', onclick: () => {
      const cur = getTracks(doc).find((x) => x.id === t.id)
      if (cur) updateTrack(doc, t.id, { muted: !cur.muted })
    } }, 'M')
    mute.disabled = readOnly
    const gain = h('input', { type: 'range', min: 0, max: 1, step: 0.01, title: 'gain', disabled: readOnly })
    gain.oninput = () => updateTrack(doc, t.id, { gain: Number(gain.value) })
    gain.onpointerdown = () => undo.stopCapturing()
    const del = h('button', { className: 'del', title: 'delete track', onclick: () => {
      if (confirm('Delete this track and its clips?')) deleteTrack(doc, t.id)
    } }, '×')
    const head = h('div', { className: 'head' }, name, h('div', { className: 'ctl' }, mute, gain, readOnly ? null : del))
    const body = h('div', { className: 'lane-body', 'data-track': t.id })
    body.onpointerdown = (e) => {
      if (e.target === body) select([])
    }
    body.ondragover = (e) => e.preventDefault()
    body.ondrop = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (readOnly) return
      void dropFiles(audioFiles(e.dataTransfer?.files), t.id, Math.max(0, (e.clientX - body.getBoundingClientRect().left) / pps))
    }
    l = { el: h('div', { className: 'lane' }, head, body), body, name, mute, gain }
    lanes.set(t.id, l)
    return l
  }

  function rename(id: string) {
    const l = lanes.get(id)!
    const input = h('input', { value: l.name.textContent ?? '', className: 'rename' })
    const done = (ok: boolean) => {
      if (!input.isConnected) return
      if (ok && input.value.trim()) updateTrack(doc, id, { name: input.value.trim() })
      input.replaceWith(l.name)
    }
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false) }
    input.onblur = () => done(true)
    l.name.replaceWith(input)
    input.focus()
    input.select()
  }

  function draw() {
    if (destroyed) return
    const tracks = getTracks(doc)
    const clips = getClips(doc)
    const samples = getSamples(doc)
    const total = Math.max(60, ...clips.map((c) => c.start + c.duration + 30))
    content.style.width = `${HEADER + x(total)}px`
    rulerBody.style.width = `${x(total)}px`
    drawRuler(total)

    // lanes
    hint.hidden = tracks.length > 0
    const ids = new Set(tracks.map((t) => t.id))
    for (const [id, l] of lanes) if (!ids.has(id)) { l.el.remove(); lanes.delete(id) }
    tracks.forEach((t, i) => {
      const l = laneFor(t)
      if (laneBox.children[i] !== l.el) laneBox.insertBefore(l.el, laneBox.children[i] ?? null)
      l.body.style.width = `${x(total)}px`
      if (l.name.textContent !== t.name) l.name.textContent = t.name
      l.mute.classList.toggle('on', t.muted)
      if (document.activeElement !== l.gain) l.gain.value = String(t.gain)
    })

    // clips
    selection = selection.filter((id) => clipsMap(doc).has(id))
    const remote = s.remoteStates()
    const outline = new Map<string, string>()
    for (const r of remote) for (const id of r.selection ?? []) outline.set(id, r.user.color)
    const cids = new Set(clips.map((c) => c.id))
    for (const [id, e] of clipEls) if (!cids.has(id)) { e.remove(); clipEls.delete(id) }
    for (const c of clips) {
      const lane = lanes.get(c.trackId)
      if (!lane) continue
      let e = clipEls.get(c.id)
      if (!e) {
        e = h('div', { className: 'clip' })
        e.onpointerdown = (ev) => clipDown(ev, c.id)
        clipEls.set(c.id, e)
      }
      if (e.parentElement !== lane.body) lane.body.append(e)
      e.style.left = `${x(c.start)}px`
      e.style.width = `${Math.max(2, x(c.duration))}px`
      const meta = samples[c.sampleHash]
      const canPlay = !!meta && playable(meta)
      const label = meta ? (canPlay ? meta.name : `${meta.name} · too long to play yet`) : '…'
      if (e.textContent !== label) e.textContent = label
      e.classList.toggle('sel', selection.includes(c.id))
      e.classList.toggle('unplayable', !canPlay)
      const o = outline.get(c.id)
      e.style.outline = o ? `2px solid ${o}` : ''
      if (canPlay && !peekBuffer(c.sampleHash) && !requested.has(c.sampleHash)) {
        requested.add(c.sampleHash)
        getSampleBuffer(s.projectId, c.sampleHash).then(
          () => engine.playing && !destroyed && engine.restart(project(), peekBuffer),
          (err) => { requested.delete(c.sampleHash); console.warn(err) },
        )
      }
    }

    // presence
    presence.replaceChildren(...[s.user, ...remote.map((r) => r.user)].map((u) =>
      h('span', { className: 'dot', title: u.name, style: `background:${u.color}` }, initials(u.name))))
    for (const e of overlay.querySelectorAll('.remote-head')) e.remove()
    for (const r of remote) {
      if (r.playhead == null) continue
      overlay.append(h('div', { className: 'remote-head', style: `left:${HEADER + x(r.playhead)}px;background:${r.user.color}` }))
    }
    drawPlayhead()
  }

  function drawRuler(total: number) {
    const step = pps >= 40 ? 1 : pps >= 15 ? 5 : 10
    const n = Math.floor(total / step)
    if (rulerBody.childElementCount === n + 1 && rulerBody.dataset.pps === String(pps)) return
    rulerBody.dataset.pps = String(pps)
    rulerBody.replaceChildren(...Array.from({ length: n + 1 }, (_, i) =>
      h('span', { className: 'tick', style: `left:${x(i * step)}px` }, fmt(i * step).replace(/\.0$/, ''))))
  }

  function select(ids: string[]) {
    selection = ids
    s.setLocal({ selection: ids })
    draw()
  }

  // --- clip dragging (live Yjs updates, rAF-throttled, one undo step per drag)
  function clipDown(ev: PointerEvent, id: string) {
    if (ev.button !== 0) return
    const clip = getClips(doc).find((c) => c.id === id)
    if (!clip) return
    const e = ev.currentTarget as HTMLElement
    const trim = ev.clientX > e.getBoundingClientRect().right - EDGE
    select([id])
    if (readOnly) return
    undo.stopCapturing()
    ev.preventDefault()
    const x0 = ev.clientX
    const dur = getSamples(doc)[clip.sampleHash]?.duration ?? Infinity
    let last: PointerEvent | null = null
    let pending = 0
    const apply = () => {
      pending = 0
      if (!last || !clipsMap(doc).has(id)) return
      const dt = (last.clientX - x0) / pps
      if (trim) trimClip(doc, id, Math.min(Math.max(MIN_DUR, clip.duration + dt), dur - clip.offset))
      else {
        const lane = laneAt(last.clientY)
        moveClip(doc, id, Math.max(0, clip.start + dt), lane && lane !== clip.trackId ? lane : undefined)
      }
    }
    const move = (m: PointerEvent) => {
      last = m
      if (!pending) pending = requestAnimationFrame(apply)
    }
    const up = () => {
      cancelAnimationFrame(pending)
      apply()
      undo.stopCapturing()
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
    }
    // window listeners: the clip element is re-parented when dragged across lanes
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  function laneAt(clientY: number): string | null {
    for (const [id, l] of lanes) {
      const r = l.el.getBoundingClientRect()
      if (clientY >= r.top && clientY < r.bottom) return id
    }
    return null
  }

  // --- file drop
  async function dropFiles(files: File[], trackId: string | null, at: number) {
    for (const f of files) {
      status.textContent = `uploading ${f.name}…`
      try {
        const m = await importFile(s.projectId, doc, f)
        trackId ??= addTrack(doc, f.name.replace(/\.[^.]+$/, ''))
        addClip(doc, { trackId, sampleHash: m.hash, start: at, duration: m.duration })
        at += m.duration
        status.textContent = ''
      } catch (err) {
        status.textContent = `${f.name}: ${(err as Error).message}`
      }
    }
  }

  // --- input
  ruler.onpointerdown = (e) => {
    const r = rulerBody.getBoundingClientRect()
    seek(Math.max(0, (e.clientX - r.left) / pps))
  }
  scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    const r = rulerBody.getBoundingClientRect()
    const t = (e.clientX - r.left) / pps
    pps = Math.min(800, Math.max(10, pps * Math.exp(-e.deltaY * 0.01)))
    draw()
    scroll.scrollLeft += HEADER + x(t) - (e.clientX - scroll.getBoundingClientRect().left) - scroll.scrollLeft
  }, { passive: false })
  const key = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return
    const mod = e.metaKey || e.ctrlKey
    if (e.code === 'Space') { e.preventDefault(); toggle() }
    else if (readOnly) return
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? undo.redo() : undo.undo() }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      doc.transact(() => selection.forEach((id) => deleteClip(doc, id)))
      select([])
    }
  }
  addEventListener('keydown', key)

  // --- sync
  const onDoc = () => {
    schedule()
    if (engine.playing) engine.restart(project(), peekBuffer)
  }
  const watched = [tracksMap(doc), clipsMap(doc), samplesMap(doc)]
  watched.forEach((m) => m.observeDeep(onDoc))
  s.awareness.on('change', schedule)
  const onStatus = ({ status: st }: { status: string }) => (bar.dataset.status = st)
  s.provider.on('status', onStatus)
  s.provider.on('authenticationFailed', () => (status.textContent = 'no access'))
  draw()

  return {
    el,
    destroy() {
      destroyed = true
      cancelAnimationFrame(raf)
      removeEventListener('keydown', key)
      watched.forEach((m) => m.unobserveDeep(onDoc))
      s.awareness.off('change', schedule)
      if (engine.playing) engine.stop()
    },
  }
}
