// Plain absolutely-positioned DOM timeline. Isolated so it can be redesigned.
// Positions in the doc are integer samples; the UI zoom is pixels per second.
import {
  DEFAULT_SAMPLE_RATE, EFFECTS, FINNWAVE, addAudioClip, addDevice, addMidiClip, addTrack, clipLength, clipsMap, deleteClip,
  deleteDevice, deleteNote, deleteTrack, devicesMap, getClips, getDevices, getNotes, getSampleRate, getSamples,
  getTracks, migrateToV2, notesMap, samplesMap, setParam, splitClip, sweepOrphans, tracksMap, updateClip,
  updateDevice, updateTrack, type AwarenessState, type Clip, type Device, type Note, type Track,
} from '@mobdaw/shared'
import { openPlayback, type Playback } from '../audio/playback'
import { h } from '../dom'
import { importFile, playable } from '../samples'
import type { Session } from '../project/session'
import { deviceCard } from './devices'
import { noteEditor } from './noteEditor'
import { popover } from './popover'

const HEADER = 140
const EDGE = 8
const MIN_SEC = 0.05
const NO_DRAGS = new Map<number, number>()

const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
const audioFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(f.name))
const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

type Card = ReturnType<typeof deviceCard>
type Lane = {
  el: HTMLElement; row: HTMLElement; body: HTMLElement; name: HTMLElement; mute: HTMLButtonElement
  gain: HTMLInputElement; more: HTMLButtonElement; fx: HTMLElement; cards: Map<string, Card>
}

