// Plain absolutely-positioned DOM timeline. Isolated so it can be redesigned.
// Positions in the doc are integer samples; the UI zoom is pixels per second.
import { MAX_PPS, MIN_PPS, fitPps } from './zoomFit'
import { editZoomPps } from './autoZoom'
import {
  DEFAULT_PPQ, DEFAULT_SAMPLE_RATE, DEVICES, EFFECTS, INSTRUMENTS, LOFI_DRUM, MASTER_TRACK, MIX, MIX_GAIN, MIX_PAN, getMixDevice, setMixParam, migrateToV3, FINNWAVE, SIMPLE_FILTER, addAudioClip, addClickTrack, addDevice, addDrum, isLooping, addLane, addMidiClip, addPad, addPoint, addTrack, orderBetween, deleteLane, deletePad, clipLength, clipsMap, deleteClip,
  evalPoints, getLanes, getPoints, lanesMap, laneOf, laneState, paramToPos, paramToValue, pointsMap, resolveTarget, setLaneEnabled, setLaneState,
  deleteDevice, deleteLooper, addNextLooper, isDrum, isForever, passLength, deleteNote, deleteTrack, devicesMap, loopersMap, getClips, getDevices, getNotes, getSampleRate, getSamples, metaMap,
  getLoopers, getPads, getTracks, padsMap, updatePad, migrateToV2, notesMap, samplesMap, setParam, splitClip, stashLaneRanges, sweepOrphans, tracksMap, updateClip,
  updateDevice, updateLooper, updateNote, updateTrack, type AwarenessState, type Clip, type Device, type Lane as AutoLane, type Looper, type Note, type Pad, type ParamTarget,
  type Point, type SampleMeta, type Track,
  type Role, nextTrackColor, trackColor, foreverSamples,
} from '@mobdaw/shared'
import { homeLink } from '../router'
import { drawWave, onPeaks, peaksFor, storedPeaks } from '../audio/peaks'
import { shape } from '../audio/probe'
import { getInputOffset, setInputOffset, type Captured } from '../audio/recording'
import { LoopPedal, commitLoop, joinUndo, loopOffset, type Cmd, type LoopIO, type LoopTake } from '../audio/loopPedal'
import { actionFor, cmdForKey, getBindings, getKeys, getMidiInput, midiSupported, onPress, openMidi } from '../midi'
import type { Meters, PreviewMode } from '../audio/bridge'
import { openPlayback, type Playback } from '../audio/playback'
import { renderProject } from '../audio/render'
import { exportDialog } from './exportDialog'
import { projectMenu } from './projectMenu'
import { h } from '../dom'
import { importFile, playable, PLAYBACK_MAX_BYTES } from '../samples'
import { discardTake, finishTake, hasStaged, isMine, myTakes, recoverTakes, sweepUnusedTakes, takeJournal, uploadAll, uploadTake, type TakeCtx } from '../takes'
import type { Session } from '../project/session'
import { chatPanel } from './chat'
import { NO_AUTO, autoRow, automateMenu, type AutoInfo } from './automation'
import { deviceCard } from './devices'
import { applyPreset, presetsFor } from '../content/presets'
import type { FilterChange, FilterMember } from './filterCurve'
import { LOOP_COLORS, looperCard } from './loopers'
import { drumGrid } from './drumGrid'
import { noteEditor } from './noteEditor'
import { clamp, dragPointer, grabAt, passBoundaries, rotatePhase, rotateTick, snapTracker, trimBlock, trimMidiLeft, type Grab } from './blocks'
import { closedBy, deleteMenu, popover } from './popover'
import { fmt, transportControls, type TransportControls } from './transport'
import { fmtDb, gainToPos, posToGain, ticks, UNITY_POS } from './slider'
import { inUse } from './held'
import { valueTip } from './valueTip'
import { trackKind } from './trackKind'
import { knob } from './knob'
import { follow, peakToFill } from './meter'
import { icon, setIcon } from '../theme/icons'

const HEADER = 146 // the track header (140) plus the gutter to its left; keep in step with --head / --gutter in styles.css
const SNAP_PX = 8 // a dragged clip snaps to an edge within this many px...
const REARM_PX = 24 // ...and, once pulled free, only snaps to it again after moving this far away
const MIN_SEC = 0.05
const LANE_H = 72
const NO_DRAGS = new Map<number, number>()

const accepts = (trackKind: string, clipKind: string) => trackKind === clipKind
const audioFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(f.name))
const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

type Card = ReturnType<typeof deviceCard>
/** A header's volume fader and pan knob (both on the scope's mix device), with the row that holds them. */
type MixCtl = { gain: HTMLInputElement; pan: ReturnType<typeof knob>; row: HTMLElement }
/** A scope's automation: one collapsible section holding a lane per automated param (absent when there are none). */
type AutoSec = { el: HTMLElement; toggle: HTMLElement; box: HTMLElement; rows: Map<string, ReturnType<typeof autoRow>> }
type Lane = {
  el: HTMLElement; row: HTMLElement; body: HTMLElement; name: HTMLElement; kind: HTMLElement; mute: HTMLButtonElement; solo: HTMLButtonElement
  record: HTMLButtonElement | null; listen: HTMLButtonElement | null; meter: HTMLElement | null; mix: MixCtl; tabs: Map<TabName, HTMLButtonElement>; more: HTMLElement; fxRow: HTMLElement; fx: HTMLElement
  synthMore: HTMLElement; synthRow: HTMLElement; synth: HTMLElement; cards: Map<string, Card>
  loopMore: HTMLElement; loopRow: HTMLElement; loops: HTMLElement
  loopCards: Map<string, ReturnType<typeof looperCard>>; boxes: Map<string, HTMLElement>; heads: Map<string, HTMLElement>
  pads: Map<string, HTMLElement>
  auto: AutoSec
  presets: { el: HTMLElement; toggle: HTMLElement; grid: HTMLElement }
  loopTc: TransportControls // loops preview transport
  /** Soundscape tracks only: the source lane, which has its own time axis, scroll and zoom. */
  src: Src | null
}
/** The drawers a track's header tabs open; each is one of the `...Shown` sets below (global fx lives in `expanded` under MASTER_TRACK). */
type TabName = 'source' | 'synth' | 'loopers' | 'fx' | 'auto' | 'presets'
const TAB_LABEL: Record<TabName, string> = { source: 'src', synth: 'synth', loopers: 'loops', fx: 'fx', auto: 'auto', presets: 'presets' }
const TAB_TITLE: Record<TabName, string> = { source: 'source audio', synth: 'instruments', loopers: 'loopers', fx: 'effects', auto: 'automation lanes', presets: 'presets' }
const TABS: Record<string, TabName[]> = {
  audio: ['fx', 'auto', 'presets'], midi: ['synth', 'fx', 'auto', 'presets'], soundscape: ['source', 'loopers', 'fx', 'auto', 'presets'], master: ['fx', 'auto'],
}
type Src = {
  row: HTMLElement; view: HTMLElement; body: HTMLElement; ticks: HTMLElement; pps: number
  more: HTMLElement // the drawer's label in the header cell
  tc: TransportControls // source preview transport
  playhead: HTMLElement // the preview's own playhead, in source time
  end: number // where the source audio ends (samples)
}

