// Plain absolutely-positioned DOM timeline. Isolated so it can be redesigned.
// Positions in the doc are integer samples; the UI zoom is pixels per second.
import {
  DEFAULT_SAMPLE_RATE, DEVICES, EFFECTS, FINNWAVE, addAudioClip, addDevice, addMidiClip, addPad, addTrack, deletePad, clipLength, clipsMap, deleteClip,
  deleteDevice, deleteLooper, addNextLooper, deleteNote, deleteTrack, devicesMap, loopersMap, getClips, getDevices, getNotes, getSampleRate, getSamples,
  getLoopers, getPads, getTracks, padsMap, updatePad, migrateToV2, notesMap, samplesMap, setParam, splitClip, sweepOrphans, tracksMap, updateClip,
  updateDevice, updateLooper, updateNote, updateTrack, type AwarenessState, type Clip, type Device, type Looper, type Note, type Pad, type Track,
} from '@mobdaw/shared'
import { drawWave, onPeaks, peaksFor } from '../audio/peaks'
import type { PreviewMode } from '../audio/bridge'
import { openPlayback, type Playback } from '../audio/playback'
import { h } from '../dom'
import { importFile, playable } from '../samples'
import type { Session } from '../project/session'
import { chatPanel } from './chat'
import { deviceCard } from './devices'
import { LOOP_COLORS, looperCard } from './loopers'
import { noteEditor } from './noteEditor'
import { clamp, dragPointer, grabAt, trimBlock, trimMidiLeft, type Grab } from './blocks'
import { closedBy, deleteMenu, popover } from './popover'
import { fmt, transportControls, type TransportControls } from './transport'

const HEADER = 140
const MIN_SEC = 0.05
const LANE_H = 72
const NO_DRAGS = new Map<number, number>()

const accepts = (trackKind: string, clipKind: string) => trackKind === clipKind
const audioFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(f.name))
const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

type Card = ReturnType<typeof deviceCard>
type Lane = {
  el: HTMLElement; row: HTMLElement; body: HTMLElement; name: HTMLElement; mute: HTMLButtonElement
  gain: HTMLInputElement; more: HTMLButtonElement; fxRow: HTMLElement; fx: HTMLElement
  synthMore: HTMLButtonElement; synthRow: HTMLElement; synth: HTMLElement; cards: Map<string, Card>
  loopMore: HTMLButtonElement; loopRow: HTMLElement; loops: HTMLElement
  loopCards: Map<string, ReturnType<typeof looperCard>>; boxes: Map<string, HTMLElement>; heads: Map<string, HTMLElement>
  pads: Map<string, HTMLElement>
  loopTc: TransportControls // loops preview transport
  /** Soundscape tracks only: the source lane, which has its own time axis, scroll and zoom. */
  src: Src | null
}
type Src = {
  row: HTMLElement; view: HTMLElement; body: HTMLElement; ticks: HTMLElement; pps: number
  more: HTMLButtonElement // collapse toggle in the header cell
  tc: TransportControls // source preview transport
  playhead: HTMLElement // the preview's own playhead, in source time
  end: number // where the source audio ends (samples)
}