export function mountTimeline(s: Session, projectName: string, readOnly = false) {
  const { doc, undo } = s
  let rate = DEFAULT_SAMPLE_RATE
  let pb: Playback | null = null // created once the doc has synced (needs meta.sampleRate)
  let pps = 80
  let selection: string[] = []
  let editing: string | null = null // MIDI clip open in the note editor
  let noteSel: string | null = null
  const expanded = new Set<string>() // local UI state: tracks showing their FX chain
  const lanes = new Map<string, Lane>()
  const clipEls = new Map<string, HTMLElement>()
  let remoteDrags = new Map<string, Map<number, number>>()
  let raf = 0
  let destroyed = false

  // --- static structure
  const playBtn = h('button', { className: 'play', onclick: () => toggle() }, 'Play')
  const time = h('span', { className: 'time' }, fmt(0))
  const status = h('span', { className: 'dim' })
  const presence = h('span', { className: 'presence' })
  const bar = h('header', { className: 'bar' },
    h('a', { href: '#/projects' }, '←'), h('strong', {}, projectName), playBtn, time, status,
    readOnly ? h('span', { className: 'dim' }, 'view only') : null, h('span', { className: 'grow' }), presence)
  const ruler = h('div', { className: 'ruler' }, h('div', { className: 'corner' }))
  const rulerBody = h('div', { className: 'ruler-body' })
  ruler.append(rulerBody)
  const laneBox = h('div', { className: 'lanes' })
  // "Upload": one new audio track per chosen file, clip at the playhead.
  const fileInput = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true })
  fileInput.onchange = async () => {
    const files = audioFiles(fileInput.files)
    fileInput.value = ''
    for (const f of files) await dropFiles([f], null, pb?.position() ?? 0)
  }
  const addLink = h('a', { className: 'add-track', href: '#', onclick: (e: Event) => {
    e.preventDefault()
    const n = getTracks(doc).length + 1
    popover(addLink, [
      ['Empty', () => addTrack(doc, `Track ${n}`)],
      ['Upload', () => fileInput.click()],
      ['MIDI', () => {
        doc.transact(() => addDevice(doc, addTrack(doc, `MIDI ${n}`, 'midi'), FINNWAVE))
      }],
    ])
  } }, '+ track')
  const overlay = h('div', { className: 'overlay' })
  const playhead = h('div', { className: 'playhead' })
  overlay.append(playhead)
  const hint = h('div', { className: 'hint dim' }, readOnly ? 'Nothing here yet.' : 'Drop audio files here, or use + track.')
  const content = h('div', { className: 'content' }, ruler, laneBox, hint, readOnly ? null : addLink, fileInput, overlay)
  const scroll = h('div', { className: 'scroll' }, content)
  // Drops outside any lane start a new track.
  scroll.ondragover = (e) => e.preventDefault()
  scroll.ondrop = (e) => {
    e.preventDefault()
    if (readOnly) return
    void dropFiles(audioFiles(e.dataTransfer?.files), null, fromX(e.clientX - rulerBody.getBoundingClientRect().left))
  }
  const el = h('div', { className: 'timeline' }, bar, scroll)

  const x = (smp: number) => (smp / rate) * pps
  const fromX = (px: number) => Math.max(0, Math.round((px / pps) * rate))
  const position = () => pb?.position() ?? 0

  const ne = noteEditor({
    doc, undo, readOnly,
    selectNote: (id) => ((noteSel = id), draw()),
    close: () => ((editing = null), (noteSel = null), draw()),
  })

  // --- transport
  function toggle() {
    if (!pb) return
    if (pb.playing) stop()
    else {
      pb.play()
      playBtn.textContent = 'Stop'
      tick()
    }
  }
  function stop() {
    pb?.stop()
    playBtn.textContent = 'Play'
    s.setLocal({ playhead: null })
    draw()
  }
  let lastAware = 0
  function tick() {
    if (destroyed || !pb?.playing) return
    drawPlayhead()
    const now = performance.now()
    if (now - lastAware > 100) {
      lastAware = now
      s.setLocal({ playhead: position() })
    }
    requestAnimationFrame(tick)
  }
  function drawPlayhead() {
    const p = position()
    playhead.style.left = `${HEADER + x(p)}px`
    time.textContent = fmt(p / rate)
  }
  function seek(smp: number) {
    pb?.seek(smp)
    drawPlayhead()
  }

  // --- rendering (keyed reuse; scheduled via rAF)
  function schedule() {
    if (!raf) raf = requestAnimationFrame(() => ((raf = 0), draw()))
  }

  const cardDeps = {
    readOnly,
    live: (d: string, p: number, v: number) => pb?.live(d, p, v),
    drag: (d: AwarenessState['dragging']) => s.setLocal({ dragging: d }),
    commit: (d: string, p: number, v: number) => {
      undo.stopCapturing()
      setParam(doc, d, p, v)
      undo.stopCapturing()
    },
    bypass: (d: string, b: boolean) => updateDevice(doc, d, { bypass: b }),
    remove: (d: string) => deleteDevice(doc, d),
  }

  function laneFor(t: Track): Lane {
    let l = lanes.get(t.id)
    if (l) return l
    const name = h('span', { className: 'name', ondblclick: () => readOnly || rename(t.id) })
    const mute = h('button', { className: 'mute', title: 'mute', onclick: () => {
      updateTrack(doc, t.id, { muted: !tracksMap(doc).get(t.id)?.get('muted') })
    } }, 'M')
    mute.disabled = readOnly
    const gain = h('input', { type: 'range', min: 0, max: 1, step: 0.01, title: 'gain', disabled: readOnly })
    gain.oninput = () => updateTrack(doc, t.id, { gain: Number(gain.value) })
    gain.onpointerdown = () => undo.stopCapturing()
    const more = h('button', { title: 'effects', onclick: () => {
      if (!expanded.delete(t.id)) expanded.add(t.id)
      draw()
    } }, '⋯')
    const del = h('button', { className: 'del', title: 'delete track', onclick: () => {
      if (confirm('Delete this track and its clips?')) deleteTrack(doc, t.id)
    } }, '×')
    const head = h('div', { className: 'head' }, name, h('div', { className: 'ctl' }, mute, gain, more), readOnly ? null : del)
    const body = h('div', { className: 'lane-body', 'data-track': t.id })
    body.onpointerdown = (e) => {
      if (e.target === body) select([])
    }
    body.ondblclick = (e) => { // empty space on a MIDI lane: new 4-bar clip
      if (readOnly || e.target !== body || tracksMap(doc).get(t.id)?.get('kind') !== 'midi') return
      const id = addMidiClip(doc, { trackId: t.id, start: fromX(e.clientX - body.getBoundingClientRect().left) })
      editing = id
      select([id])
    }
    body.ondragover = (e) => e.preventDefault()
    body.ondrop = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (readOnly) return
      const midi = tracksMap(doc).get(t.id)?.get('kind') === 'midi'
      void dropFiles(audioFiles(e.dataTransfer?.files), midi ? null : t.id, fromX(e.clientX - body.getBoundingClientRect().left))
    }
    const fx = h('div', { className: 'fx' })
    const add = h('button', { className: 'add-fx', title: 'add effect', disabled: readOnly, onclick: () =>
      popover(add, EFFECTS.map((d) => [d.name, () => addDevice(doc, t.id, d.type)] as [string, () => void])) }, '+')
    fx.append(add)
    const row = h('div', { className: 'lane-row' }, head, body)
    l = { el: h('div', { className: 'lane' }, row, fx), row, body, name, mute, gain, more, fx, cards: new Map() }
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

  function drawFx(l: Lane, t: Track, devices: Device[]) {
    const open = expanded.has(t.id)
    l.fx.hidden = !open
    l.more.classList.toggle('on', open)
    if (!open) return
    const mine = devices.filter((d) => d.trackId === t.id)
    const ids = new Set(mine.map((d) => d.id))
    for (const [id, c] of l.cards) if (!ids.has(id)) { c.el.remove(); l.cards.delete(id) }
    mine.forEach((d, i) => {
      let c = l.cards.get(d.id)
      if (!c) l.cards.set(d.id, (c = deviceCard(d, cardDeps)))
      if (l.fx.children[i] !== c.el) l.fx.insertBefore(c.el, l.fx.children[i])
      c.update(d, remoteDrags.get(d.id) ?? NO_DRAGS)
    })
  }

  function draw() {
    if (destroyed) return
    const tracks = getTracks(doc)
    const clips = getClips(doc)
    const devices = getDevices(doc)
    const notes = getNotes(doc)
    const samples = getSamples(doc)
    const total = Math.max(60 * rate, ...clips.map((c) => c.start + clipLength(c, rate) + 30 * rate))
    content.style.width = `${HEADER + x(total)}px`
    rulerBody.style.width = `${x(total)}px`
    drawRuler(total / rate)

    // remote live-param drags -> overrides on our engine, and the values shown on sliders
    const remote = s.remoteStates()
    remoteDrags = new Map()
    for (const r of remote) {
      const d = r.dragging
      if (d) remoteDrags.set(d.deviceId, (remoteDrags.get(d.deviceId) ?? new Map()).set(d.paramId, d.value))
    }
    pb?.setOverrides(remote.flatMap((r) => (r.dragging ? [r.dragging] : [])))

    // lanes
    hint.hidden = tracks.length > 0
    const ids = new Set(tracks.map((t) => t.id))
    for (const [id, l] of lanes) if (!ids.has(id)) { l.el.remove(); lanes.delete(id) }
    tracks.forEach((t, i) => {
      const l = laneFor(t)
      if (laneBox.children[i] !== l.el) laneBox.insertBefore(l.el, laneBox.children[i] ?? null)
      l.body.style.width = `${x(total)}px`
      l.el.dataset.kind = t.kind
      if (l.name.textContent !== t.name) l.name.textContent = t.name
      l.mute.classList.toggle('on', t.muted)
      if (document.activeElement !== l.gain) l.gain.value = String(t.gain)
      drawFx(l, t, devices)
    })

    // clips
    selection = selection.filter((id) => clipsMap(doc).has(id))
    if (editing && clipsMap(doc).get(editing)?.get('kind') !== 'midi') editing = null
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
      e.style.width = `${Math.max(2, x(clipLength(c, rate)))}px`
      let canPlay = true
      if (c.kind === 'audio') {
        const meta = samples[c.sourceHash]
        canPlay = !!meta && playable(meta)
        const label = meta ? (canPlay ? meta.name : `${meta.name} · too long to play yet`) : '…'
        if (e.textContent !== label) e.textContent = label
      } else drawMidiClip(e, c, notes.filter((n) => n.clipId === c.id))
      e.classList.toggle('midi', c.kind === 'midi')
      e.classList.toggle('sel', selection.includes(c.id))
      e.classList.toggle('unplayable', !canPlay)
      const o = outline.get(c.id)
      e.style.outline = o ? `2px solid ${o}` : ''
    }

    // note editor, under the track that owns the open clip
    const open = editing ? clips.find((c) => c.id === editing) : undefined
    if (open?.kind === 'midi' && lanes.has(open.trackId)) {
      const l = lanes.get(open.trackId)!
      if (ne.el.parentElement !== l.el) l.el.append(ne.el)
      noteSel = notesMap(doc).has(noteSel ?? '') ? noteSel : null
      ne.update(open, notes.filter((n) => n.clipId === open.id), noteSel)
    } else ne.el.remove()

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

  /** Label plus tiny note marks, rebuilt only when the clip's notes change. */
  function drawMidiClip(e: HTMLElement, c: Clip & { kind: 'midi' }, notes: Note[]) {
    const sig = `${c.lengthTicks}|${notes.map((n) => `${n.tick},${n.durTicks},${n.pitch}`).join(';')}`
    if (e.dataset.sig === sig) return
    e.dataset.sig = sig
    const lo = Math.min(...notes.map((n) => n.pitch)), hi = Math.max(...notes.map((n) => n.pitch))
    e.replaceChildren('MIDI', ...notes.map((n) => {
      const m = h('i', { className: 'mark' })
      m.style.left = `${(n.tick / c.lengthTicks) * 100}%`
      m.style.width = `${Math.max(1, (n.durTicks / c.lengthTicks) * 100)}%`
      m.style.top = `${hi === lo ? 50 : 20 + ((hi - n.pitch) / (hi - lo)) * 60}%`
      return m
    }))
  }

  function drawRuler(totalSec: number) {
    const step = pps >= 40 ? 1 : pps >= 15 ? 5 : 10
    const n = Math.floor(totalSec / step)
    if (rulerBody.childElementCount === n + 1 && rulerBody.dataset.pps === String(pps)) return
    rulerBody.dataset.pps = String(pps)
    rulerBody.replaceChildren(...Array.from({ length: n + 1 }, (_, i) =>
      h('span', { className: 'tick', style: `left:${(i * step * pps)}px` }, fmt(i * step).replace(/\.0$/, ''))))
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
    noteSel = null
    if (clip.kind === 'midi') editing = id
    select([id])
    if (readOnly) return
    undo.stopCapturing()
    ev.preventDefault()
    const x0 = ev.clientX
    const srcFrames = clip.kind === 'audio' ? (getSamples(doc)[clip.sourceHash]?.duration ?? Infinity) * rate : Infinity
    let last: PointerEvent | null = null
    let pending = 0
    const apply = () => {
      pending = 0
      if (!last || !clipsMap(doc).has(id)) return
      const dSmp = Math.round(((last.clientX - x0) / pps) * rate)
      if (clip.kind === 'midi' && trim) {
        const step = clip.ppq / 4
        const dTicks = (dSmp * clip.bpm * clip.ppq) / (60 * rate)
        updateClip(doc, id, { lengthTicks: Math.max(step, Math.round((clip.lengthTicks + dTicks) / step) * step) })
      } else if (clip.kind === 'audio' && trim) {
        updateClip(doc, id, { length: Math.round(Math.min(Math.max(MIN_SEC * rate, clip.length + dSmp), srcFrames - clip.sourceOffset)) })
      } else {
        const lane = laneAt(last.clientY)
        const sameKind = lane && tracksMap(doc).get(lane)?.get('kind') === clip.kind
        updateClip(doc, id, { start: Math.max(0, clip.start + dSmp), ...(sameKind && lane !== clip.trackId ? { trackId: lane } : {}) })
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
      const r = l.row.getBoundingClientRect()
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
        const length = Math.round(m.duration * rate)
        doc.transact(() => {
          trackId ??= addTrack(doc, f.name.replace(/\.[^.]+$/, ''))
          addAudioClip(doc, { trackId, sourceHash: m.hash, start: at, length })
        })
        at += length
        status.textContent = ''
      } catch (err) {
        status.textContent = `${f.name}: ${(err as Error).message}`
      }
    }
  }

  // --- input
  ruler.onpointerdown = (e) => seek(fromX(e.clientX - rulerBody.getBoundingClientRect().left))
  scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    const r = rulerBody.getBoundingClientRect()
    const t = (e.clientX - r.left) / pps
    pps = Math.min(800, Math.max(10, pps * Math.exp(-e.deltaY * 0.01)))
    draw()
    scroll.scrollLeft += HEADER + t * pps - (e.clientX - scroll.getBoundingClientRect().left) - scroll.scrollLeft
  }, { passive: false })
  const key = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'SELECT' || (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range')) return
    const mod = e.metaKey || e.ctrlKey
    if (e.code === 'Space') { e.preventDefault(); toggle() }
    else if (readOnly) return
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? undo.redo() : undo.undo() }
    else if (!mod && e.key.toLowerCase() === 's') {
      const at = Math.round(position())
      doc.transact(() => selection.forEach((id) => splitClip(doc, id, at)))
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (noteSel) {
        deleteNote(doc, noteSel)
        noteSel = null
        draw()
      } else {
        doc.transact(() => selection.forEach((id) => deleteClip(doc, id)))
        select([])
      }
    }
  }
  addEventListener('keydown', key)

  // --- sync
  const watched = [tracksMap(doc), clipsMap(doc), notesMap(doc), devicesMap(doc), samplesMap(doc)]
  watched.forEach((m) => m.observeDeep(schedule))
  s.awareness.on('change', schedule)
  const onStatus = ({ status: st }: { status: string }) => (bar.dataset.status = st)
  s.provider.on('status', onStatus)
  s.provider.on('authenticationFailed', () => (status.textContent = 'no access'))
  // After the first sync: migrate old projects (editors only: a viewer's writes never reach the server),
  // then start the engine at the project's sample rate.
  void s.synced.then(() => {
    if (destroyed) return
    if (!readOnly) {
      migrateToV2(doc)
      sweepOrphans(doc)
    }
    rate = getSampleRate(doc)
    pb = openPlayback(doc, s.projectId, rate)
    draw()
  })
  draw()

  return {
    el,
    destroy() {
      destroyed = true
      cancelAnimationFrame(raf)
      removeEventListener('keydown', key)
      watched.forEach((m) => m.unobserveDeep(schedule))
      s.awareness.off('change', schedule)
      pb?.destroy()
    },
  }
}