/** The project's name in the bar opens its settings; `renameProject`, when given, lets them change the name (it saves it). `cloud` is set for server projects. */
export function mountTimeline(s: Session, projectName: string, readOnly = false, renameProject?: (name: string) => Promise<unknown> | void,
  cloud?: { projectId: string; me: string; role: Role; owner: boolean; locked: boolean; public: boolean; admin: boolean; demo: boolean }) {
  const { doc, undo } = s
  let rate = DEFAULT_SAMPLE_RATE
  let pb: Playback | null = null // created once the doc has synced (needs meta.sampleRate)
  let pps = 80
  let selection: string[] = []
  let editing: string | null = null // MIDI clip zoomed into its note editor
  let noteSel: string | null = null
  const expanded = new Set<string>() // local UI state: tracks showing their FX chain
  let armedTrack: string | null = null // audio track armed for recording (local UI state, never in the doc)
  let monitoring = false // hear the armed track's input through its effects (local UI state)
  let monitored: string | null = null // the track the engine is currently monitoring
  let take: { trackId: string; trackName: string; start: number; journal: ReturnType<typeof takeJournal> } | null = null // the take being recorded
  let locks = new Map<string, string>() // track id -> who is recording on it (someone else)
  let loops: LoopPedal | null = null // the loop commands (keys and MIDI are always listened for; docs/engine.md §9.2)
  let offMidi = () => {} // stops listening to the MIDI input
  let loopLive: { source: number; clip?: number } | null = null // the live source (and engine-only clip) of the loop being recorded
  let loopTimer = 0 // while a loop records: ends its take when it has what it needs
  let closingTake: Promise<unknown> = Promise.resolve() // a loop take being stopped by the recorder
  let loopArming = false // asking for the microphone
  const staged = new Map<string, boolean>() // incoming take hash -> whether this device still has its audio
  const recRegions = new Map<string, HTMLElement>()
  let armed: string | null = null // looper whose region is being drawn (local UI state)
  let padSel: string | null = null // selected pad
  const srcShown = new Set<string>() // soundscapes with the source lane expanded (collapsed by default)
  const loopShown = new Set<string>() // looper tracks with the loopers row expanded (collapsed by default)
  const synthShown = new Set<string>() // MIDI tracks with the synth row expanded (collapsed by default)
  const autoShown = new Set<string>() // scopes (track ids, or MASTER_TRACK) with the automation section expanded (collapsed by default)
  const presetsShown = new Set<string>() // tracks with the presets drawer expanded
  let autoLanes: AutoLane[] = [] // as of the last draw
  let autoPoints = new Map<string, Point[]>() // lane id -> its points, sorted
  let autoInfos = new Map<string, Map<string, AutoInfo>>() // owner id -> param -> what drives it
  const lanes = new Map<string, Lane>()
  const clipEls = new Map<string, HTMLElement>()
  const waves = new Map<string, { cv: HTMLCanvasElement; seams: HTMLElement; first: HTMLElement; label: HTMLElement; sig: string; pk?: Float32Array; v0: number; v1: number }>()
  let remoteDrags = new Map<string, Map<number, number>>()
  /** A card is being dragged by its title bar: merged filter views split until it lands. */
  let reordering = false
  let raf = 0
  let destroyed = false

  // --- static structure
  const transport = transportControls({
    title: 'play / pause (space)', onToggle: () => toggle(), onRewind: () => { seek(0); scroll.scrollLeft = 0 },
    record: readOnly ? undefined : { onToggle: () => void toggleRecord(), onMenu: (e) => offsetMenu(e) },
  })
  const status = h('span', { className: 'dim status', onclick: () => status.textContent && alert(status.textContent) })
  /** Show a line in the bar; `bad` marks a problem (red) rather than a note. */
  const say = (text: string, bad = false) => ((status.textContent = text), (status.className = bad ? 'error' : 'dim'))
  const cpu = h('span', { className: 'cpu', title: 'audio engine load: share of the real-time budget used by DSP (peak call in the last half second)' })
  const showCpu = (m: { load: number; peak: number }) => {
    const pct = Math.round(m.load * 100)
    cpu.textContent = `cpu ${pct}%`
    cpu.classList.toggle('hot', m.peak >= 0.8)
  }
  const loopText = h('span', { className: 'pedal-st rec', title: 'recording a loop: the time to the next boundary of the cycle (a loop starts and ends on it); the first loop runs press to press' })
  loopText.hidden = true
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
  /** The project's name in the bar: a button that opens the project settings (rename, sharing, audio input). */
  function projectTitle() {
    const el = h('button', { className: 'project-name', title: 'project settings', onpointerdown: (e) => e.stopPropagation(), onclick: () => {
      projectMenu(el, {
        name: projectName,
        rename: renameProject,
        onRenamed: (n) => (el.textContent = projectName = n),
        cloud: cloud && { ...cloud, onPublic: (v) => (cloud.public = v), onDemo: (v) => (cloud.demo = v) },
        sampleRate: {
          value: rate,
          locked: readOnly ? 'readonly' : isBlank() ? null : 'tracks',
          set: (r) => isBlank() && metaMap(doc).set('sampleRate', r),
        },
        onInputChanged: () => void reopenInput(),
        onLoopBindings: readOnly ? undefined : listenMidi, // (the keys are read at each press; the input may have changed)
      })
    } }, projectName)
    return el
  }
  /** Nothing is placed on a timeline yet (positions are in samples, so only then can the rate change). */
  const isBlank = () => !getTracks(doc).length && !getPoints(doc).length && !getLoopers(doc).length
  /**
   * The project's sample rate changed (here or on another machine; only possible while there are no tracks): the
   * engine and the microphone run at the project's rate, so playback is opened again.
   */
  function rateChanged() {
    const next = getSampleRate(doc)
    if (!pb || next === rate) return
    resetLoops()
    pb.destroy()
    rate = next
    armedTrack = null
    try {
      pb = openPlayback(doc, s.projectId, rate, s.userId)
      pb.recorder.onlevel = drawLevel
      pb.oncpu = showCpu
      pb.onmeters = onMeters
    } catch (err) {
      pb = null
      say(`sample rate: ${(err as Error).message}`, true)
    }
    draw()
  }
  /** The microphone choice changed: if one is open, reconnect it to the chosen device (unless a take is running). */
  async function reopenInput() {
    if (!pb?.recorder.armed) return
    if (take) {
      say('the new microphone is used from the next take')
      return
    }
    pb.recorder.disarm()
    try {
      await pb.recorder.arm()
      say('')
    } catch (err) {
      armedTrack = null
      say(`record: ${(err as Error).message}`, true)
    }
    draw()
  }
  const exportBtn = h('button', { className: 'bar-btn', title: 'render the whole project to a file', onclick: () => {
    if (!pb) return // (the project has not synced yet)
    exportDialog({ name: projectName, render: (o) => renderProject(doc, s.projectId, rate, s.userId, o) })
  } }, 'export')
  // The metronome is an ordinary MIDI track (role 'click'): the button makes it, and then mutes / unmutes it.
  const clickBtn = h('button', { className: 'metro', disabled: readOnly, title: 'metronome: add a click track, then mute / unmute it', onclick: () => {
    const t = getTracks(doc).find((x) => x.role === 'click')
    if (t && !t.muted) { // switching it off tucks it away: every expandable lane and the editor shut
      for (const set of [expanded, synthShown, loopShown, srcShown, autoShown, presetsShown]) set.delete(t.id)
      if (editing && clipsMap(doc).get(editing)?.get('trackId') === t.id) editing = null
    }
    if (t) updateTrack(doc, t.id, { muted: !t.muted })
    else addClickTrack(doc)
  } })
  transport.el.append(clickBtn) // sits right of the time readout
  const glass = (sign: string) => `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8.5" cy="8.5" r="5.5"/><path d="M12.6 12.6 18 18M6 8.5h5${sign}"/></svg>`
  const zoomOut = h('button', { className: 'bar-btn zoom', title: 'zoom out (ctrl + scroll)', onclick: () => zoomButton(1 / 1.5) })
  zoomOut.innerHTML = glass('')
  const zoomIn = h('button', { className: 'bar-btn zoom', title: 'zoom in (ctrl + scroll)', onclick: () => zoomButton(1.5) })
  zoomIn.innerHTML = glass('M8.5 6v5')
  // Where the project lives: a phone for this device's browser storage, a cloud for the server.
  const where = h('span', { className: 'dim where', onpointerdown: (e) => e.stopPropagation(), title: s.local ? 'saved in this browser, on this device' : 'saved in the cloud' })
  where.innerHTML = s.local
    ? '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="1.5" width="9" height="17" rx="2"/><path d="M9 15.5h2"/></svg>'
    : '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 15.5a3.5 3.5 0 0 1-.4-6.98 5 5 0 0 1 9.7-.5A4 4 0 0 1 14.5 15.5z"/></svg>'
  const bar = h('header', { className: 'bar' },
    h('div', { className: 'bar-l' }, h('a', { ...homeLink, className: 'logo', title: 'all projects' }, 'mobdaw'),
      readOnly ? h('span', { className: 'dim' }, 'view only') : null),
    transport.el,
    h('div', { className: 'bar-r' }, loopText, cpu, status, presence, h('div', { className: 'bar-btns' }, zoomOut, zoomIn, exportBtn, s.local ? null : chatBtn)))
  const ruler = h('div', { className: 'ruler' }, h('div', { className: 'corner' }, where, projectTitle()))
  const rulerBody = h('div', { className: 'ruler-body' })
  ruler.append(rulerBody)
  const laneBox = h('div', { className: 'lanes' })
  // Background menu "Upload": files go into the clicked track at the clicked position.
  let bgTarget: { trackId: string; at: number } | null = null
  const bgPicker = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true })
  bgPicker.onchange = () => {
    const files = audioFiles(bgPicker.files)
    bgPicker.value = ''
    if (bgTarget && files.length) void dropFiles(files, bgTarget.trackId, bgTarget.at)
  }
  const addLink = h('button', { className: 'add-track', title: 'new track', onclick: () => {
    const n = getTracks(doc).length + 1
    popover(addLink, [
      ['audio', () => addTrack(doc, `track ${n}`, 'audio', undefined, undefined, nextTrackColor(getTracks(doc)))],
      ['midi', () => {
        doc.transact(() => addDevice(doc, addTrack(doc, `midi ${n}`, 'midi', undefined, undefined, nextTrackColor(getTracks(doc))), FINNWAVE))
      }],
      ['soundscape', () => addTrack(doc, `soundscape ${n}`, 'soundscape', undefined, undefined, nextTrackColor(getTracks(doc)))],
    ])
  } }, '+')
  const overlay = h('div', { className: 'overlay' })
  const playhead = h('div', { className: 'playhead' })
  const snapLine = h('div', { className: 'snap-line', hidden: true }) // where a dragged clip just snapped to
  // The ruler is opaque and above the overlay, so it carries its own copies of the playhead lines.
  const rulerHead = h('div', { className: 'playhead' })
  const rulerHeads = h('div', { className: 'overlay' }, rulerHead)
  overlay.append(playhead, snapLine)
  const hint = h('div', { className: 'hint dim' }, readOnly ? 'nothing here yet.' : 'drop audio files here, or use + track.')
  const masterAuto = makeAutoSection(MASTER_TRACK, 'master automation')
  const master = h('div', { className: 'lane master' }) // like a track's lane: the fx row, then its automation, as one block (filled below)
  const content = h('div', { className: 'content' }, ruler, laneBox, master, hint, readOnly ? null : addLink, bgPicker, overlay)
  const scroll = h('div', { className: 'scroll' }, content)
  // Drops outside any lane start a new track.
  scroll.ondragover = (e) => e.preventDefault()
  scroll.ondrop = (e) => {
    e.preventDefault()
    if (readOnly) return
    void dropFiles(audioFiles(e.dataTransfer?.files), null, fromX(e.clientX - rulerBody.getBoundingClientRect().left))
  }
  // The global fx lane: the master bus chain. It closes the track list, directly above the global automation (one unit, after every track).
  const masterCards = new Map<string, ReturnType<typeof deviceCard>>()
  const masterMore = h('div', { className: 'fx-toggle' }, 'master fx')
  const masterFx = h('div', { className: 'fx', hidden: true })
  const masterAdd = h('button', { className: 'add-fx', title: 'add effect', disabled: readOnly, onclick: () =>
    popover(masterAdd, EFFECTS.map((d) => [d.name, () => addDevice(doc, MASTER_TRACK, d.type)] as [string, () => void])) }, '+')
  masterFx.append(masterAdd)
  const masterTabs = makeTabs(MASTER_TRACK, TABS.master)
  const masterFxRow = h('div', { className: 'fx-row', hidden: true }, masterMore, masterFx)
  const masterMix = mixControls(MASTER_TRACK)
  master.append(h('div', { className: 'lane-row master-row' }, h('div', { className: 'head' }, h('div', { className: 'head-top' }, h('span', { className: 'name' }, 'master')), masterMix.row, masterTabs.el)), masterFxRow, masterAuto.el)
  const el = h('div', { className: 'timeline' }, bar, h('div', { className: 'body' }, scroll, chat.el))

  const x = (smp: number) => (smp / rate) * pps
  const fromX = (px: number) => Math.max(0, Math.round((px / pps) * rate))
  const position = () => pb?.position() ?? 0

  const ne = noteEditor({
    doc, undo, readOnly,
    selectNote: (id) => ((noteSel = id), draw()),
    noteLive: (trackId, pitch, velocity, on) => pb?.noteLive(trackId, pitch, velocity, on),
  })
  const dg = drumGrid({ doc, undo, readOnly })

  // --- transport
  function toggle() {
    if (!pb) return
    if (pb.playing) stop()
    else startTransport()
  }
  function startTransport() {
    pb?.play()
    transport.setPlaying(true)
    tick()
    ensurePreviewTick() // the loopers' playheads
  }
  function stop() {
    const t = take
    take = null
    loops?.reset()
    const live = loopLive // (a loop interrupted by the stop is saved as a plain take; its live source goes once the take has ended)
    loopLive = null
    clearLoopTimer()
    drawLoopStatus()
    const captured = t ? pb?.recorder.stop() : undefined // (asks the worklet to end the take before the engine stops)
    // the loop commands' microphone is let go once every take has ended (never cut short); a track armed for recording keeps it
    void Promise.all([captured, closingTake]).then(() => !armedTrack && !take && !pb?.playing && !loops?.recording && pb?.recorder.disarm())
    if (live) void Promise.resolve(captured).then(() => (live.clip != null && pb?.removeLiveClip(live.clip), pb?.dropLiveSource(live.source)))
    pb?.stop()
    transport.setPlaying(false)
    s.setLocal({ playhead: null, ...(t ? { recording: null } : {}) })
    draw()
    ensurePreviewTick() // let the loopers' playheads clear
    if (t && captured) void saveTake(t, captured)
  }

  // --- recording (docs/engine.md §9)
  /** R: arm this audio track (the first time, ask for the microphone) or disarm it. */
  async function arm(id: string) {
    if (!pb || take) return
    if (armedTrack === id) {
      armedTrack = null
      pb.recorder.disarm()
      return draw()
    }
    try {
      await pb.recorder.arm()
    } catch (err) {
      say(`record: ${(err as Error).message}`, true)
      return
    }
    say('')
    armedTrack = id
    draw()
  }

  /** ●: play and capture from the playhead (onto a new track if none is armed); again to stop. */
  let preparing = false // asking for the microphone: ignore further presses
  async function toggleRecord() {
    if (!pb || readOnly || preparing) return
    if (loops?.recording) return void say('record: a loop is recording', true)
    if (take) return stop()
    if (!armedTrack || !tracksMap(doc).has(armedTrack) || !pb.recorder.armed) {
      preparing = true
      try {
        await pb.recorder.arm()
      } catch (err) {
        say(`record: ${(err as Error).message}`, true)
        return
      } finally {
        preparing = false
      }
      if (destroyed || take) return
      if (!armedTrack || !tracksMap(doc).has(armedTrack)) armedTrack = addTrack(doc, `track ${getTracks(doc).length + 1}`, 'audio', undefined, undefined, nextTrackColor(getTracks(doc)))
      draw()
    }
    const trackId = armedTrack!
    const from = Math.round(position()) // (while playing, capture begins at the engine's next block: the recorder reports where)
    const info = { trackId, trackName: String(tracksMap(doc).get(trackId)!.get('name')) }
    const journal = takeJournal(s.projectId, info, rate, pb.recorder.info!.channels)
    try {
      pb.recorder.start((pcm, seq) => journal.chunk(pcm, seq), (pos) => journal.header(pos, pb!.recorder.latency()))
    } catch (err) {
      journal.release()
      say(`record: ${(err as Error).message}`, true)
      return
    }
    take = { ...info, start: from, journal }
    say('')
    s.setLocal({ recording: { trackId, start: from } })
    if (!pb.playing) pb.play(from)
    transport.setPlaying(true)
    tick()
    ensurePreviewTick()
    draw()
  }

  async function saveTake(t: NonNullable<typeof take>, captured: Promise<Captured | null>) {
    const cap = await captured
    if (!cap) return t.journal.discard(), t.journal.release()
    say('saving take…')
    undo.stopCapturing()
    try {
      await finishTake(takeCtx(), { ...cap, trackId: t.trackId, trackName: t.trackName })
      say('')
      await t.journal.settled()
      t.journal.discard() // (on failure the backup stays, and is recovered next time)
    } catch (err) {
      say(`take: ${(err as Error).message}`, true)
    }
    t.journal.release()
    undo.stopCapturing()
  }

  const takeCtx = (): TakeCtx => ({ doc, projectId: s.projectId, me: s.userId == null ? null : { id: s.userId, name: s.user.username }, rate })

  // --- loop commands (docs/engine.md §9.2, audio/loopPedal.ts): the transport keeps rolling and every command is written into
  // the doc where it was heard. A loop take goes through the normal take path (`take`, the recorder, `finishTake`).
  function resetLoops() {
    loops?.reset()
    dropLoopLive()
    loops = null
  }
  const clearLoopTimer = () => (clearInterval(loopTimer), (loopTimer = 0))
  /** Let go of a loop's live source and engine-only clip that never became a doc clip. */
  function dropLoopLive() {
    clearLoopTimer()
    const l = loopLive
    loopLive = null
    if (!l || !pb) return
    if (l.clip != null) pb.removeLiveClip(l.clip)
    pb.dropLiveSource(l.source)
  }
  function makeLoops(): LoopPedal | null {
    if (!pb || readOnly) return null
    const io: LoopIO = {
      playing: () => !!pb?.playing,
      play: startTransport,
      beginTake: beginLoopTake,
      liveLoop: (t) => {
        // The clip plays from the live source at once: silent until the boundary, then the loop, whatever the save is doing.
        if (loopLive) loopLive.clip = pb!.liveClip(t.trackId, { source: loopLive.source, start: t.start, length: foreverSamples(rate), sourceOffset: loopOffset(t), loopLength: t.pass })
      },
      endTake: endLoopTake,
      cancelTake: cancelLoopTake,
      say: (m) => say(m, true),
    }
    return new LoopPedal({ doc, rate, io, undo, latency: () => pb!.recorder.latency() })
  }
  /** The take of a loop: the normal recording path, written into a live source the engine can play while it grows. */
  function beginLoopTake(trackId: string): boolean {
    const rec = pb!.recorder
    if (take || rec.recording || !rec.armed || !rec.info) {
      say('loop: the previous take is still closing', true)
      return false
    }
    const source = pb!.liveSource(rec.info.channels)
    const info = { trackId, trackName: String(tracksMap(doc).get(trackId)!.get('name')) }
    const journal = takeJournal(s.projectId, info, rate, rec.info.channels)
    const from = Math.round(position())
    try {
      rec.start((pcm, seq) => journal.chunk(pcm, seq), (pos) => (journal.header(pos, rec.latency()), loops?.tookAt(pos)), source)
    } catch (err) {
      journal.release()
      pb!.dropLiveSource(source)
      say(`loop: ${(err as Error).message}`, true)
      return false
    }
    take = { ...info, start: from, journal }
    loopLive = { source }
    armedTrack = trackId
    s.setLocal({ recording: { trackId, start: from } })
    loopTimer = window.setInterval(() => loops && (loops.tick(position()), drawLoopStatus()), 30)
    return true
  }
  /** The loop has all its frames: stop the take and save it. Its clip is the loop, written with the take (one undo step). */
  function endLoopTake(t: LoopTake) {
    const tk = take, live = loopLive
    take = null
    loopLive = null
    clearLoopTimer()
    s.setLocal({ recording: null })
    if (!tk || !live || !pb) return
    const stopped = pb.recorder.stop()
    closingTake = stopped
    void saveLoopTake(tk, stopped, t, live)
    draw()
  }
  function cancelLoopTake() {
    const tk = take, live = loopLive
    take = null
    clearLoopTimer()
    s.setLocal({ recording: null })
    const stopped = pb?.recorder.stop()
    if (stopped) closingTake = stopped
    loopLive = null
    void stopped?.then(() => live && pb?.dropLiveSource(live.source))
    tk?.journal.discard()
    tk?.journal.release()
    draw()
  }
  async function saveLoopTake(tk: NonNullable<typeof take>, captured: Promise<Captured | null>, t: LoopTake, live: NonNullable<typeof loopLive>) {
    const gone = () => (live.clip != null && pb?.removeLiveClip(live.clip), pb?.dropLiveSource(live.source))
    const cap = await captured
    if (!cap) return gone(), tk.journal.discard(), tk.journal.release()
    try {
      await finishTake(takeCtx(), { ...cap, trackId: tk.trackId, trackName: tk.trackName }, `loop ${new Date().toLocaleTimeString([], { hour12: false })}`,
        (hash) => (pb?.bindLiveSource(hash, live.source), joinUndo(undo, t.undoDepth)),
        ({ trackId, hash }) => void commitLoop(doc, { ...t, recstart: cap.startPos }, trackId, hash), true)
      await tk.journal.settled()
      tk.journal.discard() // (on failure the backup stays, and is recovered next time)
    } catch (err) {
      gone()
      say(`loop: ${(err as Error).message}`, true)
    }
    tk.journal.release()
    undo.stopCapturing()
  }

  /** Run a command heard at `perfTime` (performance.now clock; a key or MIDI event's timeStamp). */
  async function command(cmd: Cmd, perfTime: number) {
    if (!pb || readOnly || destroyed || loopArming) return
    let at = perfTime
    if (cmd === 'record' && !loops?.recording) {
      if (take) return void say('loop: stop recording first', true)
      if (!pb.recorder.armed) { // the first press asks for the microphone; it stays armed
        loopArming = true
        try {
          await pb.recorder.arm()
        } catch (err) {
          return void say(`loop: ${(err as Error).message}`, true)
        } finally {
          loopArming = false
        }
        say('')
        at = performance.now()
        if (destroyed || !pb) return
      }
    }
    loops ??= makeLoops()
    if (!loops) return
    if (armedTrack && tracksMap(doc).has(armedTrack)) loops.current = armedTrack // an armed track is the current one
    loops.press(cmd, pb.playing ? pb.heard(at) : Math.round(position()))
    if (armedTrack && loops.current) armedTrack = loops.current
    draw()
  }
  /** Listen to the chosen MIDI input (always, once one is set up). */
  function listenMidi() {
    offMidi()
    offMidi = () => {}
    const id = getMidiInput()
    if (!id || !midiSupported() || readOnly) return
    void openMidi().then(() => {
      if (destroyed || id !== getMidiInput()) return
      offMidi = onPress(id, (t, at) => {
        const c = actionFor(getBindings(), t)
        if (c) void command(c, at)
      })
    }, () => {})
  }
  const fmtSec = (smp: number) => `${(smp / rate).toFixed(1)}s`
  /** The top bar's loop status: only while a loop records. */
  function drawLoopStatus() {
    const st = loops?.status(position())
    const text = !st ? '' : st.free ? `rec loop · ${fmtSec(st.samples)}` : `rec loop · ${st.stopping ? 'ends' : 'edge'} in ${fmtSec(st.samples)}`
    if (loopText.textContent !== text) loopText.textContent = text
    loopText.hidden = !st
  }

  /** Right-click on ●: the manual input delay for the microphone in use (added to the automatic compensation). */
  function offsetMenu(e: MouseEvent) {
    const info = pb?.recorder.info
    if (!info) {
      say('arm a track to set the input offset of its microphone')
      return
    }
    popover(e.currentTarget as HTMLElement, [[`input offset: ${getInputOffset(info.deviceId)} ms (change…)`, () => {
      const v = prompt(`extra input delay in ms for "${info.label || 'this microphone'}".\npositive if takes land late, negative if early.`, String(getInputOffset(info.deviceId)))
      if (v != null && Number.isFinite(Number(v))) setInputOffset(info.deviceId, Number(v))
    }]])
  }

  // Level meters: the engine's post-fader peaks fill each track's gain slider (--l / --r on the input, a paint-only write).
  // Reports (~30 Hz) only set targets; one rAF loop eases the bars toward them and stops once everything has settled.
  const meterTo = new Map<string, [number, number]>()
  const meterNow = new Map<string, [number, number]>()
  let meterRaf = 0
  let meterAt = 0
  function onMeters(m: Meters) {
    for (const id of [...lanes.keys(), MASTER_TRACK]) {
      const p = id === MASTER_TRACK ? m.master : m.tracks.get(id)
      meterTo.set(id, p ? [peakToFill(p[0]), peakToFill(p[1])] : [0, 0])
    }
    if (meterRaf) return
    meterAt = performance.now()
    meterRaf = requestAnimationFrame(meterFrame)
  }
  function meterFrame(now: number) {
    const dt = now - meterAt
    meterAt = now
    let moving = false
    for (const [id, to] of meterTo) {
      const fader = (id === MASTER_TRACK ? masterMix : lanes.get(id)?.mix)?.gain
      if (!fader) { meterTo.delete(id); meterNow.delete(id); continue }
      const was = meterNow.get(id) ?? [0, 0]
      const at: [number, number] = [follow(was[0], to[0], dt), follow(was[1], to[1], dt)]
      if (at[0] !== was[0]) fader.style.setProperty('--l', at[0].toFixed(3))
      if (at[1] !== was[1]) fader.style.setProperty('--r', at[1].toFixed(3))
      meterNow.set(id, at)
      if (at[0] > to[0] || at[1] > to[1]) moving = true
    }
    meterRaf = moving ? requestAnimationFrame(meterFrame) : 0
  }

  /** The armed track's input meter: level on the drawn scale, red once the input has hit full scale. */
  function drawLevel() {
    const rec = pb?.recorder
    const l = armedTrack ? lanes.get(armedTrack) : undefined
    if (!rec || !l?.meter) return
    l.meter.style.setProperty('--lv', String(shape(rec.level)))
    l.meter.classList.toggle('clipping', rec.clipped) // (not 'clip': that is the timeline clips' class, with its own ::before)
  }

  /** The take so far, drawn into its growing region (the visible part only). */
  function drawLiveWave(region: HTMLElement, startPx: number, widthPx: number) {
    let cv = region.querySelector('canvas')
    if (!cv) region.prepend((cv = h('canvas', { className: 'wave' })))
    const viewW = scroll.clientWidth || innerWidth
    const left = HEADER + startPx // region's left edge in scroller-content px
    const v0 = Math.max(0, Math.floor(scroll.scrollLeft + HEADER - left)), v1 = Math.min(Math.ceil(widthPx), Math.ceil(scroll.scrollLeft + viewW - left))
    if (v1 <= v0) { cv.style.display = 'none'; return }
    const dpr = window.devicePixelRatio || 1
    cv.style.display = ''
    cv.style.left = `${v0}px`
    cv.style.width = `${v1 - v0}px`
    cv.width = Math.max(1, Math.round((v1 - v0) * dpr))
    cv.height = Math.round(LANE_H * dpr)
    const fpp = rate / pps // frames per css px
    drawWave(cv, pb!.recorder.peaks, v0 * fpp, (v1 - v0) * fpp)
  }

  /** The growing regions of takes in progress: ours, and other people's (from their awareness). */
  function drawRecRegions() {
    const want = new Map<string, { trackId: string; start: number; end: number; label: string }>()
    if (take) want.set('me', { trackId: take.trackId, start: take.start, end: position(), label: 'recording' })
    for (const r of s.remoteStates()) {
      if (r.recording) want.set(`${r.user.username}:${r.recording.trackId}`, { ...r.recording, end: r.playhead ?? r.recording.start, label: `${r.user.username} is recording` })
    }
    for (const [k, e] of recRegions) if (!want.has(k)) { e.remove(); recRegions.delete(k) }
    for (const [k, w] of want) {
      const body = lanes.get(w.trackId)?.body
      if (!body) continue
      let e = recRegions.get(k)
      if (!e) recRegions.set(k, (e = h('div', { className: 'clip recording' }, w.label)))
      if (e.parentElement !== body) body.append(e)
      e.style.left = `${x(w.start)}px`
      const width = Math.max(2, x(Math.max(w.start, w.end) - w.start))
      e.style.width = `${width}px`
      if (k === 'me' && pb) drawLiveWave(e, x(w.start), width)
    }
  }
  let lastAware = 0
  function tick() {
    if (destroyed || !pb?.playing) return
    // A take over the playback limit couldn't be played back: end it there (16-bit, so 2 bytes a sample).
    if (take && (position() - take.start) * pb.recorder.info!.channels * 2 >= PLAYBACK_MAX_BYTES - 1024 * 1024) {
      stop()
      say('take stopped: it reached the longest take that can be played back yet')
      return
    }
    drawPlayhead()
    const now = performance.now()
    if (now - lastAware > 100) {
      lastAware = now
      s.setLocal({ playhead: position() })
    }
    requestAnimationFrame(tick)
  }
  function drawPlayhead() {
    if (autoLanes.length) refreshAuto()
    const p = position()
    playhead.style.left = `${HEADER + x(p)}px`
    rulerHead.style.left = `${x(p)}px`
    transport.setTime(p / rate)
    drawRecRegions()
    drawLoopStatus()
  }
  function seek(smp: number) {
    if (take) return // a take is one continuous stretch of the timeline
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
    commitMany: (d: string, values: Record<number, number>) => {
      undo.stopCapturing()
      for (const [p, v] of Object.entries(values)) setParam(doc, d, Number(p), v)
      undo.stopCapturing()
    },
    bypass: (d: string, b: boolean) => updateDevice(doc, d, { bypass: b }),
    remove: (d: string) => deleteDevice(doc, d),
    rename: (d: string) => {
      const dev = getDevices(doc).find((x) => x.id === d)
      const name = dev && prompt('name', dev.name ?? DEVICES[dev.type]?.name ?? '')?.trim()
      if (name) updateDevice(doc, d, { name })
    },
    reorderStart: () => { reordering = true; schedule() },
    reorderEnd: () => { reordering = false; schedule() },
    reorderDrop: (d: string, before: string | null) => {
      const dev = getDevices(doc).find((x) => x.id === d)
      if (!dev) return
      const synth = !!DEVICES[dev.type]?.instrument // instruments and effects are separate rows
      const chain = getDevices(doc).filter((x) => x.trackId === dev.trackId && x.id !== d && !!DEVICES[x.type]?.instrument === synth)
      const i = before == null ? chain.length : chain.findIndex((x) => x.id === before)
      if (i < 0) return
      undo.stopCapturing()
      updateDevice(doc, d, { order: orderBetween(chain[i - 1]?.order, chain[i]?.order) })
      undo.stopCapturing()
    },
    run: (d: string, self: FilterMember) => reordering && document.querySelector('.dev.reordering') ? [self] : (runs.get(d) ?? [d]).flatMap((o) => (o === d ? [self] : [cardOf(o)?.member() ?? []].flat())),
    changed: (d: string) => { const host = runs.get(d)?.[0]; if (host && host !== d) cardOf(host)?.redrawCurve() },
    dragFilter: (d: string, change: FilterChange) => cardOf(d)?.dragMove(change),
    dragFilterEnd: (d: string) => cardOf(d)?.dragEnd(),
    autoMenu: (label: HTMLElement, t: ParamTarget, clickToo?: boolean) => autoMenu(label, () => t, clickToo),
  }

  // --- automation: lanes (one per automated param) live in a collapsible section per track, and one for the global fx
  const rowDeps = { doc, readOnly, grab: () => undo.stopCapturing(), x, fromX, get rate() { return getSampleRate(doc) } }

  function autoMenu(label: HTMLElement, target: () => ParamTarget, clickToo = true) {
    const lane = () => laneOf(doc, target())
    automateMenu(label, {
      state: () => { const l = lane(); return !l ? 'none' : l.enabled ? 'on' : 'off' },
      automate: () => automate(target()),
      lfo: () => automate(target(), true),
      show: () => reveal(target().scope),
      toggle: () => { const l = lane(); if (l) setLaneEnabled(doc, l.id, !l.enabled) },
      remove: () => { const l = lane(); if (l) deleteLane(doc, l.id) },
    }, readOnly, clickToo)
  }

  /**
   * The volume fader and pan knob of a track or the master bus: they read and write the scope's mix device (one undo step per
   * gesture), and right-click offers automation. The fader doubles as the level meter (`onMeters`).
   */
  function mixControls(scope: string): MixCtl {
    const gain = h('input', { type: 'range', className: 'gain', min: 0, max: 1, step: 'any', title: 'volume', disabled: readOnly })
    ticks(gain, [UNITY_POS]) // 0 dB; the top of the range is +6 dB
    valueTip(gain, () => fmtDb(posToGain(gain.valueAsNumber)))
    gain.oninput = () => setMixParam(doc, scope, 'gain', posToGain(gain.valueAsNumber))
    gain.onpointerdown = () => undo.stopCapturing()
    const pan = knob({
      min: -1, max: 1, value: 0, def: 0, bipolar: true, size: 20, disabled: readOnly,
      title: (v) => (Math.abs(v) < 0.005 ? 'pan: centre (double-click to reset)' : `pan: ${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`),
      onStart: () => undo.stopCapturing(), // one undo step per gesture
      onInput: (v) => setMixParam(doc, scope, 'pan', Math.abs(v) < 0.02 ? 0 : v),
      onChange: () => undo.stopCapturing(),
    })
    const target = (p: number) => (): ParamTarget => ({ scope, kind: 'effect', owner: getMixDevice(doc, scope)?.id ?? '', param: String(p) })
    autoMenu(gain, target(MIX_GAIN), false)
    autoMenu(pan.el, target(MIX_PAN), false)
    return { gain, pan, row: h('div', { className: 'ctl gain-row' }, gain, pan.el) }
  }

  /** Show the mix device's values on its controls; while a lane drives one, it follows the lane (as device knobs do) and can't be dragged. */
  function drawMix(scope: string, c: MixCtl) {
    const d = getMixDevice(doc, scope)
    const auto = d ? autoInfos.get(d.id) : undefined
    const drive = (p: number) => {
      const a = auto?.get(String(p))
      return a?.on && a.value != null ? a.value : null
    }
    const g = drive(MIX_GAIN), pn = drive(MIX_PAN)
    if (g != null || !inUse(c.gain)) c.gain.value = String(gainToPos(g ?? d?.params?.[MIX_GAIN] ?? 1))
    c.gain.disabled = readOnly || g != null
    c.pan.setDisabled(readOnly || pn != null)
    c.pan.set(pn ?? d?.params?.[MIX_PAN] ?? 0)
  }

  /** Automate a param: a lane that starts flat at its current value, so nothing changes until a point is moved (or, with `lfo`, one in LFO mode). */
  function automate(t: ParamTarget, lfo = false) {
    const r = resolveTarget(doc, t)
    if (!r) return
    doc.transact(() => {
      const id = addLane(doc, t, r.def)
      if (!getPoints(doc).some((p) => p.laneId === id)) addPoint(doc, id, 0, paramToPos(r.def, r.value), r.def.options ? 'hold' : 'linear')
      if (lfo) setLaneState(doc, id, 'lfo')
    })
    reveal(t.scope)
  }

  function reveal(scope: string) {
    autoShown.add(scope)
    draw()
    ;(scope === MASTER_TRACK ? masterAuto : lanes.get(scope)?.auto)?.el.scrollIntoView({ block: 'nearest' })
  }

  const shownSet = (n: TabName) => ({ source: srcShown, synth: synthShown, loopers: loopShown, fx: expanded, auto: autoShown, presets: presetsShown })[n]

  /** The tab to open or shut one drawer of a track (or MASTER_TRACK): the one way in. */
  function toggleTab(id: string, n: TabName) {
    if (shownSet(n).delete(id)) {
      if (n === 'source' || n === 'loopers') { // the transport is about to be hidden: don't leave it playing
        const pv = pb?.preview(id, n === 'source' ? 'source' : 'loops')
        if (pv?.playing) pv.stop()
      }
    } else shownSet(n).add(id)
    draw()
  }

  /** The row of tabs at the bottom of a header: one per drawer this kind of track has. They live in the header column only. */
  function makeTabs(id: string, names: TabName[]) {
    const btns = new Map(names.map((n) => [n, h('button', { className: 'tab', title: TAB_TITLE[n], onclick: () => toggleTab(id, n) }, TAB_LABEL[n])] as [TabName, HTMLButtonElement]))
    return { el: h('div', { className: 'tabs' }, ...btns.values()), btns }
  }
  const syncTabs = (id: string, btns: Map<TabName, HTMLButtonElement>) => {
    for (const [n, b] of btns) {
      const on = shownSet(n).has(id)
      b.classList.toggle('on', on)
      b.setAttribute('aria-pressed', String(on))
    }
  }

  function makeAutoSection(scope: string, title = 'automation'): AutoSec {
    const toggle = h('div', { className: 'fx-toggle' }, title)
    const box = h('div', { className: 'auto-box' })
    const el = h('div', { className: 'auto-section', hidden: true }, h('div', { className: 'fx-row' }, toggle), box)
    el.dataset.title = title
    return { el, toggle, box, rows: new Map() }
  }

  /** The owner's name for a lane header: the device's, numbered when its chain has several of a kind. */
  /** The presets drawer: a section like the automation one (same toggle and box), holding one column of plain-text buttons per group. */
  function makePresetsDrawer(id: string) {
    const toggle = h('div', { className: 'fx-toggle on' }, 'presets')
    const grid = h('div', { className: 'preset-grid' })
    return { el: h('div', { className: 'auto-section', hidden: true }, h('div', { className: 'fx-row' }, toggle, grid)), toggle, grid }
  }

  function drawPresets(l: Lane, t: Track) {
    const list = presetsShown.has(t.id) ? presetsFor(doc, t.id) : []
    const has = presetsFor(doc, t.id).length > 0
    l.tabs.get('presets')!.hidden = !has
    l.presets.el.hidden = !list.length
    const groups = new Map<string, typeof list>()
    for (const p of list) groups.set(p.group, [...(groups.get(p.group) ?? []), p])
    l.presets.grid.replaceChildren(...[...groups].map(([name, items]) => h('div', { className: 'preset-col', role: 'group', 'aria-label': name },
      h('h4', {}, name),
      ...items.map((p) => h('button', { className: 'preset' + (t.preset === p.id ? ' on' : ''), disabled: readOnly || locks.has(t.id), 'aria-pressed': String(t.preset === p.id), onclick: () => {
        undo.stopCapturing()
        applyPreset(doc, t.id, p.id)
        undo.stopCapturing()
      } }, p.name)))))
  }

  function ownerLabel(l: AutoLane, base: string, devices: Device[]) {
    if (l.kind === 'looper') return base
    const same = devices.filter((d) => d.trackId === l.scope && DEVICES[d.type]?.name === base)
    return same.length > 1 ? `${base} ${same.findIndex((d) => d.id === l.owner) + 1}` : base
  }

  /** Read the lanes and their points from the doc, and what they drive at the playhead. */
  function loadAuto() {
    autoLanes = getLanes(doc)
    autoPoints = new Map()
    for (const p of getPoints(doc)) (autoPoints.get(p.laneId) ?? autoPoints.set(p.laneId, []).get(p.laneId)!).push(p)
    for (const list of autoPoints.values()) list.sort((a, b) => a.pos - b.pos)
    readAuto()
  }

  /** Sync every scope's section with the lanes in the doc. */
  function drawAutomation(devices: Device[], loopers: Looper[], width: number) {
    const byScope = new Map<string, AutoLane[]>()
    for (const l of autoLanes) (byScope.get(l.scope) ?? byScope.set(l.scope, []).get(l.scope)!).push(l)
    const sections: [string, AutoSec][] = [[MASTER_TRACK, masterAuto], ...[...lanes].map(([id, l]) => [id, l.auto] as [string, AutoSec])]
    for (const [scope, sec] of sections) {
      const mixId = getMixDevice(doc, scope)?.id
      const rank = (l: AutoLane) => (l.owner === mixId ? 0 : 1) // the fader's and pan's lanes lead the section
      const mine = (byScope.get(scope) ?? []).flatMap((l) => {
        const r = resolveTarget(doc, l)
        return r ? [{ l, r }] : []
      }).sort((a, b) => rank(a.l) - rank(b.l) || (rank(a.l) ? 0 : Number(a.l.param) - Number(b.l.param)))
      const open = autoShown.has(scope)
      const tab = (scope === MASTER_TRACK ? masterTabs.btns : lanes.get(scope)?.tabs)?.get('auto')
      if (tab) tab.hidden = mine.length === 0 // (no lanes: nothing to open)
      sec.el.hidden = mine.length === 0 || !open
      sec.toggle.classList.toggle('on', open)
      sec.toggle.textContent = `${sec.el.dataset.title} (${mine.length})`
      const ids = new Set(mine.map((m) => m.l.id))
      for (const [id, row] of sec.rows) if (!ids.has(id)) { row.el.remove(); sec.rows.delete(id) }
      if (sec.el.hidden) continue
      mine.forEach(({ l, r }, i) => {
        let row = sec.rows.get(l.id)
        if (!row) sec.rows.set(l.id, (row = autoRow(rowDeps)))
        if (sec.box.children[i] !== row.el) sec.box.insertBefore(row.el, sec.box.children[i] ?? null)
        const slot = l.kind === 'looper' ? loopers.find((x) => x.id === l.owner)?.slot : undefined
        row.update(l, autoPoints.get(l.id) ?? [], {
          def: r.def, label: devices.find((d) => d.id === l.owner)?.type === MIX ? r.label : `${ownerLabel(l, r.owner, devices)} · ${r.label}`, value: r.value, width,
          color: slot != null ? LOOP_COLORS[slot % LOOP_COLORS.length] : 'var(--accent)',
        })
      })
    }
  }

  /**
   * What each automated param reads at the playhead, for the controls it drives (`autoInfos`). An LFO lane drives
   * nothing: its control stays free, as the wave's centre. Cheap enough to run every frame while playing.
   */
  function readAuto() {
    const at = position()
    autoInfos = new Map()
    for (const l of autoLanes) {
      const r = resolveTarget(doc, l)
      if (!r) continue
      const t = laneState(l) === 'lfo' ? null : evalPoints(autoPoints.get(l.id) ?? [], at)
      ;(autoInfos.get(l.owner) ?? autoInfos.set(l.owner, new Map()).get(l.owner)!).set(l.param, { on: l.enabled && t != null, value: t == null ? null : paramToValue(r.def, t) })
    }
  }
  /** The playhead moved: repaint the controls a lane drives. */
  function refreshAuto() {
    readAuto()
    for (const l of lanes.values()) {
      for (const [id, c] of l.cards) if (autoInfos.has(id)) c.refresh(autoInfos.get(id)!)
      for (const [id, c] of l.loopCards) if (autoInfos.has(id)) c.refresh(autoInfos.get(id)!)
    }
    for (const [id, c] of masterCards) if (autoInfos.has(id)) c.refresh(autoInfos.get(id)!)
    for (const [scope, c] of [[MASTER_TRACK, masterMix] as const, ...[...lanes].map(([id, l]) => [id, l.mix] as const)]) drawMix(scope, c)
  }

  function laneFor(t: Track): Lane {
    let l = lanes.get(t.id)
    if (l) return l
    const kind = h('span', { className: 'kind' }, icon('wave', 14))
    const name = h('span', { className: 'name', ondblclick: () => readOnly || rename(t.id) })
    const mute = h('button', { className: 'mute', title: 'mute', onclick: () => {
      updateTrack(doc, t.id, { muted: !tracksMap(doc).get(t.id)?.get('muted') })
    } }, 'M')
    mute.disabled = readOnly
    const solo = h('button', { className: 'solo', title: 'solo', onclick: () => {
      updateTrack(doc, t.id, { soloed: !tracksMap(doc).get(t.id)?.get('soloed') })
    } }, 'S')
    solo.disabled = readOnly
    const record = t.kind === 'audio' ? h('button', { className: 'record', title: 'arm for recording', onclick: () => void arm(t.id) }, 'R') : null
    if (record) record.disabled = readOnly
    const listen = record ? h('button', { className: 'listen', hidden: true, title: 'monitor the input through this track\'s effects (use headphones)', onclick: () => {
      monitoring = !monitoring
      draw()
    } }, 'I') : null
    const meter = record ? h('i', { className: 'meter', hidden: true, title: 'input level' }) : null
    const mix = mixControls(t.id)
    const tabs = makeTabs(t.id, TABS[t.kind] ?? TABS.audio)
    const more = h('div', { className: 'fx-toggle' }, 'fx')
    const delTrack = () => !locks.has(t.id) && confirm('delete this track and its clips?') && deleteTrack(doc, t.id)
    const head = h('div', { className: 'head' }, h('div', { className: 'head-top' }, kind, name, h('div', { className: 'ctl track-btns' }, mute, solo, record, listen, meter)), mix.row, tabs.el)
    // Click or right-click on the header (not on its controls) offers the track's menu.
    let menuClosed = false // this press just closed the menu: don't open it again
    head.addEventListener('pointerdown', (e) => (menuClosed = closedBy(e)), true)
    const trackMenu = (e: MouseEvent) => {
      if (readOnly || locks.has(t.id)) return
      popover(head, [
        ['rename', () => rename(t.id)],
        ['delete track', () => void delTrack()],
      ], [e.clientX, e.clientY])
    }
    head.addEventListener('click', (e) => {
      if (!menuClosed && !(e.target as HTMLElement).closest('button, input, .knob')) trackMenu(e)
    })
    head.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation() // not the lane's background menu underneath
      trackMenu(e)
    })
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
    if (t.kind === 'audio') bgMenu(body, (e) => [['upload', () => pickInto(t.id, atX(e))]])
    else if (t.kind === 'midi') bgMenu(body, (e) => [['new piano roll', () => newMidiClip(t.id, atX(e))], ['new drum grid', () => newMidiClip(t.id, atX(e), true)]])
    else if (t.kind === 'soundscape') bgMenu(body, (e) => [['new region', () => newPad(t.id, atX(e))]])
    const fx = h('div', { className: 'fx', hidden: true })
    const add = h('button', { className: 'add-fx', title: 'add effect', disabled: readOnly, onclick: () =>
      popover(add, EFFECTS.map((d) => [d.name, () => addDevice(doc, t.id, d.type)] as [string, () => void])) }, '+')
    fx.append(add)
    const fxRow = h('div', { className: 'fx-row' }, more, fx) // opaque, so it covers the playhead
    // MIDI tracks: the instrument gets its own row above the FX bar
    const synthMore = h('div', { className: 'fx-toggle' }, 'synth')
    const synth = h('div', { className: 'fx' })
    const addSynth = h('button', { className: 'add-fx', title: 'add instrument', disabled: readOnly, onclick: () =>
      popover(addSynth, INSTRUMENTS.map((d) => [d.name, () => (d.type === LOFI_DRUM ? addDrum(doc, t.id) : addDevice(doc, t.id, d.type))] as [string, () => void])) }, '+')
    synth.append(addSynth)
    const synthRow = h('div', { className: 'fx-row', hidden: true }, synthMore, synth)
    // soundscape tracks: the main lane is blank like an empty track (regions turn the loopers on); the source audio gets its own lane
    const src: Src | null = t.kind === 'soundscape' ? sourceLane(t.id) : null
    // the loopers row: speed and region per slot, above the FX bar
    const loopMore = h('div', { className: 'fx-toggle' }, 'loopers')
    const loops = h('div', { className: 'fx' })
    loops.append(h('button', { className: 'add-fx', title: 'add looper', disabled: readOnly, onclick: () => addNextLooper(doc, t.id) }, '+'))
    const loopTc = transportControls({ title: 'play / stop the loops', small: true, onToggle: () => togglePreview(t.id, 'loops') })
    const loopRow = h('div', { className: 'fx-row', hidden: true }, h('div', { className: 'fx-head' }, loopMore, loopTc.el), loops)
    const row = h('div', { className: 'lane-row' }, head, body)
    const auto = makeAutoSection(t.id)
    const presets = makePresetsDrawer(t.id)
    l = {
      el: h('div', { className: 'lane' }, row, src?.row ?? null, synthRow, loopRow, fxRow, auto.el, presets.el), row, body, name, kind, mute, solo, record, listen, meter, mix, tabs: tabs.btns, more,
      fxRow, fx, synthMore, synthRow, synth, loopMore, loopRow, loops, loopCards: new Map(), boxes: new Map(), heads: new Map(), cards: new Map(),
      pads: new Map(), auto, presets, loopTc, src,
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

  /** Each filter's run: the ids of the filters adjacent to it in its chain (itself included), in chain order. */
  const runs = new Map<string, string[]>()
  const cardOf = (id: string) => masterCards.get(id) ?? [...lanes.values()].map((l) => l.cards.get(id)).find((c) => c)
  function findRuns(chain: Device[]) {
    let run: string[] = []
    const flush = () => { for (const id of run) runs.set(id, run); run = [] }
    for (const d of chain) {
      if (d.type === SIMPLE_FILTER) run.push(d.id)
      else flush()
    }
    flush()
  }

  function drawFx(l: Lane, t: Track, devices: Device[]) {
    const fxOpen = expanded.has(t.id)
    const synthOpen = t.kind === 'midi' && synthShown.has(t.id)
    const mine = devices.filter((d) => d.trackId === t.id && !DEVICES[d.type]?.hidden)
    const chain = mine.filter((d) => !DEVICES[d.type]?.instrument)
    const instruments = mine.filter((d) => DEVICES[d.type]?.instrument)
    l.fxRow.hidden = !fxOpen // a shut drawer takes no height at all
    l.fx.hidden = !fxOpen
    l.more.classList.toggle('on', fxOpen)
    l.synthRow.hidden = !synthOpen
    l.synthMore.classList.toggle('on', synthOpen)
    if (!fxOpen && !synthOpen) return
    const ids = new Set(mine.map((d) => d.id))
    for (const [id, c] of l.cards) if (!ids.has(id)) { c.el.remove(); l.cards.delete(id) }
    const place = (box: HTMLElement, list: Device[]) => list.forEach((d, i) => {
      let c = l.cards.get(d.id)
      if (!c) l.cards.set(d.id, (c = deviceCard(d, cardDeps)))
      if (box.children[i] !== c.el) box.insertBefore(c.el, box.children[i] ?? null)
      c.update(d, remoteDrags.get(d.id) ?? NO_DRAGS, autoInfos.get(d.id) ?? NO_AUTO)
    })
    if (synthOpen) place(l.synth, instruments)
    if (fxOpen) {
      findRuns(chain)
      place(l.fx, chain)
      for (const d of chain) l.cards.get(d.id)?.redrawCurve() // again, now that every card is in place (rows, neighbours)
    }
  }

  function drawMaster(devices: Device[]) {
    const mine = devices.filter((d) => d.trackId === MASTER_TRACK && !DEVICES[d.type]?.hidden)
    const n = mine.length
    const open = expanded.has(MASTER_TRACK)
    masterFxRow.hidden = !open
    masterFx.hidden = !open
    masterMore.classList.toggle('on', open)
    masterMore.textContent = n ? `master fx (${n})` : 'master fx'
    syncTabs(MASTER_TRACK, masterTabs.btns)
    if (!open) return
    const ids = new Set(mine.map((d) => d.id))
    for (const [id, c] of masterCards) if (!ids.has(id)) { c.el.remove(); masterCards.delete(id) }
    findRuns(mine)
    mine.forEach((d, i) => {
      let c = masterCards.get(d.id)
      if (!c) masterCards.set(d.id, (c = deviceCard(d, cardDeps)))
      if (masterFx.children[i] !== c.el) masterFx.insertBefore(c.el, masterFx.children[i] ?? null)
      c.update(d, remoteDrags.get(d.id) ?? NO_DRAGS, autoInfos.get(d.id) ?? NO_AUTO)
    })
    for (const d of mine) masterCards.get(d.id)?.redrawCurve()
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

  /** A drum grid clip is a one-bar pattern looped across four bars (4/4); a piano roll clip is four bars, unlooped. */
  function newMidiClip(trackId: string, at: number, drums = false) {
    const id = addMidiClip(doc, { trackId, start: at, ...(drums ? { view: 'drums', loopTicks: 4 * DEFAULT_PPQ } : {}) })
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
    const more = h('div', { className: 'fx-toggle' }, 'source')
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
    bgMenu(body, (e) => [['upload', () => pickInto(trackId, Math.max(0, Math.round(((e.clientX - body.getBoundingClientRect().left) / src.pps) * rate)))]])
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
        deleteMenu(e, 'delete region', () => { deletePad(doc, p.id); if (padSel === p.id) padSel = null; draw() }, () => !readOnly)
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
    setTape: (id: string, patch: { sat?: number; cutoff?: number; warble?: number }) => updateLooper(doc, id, patch),
    autoMenu: (label: HTMLElement, t: ParamTarget, clickToo?: boolean) => autoMenu(label, () => t, clickToo),
    toggleArm: (id: string) => { armed = armed === id ? null : id; draw() },
    clear: (id: string) => updateLooper(doc, id, { start: 0, length: 0 }),
    remove: (id: string) => { if (armed === id) armed = null; deleteLooper(doc, id) },
  }

  /** Looper rows (cards) and the coloured region boxes drawn over the track's audio. */
  function drawLoopers(l: Lane, t: Track, loopers: Looper[]) {
    const isLoop = t.kind === 'soundscape' && !!l.src
    const open = isLoop && loopShown.has(t.id)
    l.loopRow.hidden = !open
    const mine = isLoop ? loopers.filter((x) => x.trackId === t.id) : []
    l.loops.hidden = !open
    l.loopMore.classList.toggle('on', open)
    l.loopTc.el.hidden = !open
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
        const id = lp.id
        b.onpointerdown = (ev) => loopBoxDown(ev, id, b!)
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
      c.update(lp, lp.id === armed, rate, autoInfos.get(lp.id) ?? NO_AUTO)
    })
  }

  /** Drag a loop window to move it, or either edge to resize it (live in the doc, one undo step). */
  function loopBoxDown(ev: PointerEvent, id: string, el: HTMLElement) {
    if (ev.button !== 0) return
    ev.stopPropagation()
    const lp = getLoopers(doc).find((x) => x.id === id)
    const l = lp && lanes.get(lp.trackId)
    if (!lp || !l?.src || readOnly || armed) return
    ev.preventDefault()
    const mode = grabAt(ev.clientX, el.getBoundingClientRect())
    const pps = l.src.pps
    const min = Math.round(MIN_SEC * rate)
    const end = lp.start + lp.length
    undo.stopCapturing()
    dragPointer(ev, {
      onDrag: (m) => {
        const d = Math.round(((m.clientX - ev.clientX) / pps) * rate)
        if (mode === 'move') updateLooper(doc, id, { start: Math.max(0, lp.start + d) })
        else if (mode === 'l') {
          const start = clamp(lp.start + d, 0, end - min)
          updateLooper(doc, id, { start, length: end - start })
        } else updateLooper(doc, id, { length: Math.max(min, lp.length + d) })
      },
      onEnd: () => undo.stopCapturing(),
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

  // Opening a MIDI clip while zoomed far out zooms in to it (editZoomPps); closing it puts the zoom back, unless the zoom was changed since.
  let zoomedFor: string | null = null
  let savedZoom: { pps: number; left: number; auto: number } | null = null
  function syncEditZoom(clips: Clip[]) {
    if (editing === zoomedFor) return
    zoomedFor = editing
    const c = editing ? clips.find((x) => x.id === editing) : undefined
    if (!c) {
      if (savedZoom && pps === savedZoom.auto) {
        const { pps: back, left } = savedZoom
        pps = back
        requestAnimationFrame(() => (scroll.scrollLeft = left))
      }
      savedZoom = null
      return
    }
    if (c.kind !== 'midi' || lanes.get(c.trackId)?.src) return
    const next = editZoomPps(pps, clipLength(c, rate) / rate, 60 / c.bpm, scroll.clientWidth - HEADER)
    if (next == null) return
    savedZoom = savedZoom && savedZoom.auto === pps ? { ...savedZoom, auto: next } : { pps, left: scroll.scrollLeft, auto: next }
    pps = next
    const left = Math.max(0, (c.start / rate) * next - 8)
    requestAnimationFrame(() => (scroll.scrollLeft = left))
  }

  function draw() {
    if (destroyed) return
    const tracks = getTracks(doc)
    const clips = getClips(doc)
    syncEditZoom(clips)
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

    loadAuto() // (before the cards: they show what a lane drives)

    // remote live-param drags -> overrides on our engine, and the values shown on sliders
    const remote = s.remoteStates()
    remoteDrags = new Map()
    for (const r of remote) {
      for (const d of [r.dragging ?? []].flat()) remoteDrags.set(d.deviceId, (remoteDrags.get(d.deviceId) ?? new Map()).set(d.paramId, d.value))
    }
    pb?.setOverrides(remote.flatMap((r) => [r.dragging ?? []].flat()))
    locks = new Map(remote.flatMap((r) => (r.recording ? [[r.recording.trackId, r.user.username] as [string, string]] : [])))

    if (editing && clipsMap(doc).get(editing)?.get('kind') !== 'midi') editing = null
    const editClip = editing ? clips.find((c) => c.id === editing) : undefined
    const editTrack = editClip?.trackId
    const gridRows = editClip?.kind === 'midi' && editClip.view === 'drums' ? devices.filter((d) => d.trackId === editTrack && isDrum(d)).length : -1 // -1: the piano roll

    // lanes
    hint.hidden = tracks.length > 0
    clickBtn.classList.toggle('on', tracks.some((t) => t.role === 'click' && !t.muted)) // lit: a click track exists and is unmuted
    const ids = new Set(tracks.map((t) => t.id))
    for (const [id, l] of lanes) if (!ids.has(id)) { l.el.remove(); lanes.delete(id) }
    if (armedTrack && !ids.has(armedTrack)) { // the armed track was deleted
      armedTrack = null
      if (!take) pb?.recorder.disarm()
    }
    transport.setRecord(!!armedTrack, !!take)
    const want = monitoring && armedTrack && pb?.recorder.armed ? armedTrack : null // (disarming ends monitoring)
    if (want !== monitored) pb?.monitor((monitored = want))
    tracks.forEach((t, i) => {
      const l = laneFor(t)
      if (laneBox.children[i] !== l.el) laneBox.insertBefore(l.el, laneBox.children[i] ?? null)
      l.body.style.width = `${x(total)}px`
      l.el.dataset.kind = t.kind
      l.el.style.setProperty('--tc', trackColor(t, i))
      l.el.classList.toggle('editing', t.id === editTrack)
      l.el.classList.toggle('drums', t.id === editTrack && gridRows >= 0) // the lane fits the drum grid instead of the piano roll
      if (t.id === editTrack && gridRows >= 0) l.el.style.setProperty('--dg-rows', String(gridRows))
      if (l.name.textContent !== t.name) l.name.textContent = t.name
      const k = trackKind(t, devices, clips)
      if (l.kind.dataset.icon !== k.icon) {
        l.kind.dataset.icon = k.icon
        setIcon(l.kind.firstElementChild as SVGSVGElement, k.icon)
      }
      l.kind.title = k.label
      l.el.classList.toggle('locked', locks.has(t.id))
      l.record?.classList.toggle('on', armedTrack === t.id)
      l.el.classList.toggle('current', !readOnly && loops?.current === t.id)
      if (l.meter) l.meter.hidden = armedTrack !== t.id
      if (l.listen) {
        l.listen.hidden = armedTrack !== t.id
        l.listen.classList.toggle('on', monitoring)
      }
      l.mute.classList.toggle('on', t.muted)
      l.el.classList.toggle('muted', t.muted)
      l.solo.classList.toggle('on', t.soloed)
      drawMix(t.id, l.mix)
      drawFx(l, t, devices)
      drawPresets(l, t)
      drawLoopers(l, t, loopers)
      syncTabs(t.id, l.tabs)
      drawPads(l, t, pads)
      if (l.src) {
        const srcOpen = srcShown.has(t.id)
        l.src.row.hidden = !srcOpen
        l.src.more.classList.toggle('on', srcOpen)
        l.src.end = srcEnd(t.id)
        const end = Math.max(60 * rate, l.src.end + 30 * rate)
        l.src.body.style.width = `${(end / rate) * l.src.pps}px`
        drawTicks(l.src.ticks, end / rate, l.src.pps)
      }
    })

    drawMix(MASTER_TRACK, masterMix)
    drawMaster(devices)
    drawAutomation(devices, loopers, x(total))

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
          const w = { cv: h('canvas', { className: 'wave' }), seams: h('i', { className: 'seams' }), first: h('i', { className: 'seam-first' }), label: h('span', { className: 'label' }), sig: '', v0: 0, v1: 0 }
          waves.set(c.id, w)
          e.append(w.cv, w.seams, w.first, w.label)
        }
        e.onpointerdown = (ev) => clipDown(ev, c.id)
        e.onpointermove = (ev) => { // which handle is under the pointer drives the cursor and the edge highlight (CSS, by data-zone)
          if (ev.buttons) return
          const cur = clipsMap(doc).get(c.id)?.toJSON() as Clip | undefined
          const zone = cur && !readOnly && !lanes.get(cur.trackId)?.src && !locks.has(cur.trackId) ? clipZone(ev, e!, cur) : 'move'
          if (e!.dataset.zone !== zone) e!.dataset.zone = zone
        }
        e.addEventListener('contextmenu', (ev) => {
          ev.preventDefault()
          ev.stopPropagation() // not the lane's background menu underneath
          const trackId = String(clipsMap(doc).get(c.id)?.get('trackId'))
          if (!readOnly && !locks.has(trackId)) popover(e!, clipMenu(c.id), [ev.clientX, ev.clientY])
        })
        clipEls.set(c.id, e)
      }
      const host = lane.src ? lane.src.body : lane.body // source clips are drawn in the source lane's own scale
      const cpps = lane.src ? lane.src.pps : pps
      if (e.parentElement !== host) host.append(e)
      e.style.left = `${(c.start / rate) * cpps}px`
      // a `forever` clip is drawn out to the end of the scroll area, which its finite part alone decides
      const forever = isForever(c)
      const width = Math.max(2, ((forever ? Math.max(clipLength(c, rate), total - c.start) : clipLength(c, rate)) / rate) * cpps)
      e.style.width = `${width}px`
      e.classList.toggle('forever', forever)
      e.classList.toggle('looping', isLooping(c))
      e.classList.toggle('loopable', !readOnly && !lane.src && !locks.has(c.trackId))
      let canPlay = true
      if (c.kind === 'audio') {
        const meta = samples[c.sourceHash]
        canPlay = !!meta && playable(meta)
        const st = meta?.status // incoming and missing audio is drawn from the stored peaks (docs/engine.md §9.3)
        let label = meta ? (canPlay ? meta.name : `${meta.name} · too long to play yet`) : '…'
        if (st === 'incoming') label = `${meta.name} · ${incomingLabel(meta)}`
        else if (st === 'missing') label = `${meta.name} · audio deleted`
        e.classList.toggle('incoming', st === 'incoming')
        e.classList.toggle('missing', st === 'missing')
        const w = waves.get(c.id)!
        if (w.label.textContent !== label) w.label.textContent = label
        drawSeams(c, w, width, cpps)
        const pk = !pb || !canPlay ? undefined : st ? storedPeaks(meta, rate) : peaksFor(s.projectId, c.sourceHash, rate)
        if (pk) drawVisibleWave(c, w, pk, width, lane.src ? { pps: cpps, scroller: lane.src.view, off: 0 } : { pps, scroller: scroll, off: HEADER })
        else w.cv.style.display = 'none'
      } else drawMidiClip(e, c, notes.filter((n) => n.clipId === c.id), devices.filter((d) => d.trackId === c.trackId && DEVICES[d.type]?.instrument), c.id === editing,
        forever ? (width / cpps) * c.bpm * c.ppq / 60 : c.lengthTicks)
      e.classList.toggle('midi', c.kind === 'midi')
      e.classList.toggle('editing', c.kind === 'midi' && c.id === editing)
      e.classList.toggle('sel', selection.includes(c.id))
      e.classList.toggle('unplayable', !canPlay)
      const o = outline.get(c.id)
      e.style.outline = o ? `2px solid ${o}` : ''
    }

    // presence
    presence.replaceChildren(...[s.user, ...remote.map((r) => r.user)].map((u) =>
      h('span', { className: 'dot', title: u.username, style: `background:${u.color}` }, initials(u.username))))
    for (const e of [...overlay.querySelectorAll('.remote-head'), ...rulerHeads.querySelectorAll('.remote-head')]) e.remove()
    for (const r of remote) {
      if (r.playhead == null) continue
      const color = `background:${r.user.color}`
      overlay.append(h('div', { className: 'remote-head', style: `left:${HEADER + x(r.playhead)}px;${color}` }))
      rulerHeads.append(h('div', { className: 'remote-head', style: `left:${x(r.playhead)}px;${color}` }))
    }
    // The playhead lines run through the ruler, the lanes and the master automation, not the empty space below them.
    const last = master
    overlay.style.height = `${last.offsetTop + last.offsetHeight}px`
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
    const pass = isLooping(c) ? c.loopLength! : 0
    const phase = pass ? c.loopPhase ?? 0 : 0
    const sig = `${f.pps}|${c.sourceOffset}|${c.length}|${pass}|${phase}|${width}|${dpr}`
    if (w.sig === sig && w.pk === pk && w.v0 <= need0 && w.v1 >= need1) { w.cv.style.display = ''; return }
    const v0 = Math.max(0, Math.floor(need0 - viewW)), v1 = Math.min(width, Math.ceil(need1 + viewW))
    Object.assign(w, { sig, pk, v0, v1 })
    w.cv.style.display = ''
    w.cv.style.left = `${v0}px`
    w.cv.style.width = `${v1 - v0}px`
    w.cv.width = Math.max(1, Math.round((v1 - v0) * dpr))
    w.cv.height = Math.round(LANE_H * dpr)
    const fpp = rate / f.pps // source frames per css px
    const passPx = pass / fpp
    if (!pass || passPx < 2) return drawWave(w.cv, pk, c.sourceOffset + v0 * fpp, (v1 - v0) * fpp)
    // A looping clip draws the pass once per repeat: pass k covers clip px [k * passPx - phasePx, (k + 1) * passPx - phasePx),
    // the first (cut by the clip's start) from `phase` into the pass, the repeats faded. Each piece is drawn on a scratch
    // canvas (it must be in the document for drawWave to read the colour) and copied in.
    const phasePx = phase / fpp
    const g = w.cv.getContext('2d')!
    const tmp = h('canvas', { className: 'wave' })
    w.cv.after(tmp)
    g.clearRect(0, 0, w.cv.width, w.cv.height)
    for (let k = Math.max(0, Math.floor((v0 + phasePx) / passPx)); k * passPx - phasePx < v1; k++) {
      const s0 = Math.max(0, k * passPx - phasePx) // the piece in clip px, cut to the clip's start and to what the canvas holds
      const a = Math.max(s0, v0), b = Math.min((k + 1) * passPx - phasePx, v1)
      if (b - a < 1 / dpr) continue
      tmp.width = Math.max(1, Math.round((b - a) * dpr))
      tmp.height = w.cv.height
      drawWave(tmp, pk, c.sourceOffset + (a + phasePx - k * passPx) * fpp, (b - a) * fpp)
      g.globalAlpha = k ? 0.35 : 1
      g.drawImage(tmp, Math.round((a - v0) * dpr), 0)
    }
    g.globalAlpha = 1
    tmp.remove()
  }

  /** A looping audio clip's seams: a faint line where each pass ends, drawn as one repeating background from the first seam on. */
  function drawSeams(c: Clip & { kind: 'audio' }, w: { seams: HTMLElement; first: HTMLElement }, width: number, cpps: number) {
    const passPx = ((c.loopLength ?? 0) / rate) * cpps
    const first = (((c.loopLength ?? 0) - (c.loopPhase ?? 0)) / rate) * cpps
    const on = isLooping(c) && passPx >= 3 && first < width
    w.seams.style.display = on ? '' : 'none'
    if (!on) return
    w.seams.style.left = `${first}px`
    w.seams.style.width = `${width - first}px`
    w.seams.style.backgroundSize = `${passPx}px 100%`
    w.first.style.left = `${first - 1}px`
  }

  /**
   * Preview (label plus tiny note marks, rebuilt only when the notes change), or the open editor: the drum grid for a
   * `view: 'drums'` clip, else the piano roll. A looping clip draws its first pass in full and the repeats faded.
   */
  function drawMidiClip(e: HTMLElement, c: Clip & { kind: 'midi' }, notes: Note[], instruments: Device[], open: boolean, extent: number) {
    const editor = c.view === 'drums' ? dg : ne
    const other = editor === dg ? ne : dg
    if (other.el.parentElement === e) { other.el.remove(); other.reset() }
    if (open) {
      if (editor.el.parentElement !== e) { e.replaceChildren(editor.el); delete e.dataset.sig }
      noteSel = notesMap(doc).has(noteSel ?? '') ? noteSel : null
      if (editor === dg) dg.update(c, notes, instruments, pps, extent)
      else ne.update(c, notes, noteSel, pps, extent)
      return
    }
    if (editor.el.parentElement === e) { editor.el.remove(); editor.reset() }
    const lp = isLooping(c) ? c.loopTicks! : 0
    const sig = `${extent}|${lp}|${c.view ?? ''}|${notes.map((n) => `${n.tick},${n.durTicks},${n.pitch}`).join(';')}`
    if (e.dataset.sig === sig) return
    e.dataset.sig = sig
    const shown = lp ? notes.filter((n) => n.tick < lp) : notes
    const lo = Math.min(...shown.map((n) => n.pitch)), hi = Math.max(...shown.map((n) => n.pitch))
    const passes = lp ? Math.ceil(extent / lp) : 1
    const marks: HTMLElement[] = []
    for (let k = 0; k < passes; k++) {
      if (k) { // where the pattern starts over
        const edge = h('i', { className: 'loop-edge' })
        edge.style.left = `${((k * lp) / extent) * 100}%`
        marks.push(edge)
        if (k === 1) { // the pass handle lights up here when hovered
          const first = h('i', { className: 'seam-first' })
          first.style.left = `calc(${(lp / extent) * 100}% - 1px)`
          marks.push(first)
        }
      }
      for (const n of shown) {
        const tick = k * lp + n.tick
        if (tick >= extent) continue
        const m = h('i', { className: k ? 'mark rep' : 'mark' })
        m.style.left = `${(tick / extent) * 100}%`
        m.style.width = `${(Math.min(n.durTicks, lp || Infinity) / extent) * 100}%` // (min-width in the CSS: a % minimum is huge on a forever clip)
        m.style.top = `${hi === lo ? 50 : 20 + ((hi - n.pitch) / (hi - lo)) * 60}%`
        marks.push(m)
      }
    }
    e.replaceChildren(c.view === 'drums' ? 'drums' : 'midi', ...marks)
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

  /**
   * Where each looping clip's pass restarts (samples): one per repeat boundary inside the clip, so a clip
   * can be trimmed to land on the repeats (a `forever` clip's seams go on for ten minutes past its start).
   */
  function repeatSeams(clips: Clip[]): number[] {
    const out: number[] = []
    for (const c of clips) {
      if (!isLooping(c)) continue
      const period = passLength(c, rate)
      const phase = c.kind === 'audio' ? c.loopPhase ?? 0 : 0
      const end = c.start + (isForever(c) ? Math.max(clipLength(c, rate), 600 * rate) : clipLength(c, rate))
      out.push(...passBoundaries(c.start, period, phase, end - 1))
    }
    return out
  }

  /** The source's length in frames (audio clips can't reach past it); infinite for MIDI and unknown sources. */
  const sourceFrames = (c: Clip) => (c.kind === 'audio' ? (getSamples(doc)[c.sourceHash]?.duration ?? Infinity) * rate : Infinity)

  /**
   * Which handle of clip `c` (drawn as `el`) is under the pointer. The right edge loops (the whole height once the clip
   * loops or is open as an editor, else its upper half; the lower half trims); a looping clip's first seam has the pass
   * handle on its lower half.
   */
  function clipZone(ev: PointerEvent, el: HTMLElement, c: Clip): Grab {
    const box = el.getBoundingClientRect()
    const looping = isLooping(c)
    const open = c.kind === 'midi' && c.id === editing
    const cpps = lanes.get(c.trackId)?.src?.pps ?? pps
    const seam = looping && !open ? box.left + ((passLength(c, rate) - (c.kind === 'audio' ? c.loopPhase ?? 0 : 0)) / rate) * cpps : undefined
    return grabAt(ev.clientX, box, { y: ev.clientY, looping: looping || open, seam })
  }

  // --- clip dragging (live Yjs updates, rAF-throttled, one undo step per drag)
  function clipDown(ev: PointerEvent, id: string) {
    if (ev.button !== 0) return
    const clip = getClips(doc).find((c) => c.id === id)
    if (!clip) return
    const box = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    const mode = clipZone(ev, ev.currentTarget as HTMLElement, clip)
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
    if (readOnly || lane0?.src || locks.has(clip.trackId)) return zoom() // source audio stays anchored: only the loop windows move
    undo.stopCapturing()
    ev.preventDefault()
    const grab = ev.clientX - box.left // where in the clip it was picked up
    let curTrack = clip.trackId
    const srcFrames = sourceFrames(clip)
    const notes0 = clip.kind === 'midi' ? getNotes(doc).filter((n) => n.clipId === id) : []
    // snap targets: the timeline start, the playhead and the edges of every other clip and pad (source lanes keep their own time)
    const clips = getClips(doc).filter((c) => c.id !== id && !lanes.get(c.trackId)?.src)
    const length = clipLength(clip, rate)
    // a `forever` clip's real extent is off screen: the loop handle at its drawn end sets the extent from there
    const drawn = isForever(clip) ? (box.width / cpps) * rate : length
    const pass0 = passLength(clip, rate)
    const phase0 = clip.kind === 'audio' && isLooping(clip) ? clip.loopPhase ?? 0 : 0
    const seam0 = clip.start + pass0 - phase0
    const snapAt = snapTracker([
      0,
      Math.round(position()),
      ...clips.flatMap((c) => [c.start, c.start + clipLength(c, rate)]),
      ...getPads(doc).flatMap((p) => [p.start, p.start + p.length]),
      ...repeatSeams(clips),
      ...(mode === 'loop' ? passBoundaries(clip.start, pass0, phase0, clip.start + drawn + 600 * rate) : []), // whole passes of this clip
    ], (REARM_PX / pps) * rate)
    const snapTo = (m: PointerEvent, at: number, d: number) => { // soft-snap the handle at sample `at` (moved `d`), with the snap line
      const snap = m.altKey ? null : snapAt(at + d, 0, (SNAP_PX / pps) * rate)
      snapLine.hidden = !snap
      if (snap) snapLine.style.left = `${HEADER + x(snap.at)}px`
      return snap ? snap.at - at : d
    }
    dragPointer(ev, {
      onDrag: (m) => {
        if (!clipsMap(doc).has(id)) return
        if (mode === 'loop') return loopClip(clip, drawn + snapTo(m, clip.start + drawn, Math.round(((m.clientX - ev.clientX) / cpps) * rate)), srcFrames)
        if (mode === 'pass') {
          const d = Math.round(((m.clientX - ev.clientX) / cpps) * rate)
          return passClip(clip, pass0 + (clip.kind === 'audio' ? snapTo(m, seam0, d) : d), srcFrames)
        }
        if (mode !== 'move') {
          let d = Math.round(((m.clientX - ev.clientX) / cpps) * rate)
          // an audio clip's edge snaps to the same targets, repeat seams included, so it can be trimmed to land on them
          const snap = clip.kind !== 'audio' || m.altKey ? null : snapAt(mode === 'l' ? clip.start + d : clip.start + length + d, 0, (SNAP_PX / pps) * rate)
          if (snap) d += snap.at - (mode === 'l' ? clip.start + d : clip.start + length + d)
          snapLine.hidden = !snap
          if (snap) snapLine.style.left = `${HEADER + x(snap.at)}px`
          return trimClip(clip, mode, d, srcFrames, notes0)
        }
        // Absolute position under the pointer, in the target lane's own scale (source lanes differ).
        const hit = targetAt(m.clientY, clip.kind)
        if (hit) curTrack = hit
        const host = hostOf(curTrack)
        let start = Math.max(0, Math.round(((m.clientX - grab - host.el.getBoundingClientRect().left) / host.pps) * rate))
        const snap = m.altKey || lanes.get(curTrack)?.src ? null : snapAt(start, length, (SNAP_PX / host.pps) * rate)
        if (snap) start = snap.start
        snapLine.hidden = !snap
        if (snap) snapLine.style.left = `${HEADER + x(snap.at)}px`
        updateClip(doc, id, { start, ...(curTrack !== clip.trackId ? { trackId: curTrack } : {}) })
      },
      onEnd: (moved) => {
        snapLine.hidden = true
        undo.stopCapturing()
        if (!moved) zoom()
      },
    })
  }

  /**
   * Drag a clip's right edge to change its extent to `extent` samples; the pass repeats to fill it. A clip that wasn't
   * looping starts to, with its current length as the pass. Dragging it back to a pass or less ends the loop (isLooping),
   * and a `forever` clip stops being forever.
   */
  function loopClip(clip: Clip, extent: number, srcFrames: number) {
    const looping = isLooping(clip)
    const forever = clip.forever ? { forever: false } : {}
    if (clip.kind === 'audio') {
      updateClip(doc, clip.id, { length: Math.max(Math.round(MIN_SEC * rate), Math.round(extent)), ...(looping ? {} : startPass(clip, srcFrames)), ...forever })
      return
    }
    const step = clip.ppq / 4
    const lengthTicks = Math.max(step, Math.round((extent * clip.bpm * clip.ppq) / (60 * rate) / step) * step)
    updateClip(doc, clip.id, { lengthTicks, ...(looping ? {} : { loopTicks: clip.lengthTicks }), ...forever })
  }

  /** The fields that make a non-looping clip's current length its pass, dropping any stale pass first (its phase moves into the source offset). */
  function startPass(clip: Clip & { kind: 'audio' }, srcFrames: number) {
    const sourceOffset = clip.sourceOffset + (clip.loopLength ? clip.loopPhase ?? 0 : 0)
    return { sourceOffset, loopLength: Math.min(clip.length, srcFrames - sourceOffset), loopPhase: 0 }
  }

  /** Drag a looping clip's first seam: the pass becomes `pass` samples (audio) or ticks' worth (MIDI, in 1/16 steps) and the repeats re-tile. */
  function passClip(clip: Clip, pass: number, srcFrames: number) {
    if (clip.kind === 'audio') {
      const lo = Math.round(MIN_SEC * rate) + (clip.loopPhase ?? 0) // the first seam stays after the clip's start
      updateClip(doc, clip.id, { loopLength: Math.round(clamp(pass, lo, Math.max(lo, Math.min(clip.length, srcFrames - clip.sourceOffset)))) })
      return
    }
    const step = clip.ppq / 4
    updateClip(doc, clip.id, { loopTicks: clamp(Math.round((pass * clip.bpm * clip.ppq) / (60 * rate) / step) * step, step, clip.lengthTicks) })
  }

  /**
   * Resize a clip from either edge, non-destructively (the source audio and the notes stay whole;
   * dragging the edge back out restores them). `dSmp` is the pointer delta since the grab.
   */
  function trimClip(clip: Clip, mode: 'l' | 'r', dSmp: number, srcFrames: number, notes0: Note[]) {
    const minLength = MIN_SEC * rate
    if (clip.kind === 'audio') {
      if (isLooping(clip)) { // the left edge turns the pass instead (the seams stay put); the right edge is the loop handle
        const t = trimBlock('l', clip, dSmp, { minLength, slackLeft: clip.start })
        updateClip(doc, clip.id, { start: t.start, length: t.length, loopPhase: rotatePhase(clip.loopPhase ?? 0, t.d, clip.loopLength!) })
        return
      }
      // a stale pass (the clip was pulled back to a pass or less) goes, so trimming it longer can't start it looping
      const stale = clip.loopLength ? { loopLength: 0, loopPhase: 0 } : {}
      const sourceOffset = clip.sourceOffset + (clip.loopLength ? clip.loopPhase ?? 0 : 0)
      const t = trimBlock(mode, clip, dSmp, { minLength, slackLeft: Math.min(sourceOffset, clip.start), maxLength: srcFrames - sourceOffset })
      updateClip(doc, clip.id, { ...stale, ...(mode === 'l' ? { start: t.start, length: t.length, sourceOffset: sourceOffset + t.d } : { length: t.length, sourceOffset }) })
      return
    }
    // MIDI: lengths are in ticks, snapped to 1/16 notes
    const k = (clip.bpm * clip.ppq) / (60 * rate) // ticks per sample
    const step = clip.ppq / 4
    const dTicks = dSmp * k
    if (mode === 'r') {
      updateClip(doc, clip.id, { lengthTicks: Math.max(step, Math.round((clip.lengthTicks + dTicks) / step) * step), loopTicks: 0 }) // (clears a stale pass)
      return
    }
    // Left edge: the start moves and every note moves back by the same ticks, so the music stays put on the
    // timeline. Notes pushed before the new start go silent but are kept, and return if the edge is dragged out.
    // A looping clip's pattern turns instead: the notes rotate within the loop, so every repeat stays where it was.
    const t = trimMidiLeft(clip, dSmp, rate)
    const loop = isLooping(clip) ? clip.loopTicks! : 0
    doc.transact(() => {
      updateClip(doc, clip.id, { start: t.start, lengthTicks: t.lengthTicks })
      for (const n of notes0) updateNote(doc, n.id, { tick: loop && n.tick < loop ? rotateTick(n.tick, t.d, loop) : n.tick - t.d })
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

  // --- incoming takes (docs/engine.md §9.3)
  /** Whether this device still has the audio of an incoming take of ours (assumed while the check runs). */
  function stagedHere(hash: string) {
    if (!staged.has(hash)) {
      staged.set(hash, true)
      void hasStaged(s.projectId, hash).then((v) => v === staged.get(hash) || (staged.set(hash, v), schedule()))
    }
    return staged.get(hash)!
  }
  function incomingLabel(m: SampleMeta) {
    const mine = isMine(takeCtx(), m)
    if (mine && stagedHere(m.hash)) return 'local only · click for options'
    return `incoming from ${m.byName ?? 'someone'}${mine ? ', not on this device' : ''}`
  }
  const failed = (err: unknown) => say((err as Error).message, true)
  function clipMenu(clipId: string): [string, () => void][] {
    const items: [string, () => void][] = [['delete clip', () => { // the whole selection if this clip is in it
      const ids = selection.includes(clipId) ? [...selection] : [clipId]
      doc.transact(() => ids.forEach((id) => deleteClip(doc, id)))
      select([])
    }]]
    const clip = getClips(doc).find((c) => c.id === clipId)
    if (clip) { // looping repeats the pass to the end of the clip (drag its right edge to extend), or past it with forever
      const looping = isLooping(clip)
      items.unshift([isForever(clip) ? 'loop to end' : 'loop forever', () => {
        if (looping) return updateClip(doc, clipId, { forever: !clip.forever })
        // not looping yet: the current length becomes the pass and the extent grows to two of them, so it repeats at all
        if (clip.kind === 'audio') updateClip(doc, clipId, { ...startPass(clip, sourceFrames(clip)), length: clip.length * 2, forever: true })
        else updateClip(doc, clipId, { loopTicks: clip.lengthTicks, lengthTicks: clip.lengthTicks * 2, forever: true })
      }])
      if (looping) items.unshift(['no loop', () => { // the extent back to the first pass
        if (clip.kind === 'audio') updateClip(doc, clipId, { sourceOffset: clip.sourceOffset + (clip.loopPhase ?? 0), length: clip.loopLength! - (clip.loopPhase ?? 0), loopLength: 0, loopPhase: 0, forever: false })
        else updateClip(doc, clipId, { lengthTicks: clip.loopTicks!, loopTicks: 0, forever: false })
      }])
    }
    const hash = String(clipsMap(doc).get(clipId)?.get('sourceHash'))
    const meta = getSamples(doc)[hash]
    if (meta?.status !== 'incoming') return items
    items.length = 0 // an incoming take is saved or discarded, not just its clip deleted
    const ctx = takeCtx()
    if (isMine(ctx, meta)) {
      items.push(['save', () => {
        say('uploading take…')
        uploadTake(ctx, hash).then(() => say(''), failed)
      }])
      if (myTakes(ctx).length > 1) items.push(['save all', () => {
        say('uploading takes…')
        uploadAll(ctx).then((r) => say(r.gone ? `${r.up} uploaded, ${r.gone} not on this device` : ''), failed)
      }])
    }
    items.push(['discard', () => {
      if (!confirm(`discard "${meta.name}" and every clip that plays it?`)) return
      discardTake(ctx, hash)
      select([])
    }])
    return items
  }

  // --- file drop
  async function dropFiles(files: File[], trackId: string | null, at: number) {
    if (trackId && locks.has(trackId)) {
      say(`${locks.get(trackId)} is recording on that track`)
      return
    }
    for (const f of files) {
      say(`uploading ${f.name}…`)
      try {
        const m = await importFile(s.projectId, doc, f)
        const length = Math.round(m.duration * rate)
        doc.transact(() => {
          trackId ??= addTrack(doc, f.name.replace(/\.[^.]+$/, ''), 'audio', undefined, undefined, nextTrackColor(getTracks(doc)))
          addAudioClip(doc, { trackId, sourceHash: m.hash, start: at, length })
        })
        at += length
        say('')
      } catch (err) {
        say(`${f.name}: ${(err as Error).message}`, true)
      }
    }
  }

  // --- input
  ruler.onpointerdown = (e) => seek(fromX(e.clientX - rulerBody.getBoundingClientRect().left))
  scroll.addEventListener('scroll', schedule, { passive: true })
  addEventListener('resize', schedule)
  /** Zoom the timeline by `factor`, keeping the time under screen x `clientX` where it is. */
  function zoomAt(factor: number, clientX: number) {
    const t = (clientX - rulerBody.getBoundingClientRect().left) / pps
    pps = Math.min(MAX_PPS, Math.max(MIN_PPS, pps * factor))
    draw()
    scroll.scrollLeft += HEADER + t * pps - (clientX - scroll.getBoundingClientRect().left) - scroll.scrollLeft
  }
  scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX)
  }, { passive: false })
  // Touch pinch: two fingers zoom around their midpoint. (The page itself cannot pinch-zoom, see styles.css; handling
  // the gesture here also keeps iOS Safari from taking it as its tab-overview pinch.)
  let pinch = 0
  const spread = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
  scroll.addEventListener('touchstart', (e) => { pinch = e.touches.length === 2 ? spread(e) : 0 }, { passive: true })
  scroll.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !pinch) return
    if (e.cancelable) e.preventDefault()
    const d = spread(e)
    if (d > 0) zoomAt(d / pinch, (e.touches[0].clientX + e.touches[1].clientX) / 2)
    pinch = d
  }, { passive: false })
  scroll.addEventListener('touchend', (e) => { pinch = e.touches.length === 2 ? spread(e) : 0 }, { passive: true })
  scroll.addEventListener('touchcancel', () => (pinch = 0), { passive: true })
  /** Zoom so everything from 0 to the last clip / pad (main timeline only; source lanes have their own time) fits the visible width. */
  let fitRaf = 0
  function zoomFit(tries = 0) {
    cancelAnimationFrame(fitRaf)
    const view = scroll.clientWidth - HEADER
    if (view < 100) { // not laid out yet
      if (tries < 60) fitRaf = requestAnimationFrame(() => zoomFit(tries + 1))
      return
    }
    const scapes = new Set(getTracks(doc).filter((t) => t.kind === 'soundscape').map((t) => t.id))
    const end = Math.max(0,
      ...getClips(doc).filter((c) => !scapes.has(c.trackId)).map((c) => c.start + clipLength(c, rate)),
      ...getPads(doc).map((p) => p.start + p.length))
    pps = fitPps(end / rate, view)
    draw()
    scroll.scrollLeft = 0
  }
  /** The buttons zoom around the middle of what is visible (right of the track headers). */
  function zoomButton(factor: number) {
    const r = scroll.getBoundingClientRect()
    zoomAt(factor, r.left + HEADER + (r.width - HEADER) / 2)
  }
  const key = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'SELECT' || (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range')) return
    const mod = e.metaKey || e.ctrlKey
    if (e.code === 'Space') { e.preventDefault(); e.shiftKey ? void toggleRecord() : toggle() }
    else if (!mod && !e.shiftKey && e.key.toLowerCase() === 'z') zoomFit()
    else if (e.key === 'Escape' && (editing || armed || padSel)) { editing = null; noteSel = null; armed = null; padSel = null; draw() }
    else if (!readOnly && tag !== 'TEXTAREA' && !(e.target as HTMLElement).isContentEditable && !mod && !e.altKey && !e.repeat && cmdForKey(getKeys(), e.key.length === 1 ? e.key.toLowerCase() : e.key)) {
      e.preventDefault()
      void command(cmdForKey(getKeys(), e.key.length === 1 ? e.key.toLowerCase() : e.key)!, e.timeStamp)
    } // the loop commands, wherever the focus is not a text field
    else if (readOnly) return
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? undo.redo() : undo.undo() }
    else if (!mod && e.key.toLowerCase() === 's') {
      const at = Math.round(position())
      // (source clips have their own time axis: the playhead means nothing there)
      doc.transact(() => unlocked(selection).filter((id) => !lanes.get(String(clipsMap(doc).get(id)?.get('trackId')))?.src).forEach((id) => splitClip(doc, id, at)))
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
        doc.transact(() => unlocked(selection).forEach((id) => deleteClip(doc, id)))
        select([])
      }
    }
  }
  /** The clips not on a track someone is recording on. */
  const unlocked = (ids: string[]) => ids.filter((id) => !locks.has(String(clipsMap(doc).get(id)?.get('trackId'))))
  addEventListener('keydown', key)

  // --- sync
  const watched = [tracksMap(doc), clipsMap(doc), notesMap(doc), devicesMap(doc), loopersMap(doc), padsMap(doc), lanesMap(doc), pointsMap(doc), samplesMap(doc)]
  watched.forEach((m) => m.observeDeep(schedule))
  s.awareness.on('change', schedule)
  metaMap(doc).observe(rateChanged)
  const offPeaks = onPeaks(schedule)
  const onStatus = ({ status: st }: { status: string }) => (bar.dataset.status = st)
  s.provider?.on('status', onStatus)
  s.provider?.on('authenticationFailed', () => say('no access'))
  // After the first sync: migrate old projects (editors only: a viewer's writes never reach the server),
  // then start the engine at the project's sample rate.
  void s.synced.then(() => {
    if (destroyed) return
    if (!readOnly) {
      migrateToV2(doc)
      migrateToV3(doc)
      sweepOrphans(doc)
      stashLaneRanges(doc)
    }
    chat.markSeen()
    rate = getSampleRate(doc)
    pb = openPlayback(doc, s.projectId, rate, s.userId)
    pb.recorder.onlevel = drawLevel
    pb.oncpu = showCpu
    pb.onmeters = onMeters
    listenMidi()
    draw()
    zoomFit() // (zoom is not remembered per project, so every open fits the song to the window)
    if (!readOnly) sweepUnusedTakes(takeCtx())
    if (!readOnly) recoverTakes(takeCtx()).then((n) => {
      if (n && !destroyed) say(`recovered ${n} unfinished take${n > 1 ? 's' : ''}`)
    }, (err) => console.warn('take recovery:', err))
  })
  draw()

  return {
    el,
    destroy() {
      destroyed = true
      cancelAnimationFrame(fitRaf)
      cancelAnimationFrame(raf)
      cancelAnimationFrame(meterRaf)
      cancelAnimationFrame(previewRaf)
      removeEventListener('keydown', key)
      ne.destroy()
      removeEventListener('resize', schedule)
      offMidi()
      clearLoopTimer()
      if (take) s.setLocal({ recording: null }), take.journal.release() // (its backup is recovered on the next open)
      watched.forEach((m) => m.unobserveDeep(schedule))
      s.awareness.off('change', schedule)
      metaMap(doc).unobserve(rateChanged)
      offPeaks()
      chat.destroy()
      pb?.destroy()
    },
  }
}