export function mountTimeline(s: Session, projectName: string, readOnly = false) {
  const { doc, undo } = s
  let rate = DEFAULT_SAMPLE_RATE
  let pb: Playback | null = null // created once the doc has synced (needs meta.sampleRate)
  let pps = 80
  let selection: string[] = []
  let editing: string | null = null // MIDI clip zoomed into its note editor
  let noteSel: string | null = null
  const expanded = new Set<string>() // local UI state: tracks showing their FX chain
  let armed: string | null = null // looper whose region is being drawn (local UI state)
  let padSel: string | null = null // selected pad
  const srcClosed = new Set<string>() // soundscapes with the source lane collapsed (open by default)
  const loopClosed = new Set<string>() // looper tracks with the loopers row collapsed (open by default)
  const synthClosed = new Set<string>() // MIDI tracks with the synth row collapsed (open by default)
  const lanes = new Map<string, Lane>()
  const clipEls = new Map<string, HTMLElement>()
  const waves = new Map<string, { cv: HTMLCanvasElement; label: HTMLElement; sig: string; pk?: Float32Array; v0: number; v1: number }>()
  let remoteDrags = new Map<string, Map<number, number>>()
  let raf = 0
  let destroyed = false

  // --- static structure
  const transport = transportControls({ title: 'play / pause (space)', onToggle: () => toggle() })
  const status = h('span', { className: 'dim' })
  const presence = h('span', { className: 'presence' })
  const chatBtn = h('button', { className: 'chat-btn', title: 'chat', onclick: () => {
    chat.setOpen(!chat.open)
    chatBtn.classList.toggle('on', chat.open)
    schedule() // the timeline's width changed
  } }, 'chat')
  const chat = chatPanel({
    doc, user: s.user, readOnly,
    onUnread: (n) => (chatBtn.textContent = n ? `chat (${n})` : 'chat'),
  })
  const bar = h('header', { className: 'bar' },
    h('div', { className: 'bar-l' }, h('a', { href: '#/projects', className: 'logo', title: 'All projects' }, 'mobdaw'), h('strong', {}, projectName),
      readOnly ? h('span', { className: 'dim' }, 'view only') : null),
    transport.el,
    h('div', { className: 'bar-r' }, status, presence, chatBtn))
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
  // Background menu "Upload": files go into the clicked track at the clicked position.
  let bgTarget: { trackId: string; at: number } | null = null
  const bgPicker = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true })
  bgPicker.onchange = () => {
    const files = audioFiles(bgPicker.files)
    bgPicker.value = ''
    if (bgTarget && files.length) void dropFiles(files, bgTarget.trackId, bgTarget.at)
  }
  const addLink = h('a', { className: 'add-track', href: '#', onclick: (e: Event) => {
    e.preventDefault()
    const n = getTracks(doc).length + 1
    popover(addLink, [
      ['Empty', () => addTrack(doc, `Track ${n}`)],
      ['Upload', () => fileInput.click()],
      ['Soundscape', () => addTrack(doc, `Soundscape ${n}`, 'soundscape')],
      ['MIDI', () => {
        doc.transact(() => addDevice(doc, addTrack(doc, `MIDI ${n}`, 'midi'), FINNWAVE))
      }],
    ])
  } }, '+ track')
  const overlay = h('div', { className: 'overlay' })
  const playhead = h('div', { className: 'playhead' })
  // The ruler is opaque and above the overlay, so it carries its own copies of the playhead lines.
  const rulerHead = h('div', { className: 'playhead' })
  const rulerHeads = h('div', { className: 'overlay' }, rulerHead)
  overlay.append(playhead)
  const hint = h('div', { className: 'hint dim' }, readOnly ? 'Nothing here yet.' : 'Drop audio files here, or use + track.')
  const content = h('div', { className: 'content' }, ruler, laneBox, hint, readOnly ? null : addLink, fileInput, bgPicker, overlay)
  const scroll = h('div', { className: 'scroll' }, content)
  // Drops outside any lane start a new track.
  scroll.ondragover = (e) => e.preventDefault()
  scroll.ondrop = (e) => {
    e.preventDefault()
    if (readOnly) return
    void dropFiles(audioFiles(e.dataTransfer?.files), null, fromX(e.clientX - rulerBody.getBoundingClientRect().left))
  }
  const el = h('div', { className: 'timeline' }, bar, h('div', { className: 'body' }, scroll, chat.el))

  const x = (smp: number) => (smp / rate) * pps
  const fromX = (px: number) => Math.max(0, Math.round((px / pps) * rate))
  const position = () => pb?.position() ?? 0

  const ne = noteEditor({
    doc, undo, readOnly,
    selectNote: (id) => ((noteSel = id), draw()),
  })

  // --- transport
  function toggle() {
    if (!pb) return
    if (pb.playing) stop()
    else {
      pb.play()
      transport.setPlaying(true)
      tick()
      ensurePreviewTick() // the loopers' playheads
    }
  }
  function stop() {
    pb?.stop()
    transport.setPlaying(false)
    s.setLocal({ playhead: null })
    draw()
    ensurePreviewTick() // let the loopers' playheads clear
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
    rulerHead.style.left = `${x(p)}px`
    transport.setTime(p / rate)
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
    const more = h('button', { className: 'fx-toggle', title: 'effects', onclick: () => {
      if (!expanded.delete(t.id)) expanded.add(t.id)
      draw()
    } }, 'fx')
    const delTrack = () => confirm('Delete this track and its clips?') && deleteTrack(doc, t.id)
    const del = h('button', { className: 'x', title: 'delete track', onclick: delTrack }, '×')
    const head = h('div', { className: 'head' }, name, h('div', { className: 'ctl' }, mute, gain), readOnly ? null : del)
    deleteMenu(head, 'Delete track', delTrack, () => !readOnly)
    const body = h('div', { className: 'lane-body', 'data-track': t.id })
    body.onpointerdown = (e) => {
      if (e.target !== body) return
      editing = null
      noteSel = null
      padSel = null
      select([])
    }
    const atX = (e: MouseEvent) => fromX(e.clientX - body.getBoundingClientRect().left)
    body.ondblclick = (e) => { // empty space on a MIDI lane: new 4-bar clip
      if (readOnly || e.target !== body || t.kind !== 'midi') return
      newMidiClip(t.id, atX(e))
    }
    body.ondragover = (e) => e.preventDefault()
    body.ondrop = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (readOnly) return
      const audio = tracksMap(doc).get(t.id)?.get('kind') === 'audio'
      void dropFiles(audioFiles(e.dataTransfer?.files), audio ? t.id : null, fromX(e.clientX - body.getBoundingClientRect().left))
    }
    // background menu: audio lanes take uploads; MIDI lanes and soundscapes make a new region
    if (t.kind === 'audio') bgMenu(body, (e) => [['Upload', () => pickInto(t.id, atX(e))]])
    else if (t.kind === 'midi') bgMenu(body, (e) => [['New region', () => newMidiClip(t.id, atX(e))]])
    else if (t.kind === 'soundscape') bgMenu(body, (e) => [['New region', () => newPad(t.id, atX(e))]])
    const fx = h('div', { className: 'fx', hidden: true })
    const add = h('button', { className: 'add-fx', title: 'add effect', disabled: readOnly, onclick: () =>
      popover(add, EFFECTS.map((d) => [d.name, () => addDevice(doc, t.id, d.type)] as [string, () => void])) }, '+')
    fx.append(add)
    const fxRow = h('div', { className: 'fx-row' }, more, fx) // opaque, so it covers the playhead
    // MIDI tracks: the instrument gets its own row above the FX bar
    const synthMore = h('button', { className: 'fx-toggle', title: 'instrument', onclick: () => {
      if (!synthClosed.delete(t.id)) synthClosed.add(t.id)
      draw()
    } }, 'synth')
    const synth = h('div', { className: 'fx' })
    const synthRow = h('div', { className: 'fx-row', hidden: true }, synthMore, synth)
    // soundscape tracks: the main lane is blank like an empty track (regions turn the loopers on); the source audio gets its own lane
    const src: Src | null = t.kind === 'soundscape' ? sourceLane(t.id) : null
    // the loopers row: speed and region per slot, above the FX bar
    const loopMore = h('button', { className: 'fx-toggle', title: 'loopers', onclick: () => {
      if (!loopClosed.delete(t.id)) {
        loopClosed.add(t.id)
        const pv = pb?.preview(t.id, 'loops') // the transport is about to be hidden: don't leave it playing
        if (pv?.playing) pv.stop()
      }
      draw()
    } }, 'loopers')
    const loops = h('div', { className: 'fx' })
    loops.append(h('button', { className: 'add-fx', title: 'add looper', disabled: readOnly, onclick: () => addNextLooper(doc, t.id) }, '+'))
    const loopTc = transportControls({ title: 'play / stop the loops', small: true, onToggle: () => togglePreview(t.id, 'loops') })
    const loopRow = h('div', { className: 'fx-row', hidden: true }, h('div', { className: 'fx-head' }, loopMore, loopTc.el), loops)
    const row = h('div', { className: 'lane-row' }, head, body)
    l = {
      el: h('div', { className: 'lane' }, row, src?.row ?? null, synthRow, loopRow, fxRow), row, body, name, mute, gain, more,
      fxRow, fx, synthMore, synthRow, synth, loopMore, loopRow, loops, loopCards: new Map(), boxes: new Map(), heads: new Map(), cards: new Map(),
      pads: new Map(), loopTc, src,
    }
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
    const fxOpen = expanded.has(t.id)
    const synthOpen = t.kind === 'midi' && !synthClosed.has(t.id)
    l.fx.hidden = !fxOpen
    l.more.classList.toggle('on', fxOpen)
    l.synthRow.hidden = t.kind !== 'midi'
    l.synth.hidden = !synthOpen
    l.synthMore.classList.toggle('on', synthOpen)
    if (!fxOpen && !synthOpen) return
    const mine = devices.filter((d) => d.trackId === t.id)
    const ids = new Set(mine.map((d) => d.id))
    for (const [id, c] of l.cards) if (!ids.has(id)) { c.el.remove(); l.cards.delete(id) }
    const place = (box: HTMLElement, list: Device[]) => list.forEach((d, i) => {
      let c = l.cards.get(d.id)
      if (!c) l.cards.set(d.id, (c = deviceCard(d, cardDeps)))
      if (box.children[i] !== c.el) box.insertBefore(c.el, box.children[i] ?? null)
      c.update(d, remoteDrags.get(d.id) ?? NO_DRAGS)
    })
    if (synthOpen) place(l.synth, mine.filter((d) => DEVICES[d.type]?.instrument))
    if (fxOpen) place(l.fx, mine.filter((d) => !DEVICES[d.type]?.instrument))
  }

  // --- soundscape previews: each soundscape's source and loops have a private transport/playhead
  function togglePreview(trackId: string, mode: PreviewMode) {
    const pv = pb?.preview(trackId, mode)
    if (!pv) return
    if (pv.playing) pv.stop()
    else {
      const end = lanes.get(trackId)?.src?.end ?? 0
      // loops always start from their beginning; the source resumes unless it already ran out
      pv.play(mode === 'loops' || pv.position() >= end ? 0 : undefined)
    }
    refreshPreviews()
    ensurePreviewTick()
  }

  /** One thin playhead per sounding looper, in source time over the source audio. */
  function drawLoopHeads(): boolean {
    let shown = false
    for (const [trackId, l] of lanes) {
      if (!l.src) continue
      const live = new Set<string>()
      for (const lp of getLoopers(doc)) {
        const pos = lp.trackId === trackId ? pb?.looperHead(lp.id) : null
        if (pos == null) continue
        shown = true
        live.add(lp.id)
        let e = l.heads.get(lp.id)
        if (!e) {
          e = h('div', { className: 'loop-head' })
          e.style.setProperty('--c', LOOP_COLORS[lp.slot % LOOP_COLORS.length])
          l.heads.set(lp.id, e)
          l.src.body.append(e)
        }
        e.style.left = `${(pos / rate) * l.src.pps}px`
      }
      for (const [id, e] of l.heads) if (!live.has(id)) { e.remove(); l.heads.delete(id) }
    }
    return shown
  }
  /** Sync transport buttons, times and playheads with the previews; true while any is playing. */
  function refreshPreviews(): boolean {
    if (!pb) return false
    let any = false
    for (const [id, l] of lanes) {
      if (!l.src) continue
      const src = pb.preview(id, 'source'), loops = pb.preview(id, 'loops')
      if (src.playing && src.position() > l.src.end) src.stop() // ran off the end of the audio
      const sp = src.position(), lp = loops.position()
      l.src.tc.setPlaying(src.playing)
      l.src.tc.setTime(sp / rate)
      l.src.playhead.hidden = !src.playing && sp === 0
      l.src.playhead.style.left = `${(sp / rate) * l.src.pps}px`
      l.loopTc.setPlaying(loops.playing)
      l.loopTc.setTime(lp / rate)
      any ||= src.playing || loops.playing
    }
    return drawLoopHeads() || any || pb.playing // (the heads keep drawing until the engine reports them gone)
  }
  let previewRaf = 0
  function ensurePreviewTick() {
    if (!previewRaf) previewRaf = requestAnimationFrame(previewTick)
  }
  function previewTick() {
    previewRaf = 0
    if (!destroyed && refreshPreviews()) ensurePreviewTick()
  }

  // --- soundscape: source lane (own time world) and pad stripes (timeline-anchored gates)
  const srcEnd = (trackId: string) =>
    Math.max(0, ...getClips(doc).filter((c) => c.trackId === trackId).map((c) => c.start + clipLength(c, rate)))

  /**
   * Left or right click on a lane's empty background opens a menu of `entries(event)` at the cursor.
   * (Upload for lanes that hold audio, "New region" for MIDI lanes and soundscapes.)
   */
  function bgMenu(body: HTMLElement, entries: (e: MouseEvent) => [string, () => void][]) {
    let down: { x: number; y: number; armed: boolean; closed: boolean } | null = null
    // (the popover's own capture listener runs first, so `closedBy` says whether this press closed a menu)
    body.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, armed: !!armed, closed: closedBy(e) }), true)
    const open = (e: MouseEvent) => {
      if (!readOnly && e.target === body) popover(body, entries(e), [e.clientX, e.clientY])
    }
    body.addEventListener('contextmenu', (e) => { e.preventDefault(); open(e) })
    body.addEventListener('click', (e) => { // not after a drag (e.g. drawing a region)
      if (down && (down.armed || down.closed || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4)) return
      open(e)
    })
  }

  /** Pick audio files and import them into `trackId` starting at sample `at` of that lane's time scale. */
  function pickInto(trackId: string, at: number) {
    bgTarget = { trackId, at }
    bgPicker.click()
  }

  function newMidiClip(trackId: string, at: number) {
    const id = addMidiClip(doc, { trackId, start: at })
    editing = id
    select([id])
  }

  /** A soundscape region: a block on the main lane during which all of the loopers are on. */
  function newPad(trackId: string, at: number) {
    padSel = addPad(doc, trackId, at, 2 * rate)
    select([])
  }

  function sourceLane(trackId: string): Src {
    const ticks = h('div', { className: 'src-ticks' })
    const body = h('div', { className: 'lane-body src-body', 'data-track': trackId }, ticks)
    const view = h('div', { className: 'src-view' }, body)
    const tc = transportControls({ title: 'play / pause the source audio', small: true, onToggle: () => togglePreview(trackId, 'source') })
    const more = h('button', { className: 'fx-toggle', title: 'source audio', onclick: () => {
      if (!srcClosed.delete(trackId)) {
        srcClosed.add(trackId)
        const pv = pb?.preview(trackId, 'source') // the transport is about to be hidden: don't leave it playing
        if (pv?.playing) pv.stop()
      }
      draw()
    } }, 'source')
    const head = h('div', { className: 'head src-head' }, more, tc.el)
    const playhead = h('div', { className: 'playhead', hidden: true })
    body.append(playhead)
    const src: Src = { row: h('div', { className: 'lane-row src-row' }, head, view), view, body, ticks, pps: 80, more, tc, playhead, end: 0 }
    // click or drag on the source ruler to move its playhead (the main transport is unaffected)
    ticks.onpointerdown = (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const seek = (cx: number) => {
        pb?.preview(trackId, 'source').seek(Math.max(0, Math.round(((cx - body.getBoundingClientRect().left) / src.pps) * rate)))
        refreshPreviews()
      }
      seek(e.clientX)
      const move = (m: PointerEvent) => seek(m.clientX)
      const up = () => {
        removeEventListener('pointermove', move)
        removeEventListener('pointerup', up)
        removeEventListener('pointercancel', up)
      }
      addEventListener('pointermove', move)
      addEventListener('pointerup', up)
      addEventListener('pointercancel', up)
    }
    body.onpointerdown = (e) => {
      if (e.target !== body) return
      padSel = null
      select([])
    }
    body.ondragover = (e) => e.preventDefault()
    body.ondrop = (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (readOnly) return
      const at = Math.max(0, Math.round(((e.clientX - body.getBoundingClientRect().left) / src.pps) * rate))
      void dropFiles(audioFiles(e.dataTransfer?.files), trackId, at)
    }
    bgMenu(body, (e) => [['Upload', () => pickInto(trackId, Math.max(0, Math.round(((e.clientX - body.getBoundingClientRect().left) / src.pps) * rate)))]])
    view.addEventListener('scroll', schedule, { passive: true })
    view.addEventListener('wheel', (e) => { // zoom this lane only
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      const t = (e.clientX - body.getBoundingClientRect().left) / src.pps
      src.pps = clamp(src.pps * Math.exp(-e.deltaY * 0.01), 10, 800)
      draw()
      view.scrollLeft += t * src.pps - (e.clientX - view.getBoundingClientRect().left) - view.scrollLeft
    }, { passive: false })
    // while a looper is armed, a drag here draws its region (capture: clips must not start a drag)
    body.addEventListener('pointerdown', (e) => {
      const lp = armed ? getLoopers(doc).find((x) => x.id === armed && x.trackId === trackId) : undefined
      if (!lp || readOnly || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      drawRegion(e, lp, src)
    }, true)
    return src
  }

  /** Move, or trim either edge of, a soundscape region (the same controls as an audio clip). */
  function padDown(ev: PointerEvent, id: string) {
    if (ev.button !== 0) return
    const pad = getPads(doc).find((p) => p.id === id)
    if (!pad) return
    const mode = grabAt(ev.clientX, (ev.currentTarget as HTMLElement).getBoundingClientRect())
    editing = null
    noteSel = null
    padSel = id
    select([])
    if (readOnly) return
    undo.stopCapturing()
    ev.preventDefault()
    dragPointer(ev, {
      onDrag: (m) => {
        if (!padsMap(doc).has(id)) return
        const dSmp = Math.round(((m.clientX - ev.clientX) / pps) * rate)
        if (mode === 'move') updatePad(doc, id, { start: Math.max(0, pad.start + dSmp) })
        else {
          const t = trimBlock(mode, pad, dSmp, { minLength: MIN_SEC * rate, slackLeft: pad.start })
          updatePad(doc, id, { start: t.start, length: t.length })
        }
      },
      onEnd: () => undo.stopCapturing(),
    })
  }

  function drawPads(l: Lane, t: Track, pads: Pad[]) {
    const mine = t.kind === 'soundscape' ? pads.filter((p) => p.trackId === t.id) : []
    const ids = new Set(mine.map((p) => p.id))
    for (const [id, e] of l.pads) if (!ids.has(id)) { e.remove(); l.pads.delete(id) }
    for (const p of mine) {
      let e = l.pads.get(p.id)
      if (!e) {
        e = h('div', { className: 'clip region' }, 'loopers on') // a clip-styled block: same edges, same hover
        e.onpointerdown = (ev) => padDown(ev, p.id)
        deleteMenu(e, 'Delete region', () => { deletePad(doc, p.id); if (padSel === p.id) padSel = null; draw() }, () => !readOnly)
        l.pads.set(p.id, e)
        l.body.append(e)
      }
      e.style.left = `${x(p.start)}px`
      e.style.width = `${Math.max(2, x(p.length))}px`
      e.classList.toggle('sel', p.id === padSel)
    }
    if (padSel && !padsMap(doc).has(padSel)) padSel = null
  }

  const loopDeps = {
    readOnly,
    grab: () => undo.stopCapturing(),
    commit: (id: string, speed: number) => updateLooper(doc, id, { speed }),
    setMuted: (id: string, muted: boolean) => updateLooper(doc, id, { muted }),
    setGain: (id: string, gain: number) => updateLooper(doc, id, { gain }),
    toggleArm: (id: string) => { armed = armed === id ? null : id; draw() },
    clear: (id: string) => updateLooper(doc, id, { start: 0, length: 0 }),
    remove: (id: string) => { if (armed === id) armed = null; deleteLooper(doc, id) },
  }

  /** Looper rows (cards) and the coloured region boxes drawn over the track's audio. */
  function drawLoopers(l: Lane, t: Track, loopers: Looper[]) {
    const isLoop = t.kind === 'soundscape' && !!l.src
    l.loopRow.hidden = !isLoop
    const open = isLoop && !loopClosed.has(t.id)
    l.loops.hidden = !open
    l.loopMore.classList.toggle('on', open)
    l.loopTc.el.hidden = !open
    const mine = isLoop ? loopers.filter((x) => x.trackId === t.id) : []
    l.src?.body.classList.toggle('arming', mine.some((x) => x.id === armed))
    // region boxes
    const ids = new Set(mine.filter((x) => x.length > 0).map((x) => x.id))
    for (const [id, b] of l.boxes) if (!ids.has(id)) { b.remove(); l.boxes.delete(id) }
    for (const lp of mine) {
      if (lp.length <= 0 || !l.src) continue
      let b = l.boxes.get(lp.id)
      if (!b) {
        b = h('div', { className: 'loop-box' }, h('span', {}, String(lp.slot + 1)))
        b.style.setProperty('--c', LOOP_COLORS[lp.slot % LOOP_COLORS.length])
        l.boxes.set(lp.id, b)
        l.src.body.append(b) // regions live in source time, over the source audio
      }
      b.style.left = `${(lp.start / rate) * l.src.pps}px`
      b.style.width = `${Math.max(2, (lp.length / rate) * l.src.pps)}px`
      b.classList.toggle('armed', lp.id === armed)
    }
    if (!open) return
    for (const [id, c] of l.loopCards) if (!mine.some((m) => m.id === id)) { c.el.remove(); l.loopCards.delete(id) }
    mine.forEach((lp, i) => {
      let c = l.loopCards.get(lp.id)
      if (!c) l.loopCards.set(lp.id, (c = looperCard(lp, loopDeps)))
      if (l.loops.children[i] !== c.el) l.loops.insertBefore(c.el, l.loops.children[i] ?? null)
      c.update(lp, lp.id === armed, rate)
    })
  }

  /** Drag across a lane to set a looper's region (live in the doc, one undo step). */
  function drawRegion(ev: PointerEvent, lp: Looper, src: Src) {
    const at = (cx: number) => Math.max(0, Math.round(((cx - src.body.getBoundingClientRect().left) / src.pps) * rate))
    let drew = false
    undo.stopCapturing()
    dragPointer(ev, {
      onDrag: (m) => {
        if (Math.abs(m.clientX - ev.clientX) < 4) return // a click doesn't erase the old region
        drew = true
        const a = at(ev.clientX), b = at(m.clientX)
        updateLooper(doc, lp.id, { start: Math.min(a, b), length: Math.abs(b - a) })
      },
      onEnd: () => {
        undo.stopCapturing()
        if (drew) armed = null
        draw()
      },
    })
  }

  function draw() {
    if (destroyed) return
    const tracks = getTracks(doc)
    const clips = getClips(doc)
    const devices = getDevices(doc)
    const loopers = getLoopers(doc)
    const pads = getPads(doc)
    const notes = getNotes(doc)
    const samples = getSamples(doc)
    // Source clips live in their own time world: they don't stretch the main timeline.
    const scapes = new Set(tracks.filter((t) => t.kind === 'soundscape').map((t) => t.id))
    const total = Math.max(60 * rate,
      ...clips.filter((c) => !scapes.has(c.trackId)).map((c) => c.start + clipLength(c, rate) + 30 * rate),
      ...pads.map((p) => p.start + p.length + 30 * rate))
    scroll.style.setProperty('--view', `${scroll.clientWidth}px`)
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

    if (editing && clipsMap(doc).get(editing)?.get('kind') !== 'midi') editing = null
    const editTrack = editing ? clips.find((c) => c.id === editing)?.trackId : undefined

    // lanes
    hint.hidden = tracks.length > 0
    const ids = new Set(tracks.map((t) => t.id))
    for (const [id, l] of lanes) if (!ids.has(id)) { l.el.remove(); lanes.delete(id) }
    tracks.forEach((t, i) => {
      const l = laneFor(t)
      if (laneBox.children[i] !== l.el) laneBox.insertBefore(l.el, laneBox.children[i] ?? null)
      l.body.style.width = `${x(total)}px`
      l.el.dataset.kind = t.kind
      l.el.classList.toggle('editing', t.id === editTrack)
      if (l.name.textContent !== t.name) l.name.textContent = t.name
      l.mute.classList.toggle('on', t.muted)
      if (document.activeElement !== l.gain) l.gain.value = String(t.gain)
      drawFx(l, t, devices)
      drawLoopers(l, t, loopers)
      drawPads(l, t, pads)
      if (l.src) {
        const srcOpen = !srcClosed.has(t.id)
        l.src.row.classList.toggle('collapsed', !srcOpen) // collapsed: just the clip names
        l.src.more.classList.toggle('on', srcOpen)
        l.src.tc.el.hidden = !srcOpen
        l.src.end = srcEnd(t.id)
        const end = Math.max(60 * rate, l.src.end + 30 * rate)
        l.src.body.style.width = `${(end / rate) * l.src.pps}px`
        drawTicks(l.src.ticks, end / rate, l.src.pps)
      }
    })

    // clips
    selection = selection.filter((id) => clipsMap(doc).has(id))
    const outline = new Map<string, string>()
    for (const r of remote) for (const id of r.selection ?? []) outline.set(id, r.user.color)
    const cids = new Set(clips.map((c) => c.id))
    for (const [id, e] of clipEls) if (!cids.has(id)) { e.remove(); clipEls.delete(id); waves.delete(id) }
    for (const c of clips) {
      const lane = lanes.get(c.trackId)
      if (!lane) continue
      let e = clipEls.get(c.id)
      if (!e) {
        e = h('div', { className: 'clip' })
        if (c.kind === 'audio') {
          const w = { cv: h('canvas', { className: 'wave' }), label: h('span', { className: 'label' }), sig: '', v0: 0, v1: 0 }
          waves.set(c.id, w)
          e.append(w.cv, w.label)
        }
        e.onpointerdown = (ev) => clipDown(ev, c.id)
        deleteMenu(e, 'Delete clip', () => { // the whole selection if this clip is in it
          const ids = selection.includes(c.id) ? [...selection] : [c.id]
          doc.transact(() => ids.forEach((id) => deleteClip(doc, id)))
          select([])
        }, () => !readOnly)
        clipEls.set(c.id, e)
      }
      const host = lane.src ? lane.src.body : lane.body // source clips are drawn in the source lane's own scale
      const cpps = lane.src ? lane.src.pps : pps
      if (e.parentElement !== host) host.append(e)
      e.style.left = `${(c.start / rate) * cpps}px`
      const width = Math.max(2, (clipLength(c, rate) / rate) * cpps)
      e.style.width = `${width}px`
      let canPlay = true
      if (c.kind === 'audio') {
        const meta = samples[c.sourceHash]
        canPlay = !!meta && playable(meta)
        const label = meta ? (canPlay ? meta.name : `${meta.name} · too long to play yet`) : '…'
        const w = waves.get(c.id)!
        if (w.label.textContent !== label) w.label.textContent = label
        const pk = pb && canPlay ? peaksFor(s.projectId, c.sourceHash, rate) : undefined
        if (pk) drawVisibleWave(c, w, pk, width, lane.src ? { pps: cpps, scroller: lane.src.view, off: 0 } : { pps, scroller: scroll, off: HEADER })
        else w.cv.style.display = 'none'
      } else drawMidiClip(e, c, notes.filter((n) => n.clipId === c.id), c.id === editing)
      e.classList.toggle('midi', c.kind === 'midi')
      e.classList.toggle('editing', c.kind === 'midi' && c.id === editing)
      e.classList.toggle('sel', selection.includes(c.id))
      e.classList.toggle('unplayable', !canPlay)
      const o = outline.get(c.id)
      e.style.outline = o ? `2px solid ${o}` : ''
    }

    // presence
    presence.replaceChildren(...[s.user, ...remote.map((r) => r.user)].map((u) =>
      h('span', { className: 'dot', title: u.name, style: `background:${u.color}` }, initials(u.name))))
    for (const e of [...overlay.querySelectorAll('.remote-head'), ...rulerHeads.querySelectorAll('.remote-head')]) e.remove()
    for (const r of remote) {
      if (r.playhead == null) continue
      const color = `background:${r.user.color}`
      overlay.append(h('div', { className: 'remote-head', style: `left:${HEADER + x(r.playhead)}px;${color}` }))
      rulerHeads.append(h('div', { className: 'remote-head', style: `left:${x(r.playhead)}px;${color}` }))
    }
    drawPlayhead()
    if (refreshPreviews()) ensurePreviewTick()
  }

  /**
   * Waveforms are drawn for the on-screen part of the clip only (plus a viewport of margin each side),
   * at device-pixel resolution, so a 16-minute clip costs the same as a 10-second one.
   */
  function drawVisibleWave(
    c: Clip & { kind: 'audio' }, w: { cv: HTMLCanvasElement; sig: string; pk?: Float32Array; v0: number; v1: number },
    pk: Float32Array, width: number,
    /** The lane's frame: its scale, its horizontal scroller, and how much of the scroller's left edge is covered. */
    f: { pps: number; scroller: HTMLElement; off: number },
  ) {
    const dpr = window.devicePixelRatio || 1
    const viewW = f.scroller.clientWidth || innerWidth
    const left = f.off + (c.start / rate) * f.pps // clip's left edge in scroller-content px
    const need0 = Math.max(0, f.scroller.scrollLeft + f.off - left), need1 = Math.min(width, f.scroller.scrollLeft + viewW - left)
    if (need1 <= need0) { w.cv.style.display = 'none'; return }
    const sig = `${f.pps}|${c.sourceOffset}|${c.length}|${dpr}`
    if (w.sig === sig && w.pk === pk && w.v0 <= need0 && w.v1 >= need1) { w.cv.style.display = ''; return }
    const v0 = Math.max(0, Math.floor(need0 - viewW)), v1 = Math.min(width, Math.ceil(need1 + viewW))
    Object.assign(w, { sig, pk, v0, v1 })
    w.cv.style.display = ''
    w.cv.style.left = `${v0}px`
    w.cv.style.width = `${v1 - v0}px`
    w.cv.width = Math.max(1, Math.round((v1 - v0) * dpr))
    w.cv.height = Math.round(LANE_H * dpr)
    const fpp = rate / f.pps // source frames per css px
    drawWave(w.cv, pk, c.sourceOffset + v0 * fpp, (v1 - v0) * fpp)
  }

  /** Preview (label plus tiny note marks, rebuilt only when the notes change), or the note editor when zoomed in. */
  function drawMidiClip(e: HTMLElement, c: Clip & { kind: 'midi' }, notes: Note[], open: boolean) {
    if (open) {
      if (ne.el.parentElement !== e) { e.replaceChildren(ne.el); delete e.dataset.sig }
      noteSel = notesMap(doc).has(noteSel ?? '') ? noteSel : null
      ne.update(c, notes, noteSel, pps)
      return
    }
    if (ne.el.parentElement === e) { ne.el.remove(); ne.reset() }
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

  /** Second ticks with labels into `box` (rebuilt only when the extent or scale changes). */
  function drawTicks(box: HTMLElement, totalSec: number, p: number, keep: Node[] = []) {
    const step = p >= 40 ? 1 : p >= 15 ? 5 : 10
    const n = Math.floor(totalSec / step)
    const key = `${n}|${p}`
    if (box.dataset.ticks === key) return
    box.dataset.ticks = key
    box.replaceChildren(...Array.from({ length: n + 1 }, (_, i) =>
      h('span', { className: 'tick', style: `left:${i * step * p}px` }, fmt(i * step).replace(/\.0$/, ''))), ...keep)
  }
  const drawRuler = (totalSec: number) => drawTicks(rulerBody, totalSec, pps, [rulerHeads])

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
    const box = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    const mode = grabAt(ev.clientX, box)
    noteSel = null
    padSel = null
    const lane0 = lanes.get(clip.trackId)
    const cpps = lane0?.src ? lane0.src.pps : pps // source clips scale with their own lane
    // a click (no drag) on a MIDI clip zooms into its editor; on the open clip's header strip it zooms back out
    const zoom = () => {
      if (clip.kind !== 'midi' || mode !== 'move') return
      editing = editing === id ? null : id
      draw()
    }
    select([id])
    if (readOnly) return zoom()
    undo.stopCapturing()
    ev.preventDefault()
    const grab = ev.clientX - box.left // where in the clip it was picked up
    let curTrack = clip.trackId
    const srcFrames = clip.kind === 'audio' ? (getSamples(doc)[clip.sourceHash]?.duration ?? Infinity) * rate : Infinity
    const notes0 = clip.kind === 'midi' ? getNotes(doc).filter((n) => n.clipId === id) : []
    dragPointer(ev, {
      onDrag: (m) => {
        if (!clipsMap(doc).has(id)) return
        if (mode !== 'move') return trimClip(clip, mode, Math.round(((m.clientX - ev.clientX) / cpps) * rate), srcFrames, notes0)
        // Absolute position under the pointer, in the target lane's own scale (source lanes differ).
        const hit = targetAt(m.clientY, clip.kind)
        if (hit) curTrack = hit
        const host = hostOf(curTrack)
        const start = Math.max(0, Math.round(((m.clientX - grab - host.el.getBoundingClientRect().left) / host.pps) * rate))
        updateClip(doc, id, { start, ...(curTrack !== clip.trackId ? { trackId: curTrack } : {}) })
      },
      onEnd: (moved) => {
        undo.stopCapturing()
        if (!moved) zoom()
      },
    })
  }

  /**
   * Resize a clip from either edge, non-destructively (the source audio and the notes stay whole;
   * dragging the edge back out restores them). `dSmp` is the pointer delta since the grab.
   */
  function trimClip(clip: Clip, mode: Exclude<Grab, 'move'>, dSmp: number, srcFrames: number, notes0: Note[]) {
    const minLength = MIN_SEC * rate
    if (clip.kind === 'audio') {
      const t = trimBlock(mode, clip, dSmp, { minLength, slackLeft: Math.min(clip.sourceOffset, clip.start), maxLength: srcFrames - clip.sourceOffset })
      updateClip(doc, clip.id, mode === 'l' ? { start: t.start, length: t.length, sourceOffset: clip.sourceOffset + t.d } : { length: t.length })
      return
    }
    // MIDI: lengths are in ticks, snapped to 1/16 notes
    const k = (clip.bpm * clip.ppq) / (60 * rate) // ticks per sample
    const step = clip.ppq / 4
    const dTicks = dSmp * k
    if (mode === 'r') {
      updateClip(doc, clip.id, { lengthTicks: Math.max(step, Math.round((clip.lengthTicks + dTicks) / step) * step) })
      return
    }
    // Left edge: the start moves and every note moves back by the same ticks, so the music stays put on the
    // timeline. Notes pushed before the new start go silent but are kept, and return if the edge is dragged out.
    const t = trimMidiLeft(clip, dSmp, rate)
    doc.transact(() => {
      updateClip(doc, clip.id, { start: t.start, lengthTicks: t.lengthTicks })
      for (const n of notes0) updateNote(doc, n.id, { tick: n.tick - t.d })
    })
  }

  /**
   * The track a dragged clip would land on: audio clips go to audio lanes or to any soundscape's source
   * lane; MIDI clips to MIDI lanes. Null when the pointer isn't over a valid lane.
   */
  function targetAt(clientY: number, clipKind: string): string | null {
    const within = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      return clientY >= r.top && clientY < r.bottom
    }
    for (const [id, l] of lanes) {
      if (clipKind === 'audio' && l.src && within(l.src.row)) return id
      if (within(l.row) && accepts(String(tracksMap(doc).get(id)?.get('kind')), clipKind)) return id
    }
    return null
  }
  const hostOf = (trackId: string) => {
    const l = lanes.get(trackId)
    return l?.src ? { el: l.src.body, pps: l.src.pps } : { el: l?.body ?? content, pps }
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
  scroll.addEventListener('scroll', schedule, { passive: true })
  addEventListener('resize', schedule)
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
    else if (e.key === 'Escape' && (editing || armed || padSel)) { editing = null; noteSel = null; armed = null; padSel = null; draw() }
    else if (readOnly) return
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? undo.redo() : undo.undo() }
    else if (!mod && e.key.toLowerCase() === 's') {
      const at = Math.round(position())
      // (source clips have their own time axis: the playhead means nothing there)
      doc.transact(() => selection.filter((id) => !lanes.get(String(clipsMap(doc).get(id)?.get('trackId')))?.src).forEach((id) => splitClip(doc, id, at)))
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      if (noteSel) {
        deleteNote(doc, noteSel)
        noteSel = null
        draw()
      } else if (padSel) {
        deletePad(doc, padSel)
        padSel = null
        draw()
      } else {
        doc.transact(() => selection.forEach((id) => deleteClip(doc, id)))
        select([])
      }
    }
  }
  addEventListener('keydown', key)

  // --- sync
  const watched = [tracksMap(doc), clipsMap(doc), notesMap(doc), devicesMap(doc), loopersMap(doc), padsMap(doc), samplesMap(doc)]
  watched.forEach((m) => m.observeDeep(schedule))
  s.awareness.on('change', schedule)
  const offPeaks = onPeaks(schedule)
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
    chat.markSeen()
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
      cancelAnimationFrame(previewRaf)
      removeEventListener('keydown', key)
      removeEventListener('resize', schedule)
      watched.forEach((m) => m.unobserveDeep(schedule))
      s.awareness.off('change', schedule)
      offPeaks()
      chat.destroy()
      pb?.destroy()
    },
  }
}
