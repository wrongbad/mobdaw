// Plain absolutely-positioned DOM timeline. Isolated so it can be redesigned.
// Positions in the doc are integer samples; the UI zoom is pixels per second.
import { createZoom } from './zoom'
import {
  DEFAULT_SAMPLE_RATE, DEVICES, MASTER_TRACK, MIX_GAIN, MIX_PAN, migrateToV3, migrateToV4, migrateToV5, addClickTrack, isLooping, addMidiClip, addPad, addTrack, deleteLane, deletePad, clipEnd, clipsMap, deleteClip,
  evalPoints, getPoints, laneOf, laneState, paramToValue, resolveTarget, setLaneEnabled, 
  deleteDevice, deleteLooper, isDrum, isForever, deleteNote, getDevices, getSampleRate, getSamples, metaMap,
  getLoopers, getTracks, padsMap, getTimeMap, getMarkers, getKey, setKey, isFutureDoc, markersMap, regionsMap, migrateToV2, notesMap, splitClip, stashLaneRanges, sweepOrphans, tracksMap, 
  updateDevice, updateLooper, updateTrack, type AwarenessState, type Lane as AutoLane, type Looper, type Moving, type ParamTarget,
  type Point, type SampleMeta, type Track, type Marker, type TimeMap,
  type Role, nextTrackColor, trackColor, 
} from '@mobdaw/shared'
import { onPeaks } from '../audio/peaks'
import { shape } from '../audio/probe'
import { getInputOffset, setInputOffset } from '../audio/recording'
import { cmdForKey, getKeys } from '../midi'
import { render } from 'solid-js/web'
import { createSignal, createEffect, createMemo, createRoot, getOwner, mapArray, onCleanup, runWithOwner, untrack, type Accessor } from 'solid-js'
import type { Meters, PreviewMode } from '../audio/bridge'
import { openPlayback, type Playback } from '../audio/playback'
import { renderProject } from '../audio/render'
import { exportDialog } from './exportDialog'
import { projectMenu } from './projectMenu'
import { h } from '../dom'
import { mountScore, type ScoreView } from '../score/view'
import { icon } from '../theme/icons'
import { HEADER, applyLayout } from './layout'
import { importFile, PLAYBACK_MAX_BYTES } from '../samples'
import { discardTake, hasStaged, isMine, myTakes, recoverTakes, sweepUnusedTakes, uploadAll, uploadTake } from '../takes'
import type { Session } from '../project/session'
import { shouldAutoStop, type MeterSample } from '../audio/autoStop'
import { chatPanel } from './chat'
import { historyPanel } from './history'
import { api } from '../api'
import { automateMenu, type AutoInfo } from './automation'
import { mountLaneDrawers, type DrawCtx } from './drawers'
import { drawLiveWave } from './clipWave'
import { mountTicks } from './ticks'
import { barAtPx, mountRuler } from './ruler'
import { openRulerMenu, type RulerTarget } from './rulerMenu'
import { GHOST_MS, offGrid } from './ghost'
import { gridSnap } from './gridSnap'
import { mountLaneBody, mountSourceBody, type ClipsCtx, type SrcView } from './clips'
import { drumGrid } from './drumGrid'
import { noteEditor } from './noteEditor'
import { clamp, dragPointer } from './blocks'
import { drawRegion, sourceFrames, type GestureCtx, type LaneGeo } from './gestures'
import { closedBy, popover } from './popover'
import { transportControls, type TransportControls } from './transport'
import { mountBar } from './bar'
import { mountTrackHead, type HeadCtx, type HeadRefs } from './trackHead'
import { dragTrack, type DropItem } from './trackDrag'
import { mountRemoteHeads } from './remoteHeads'
import { follow, peakToFill } from './meter'
import { addImportedClip, automateParam, commitParam, commitParams, deleteClips, loopForever, reorderDevice, unloopClip } from '../project/actions'
import { INSTRUMENT_PRESETS, addInstrument } from '../content/presets'
import { exportProjectMidi, importSmf, isMidiFile, parseSmf } from '../content/midifile'
import { importMusicXml, isMusicXmlFile, parseMusicXml } from '../content/musicxml'
import { applyRegionEdits, tempoFromLoop } from '../audio/loopPedal'
import { createRecorder } from '../project/recorder'
import { sliderDraft } from '../project/draft'
import { createProjectStore } from '../project/store'
import { createAutoValues, createCollapsed, createDrawers, createMixDrive, createSelection, createTabAvailability, type TabName } from '../project/viewState'
import { isInSlot, moveTrack, newBus, slotFor, subtreeOf, treeRows } from '../project/buses'

/** Whether a project was last left in score mode: per project, per browser. */
const scoreMode = {
  load(projectId: string) {
    try { return localStorage.getItem(`mobdaw.score.on.${projectId}`) === '1' } catch { return false }
  },
  save(projectId: string, on: boolean) {
    try { on ? localStorage.setItem(`mobdaw.score.on.${projectId}`, '1') : localStorage.removeItem(`mobdaw.score.on.${projectId}`) } catch { /* private mode */ }
  },
}
/** A score file (MIDI or MusicXML): its parts become MIDI tracks. */
const isScoreFile = (f: Pick<File, 'name' | 'type'>) => isMidiFile(f) || isMusicXmlFile(f)
const importableFiles = (list: FileList | null | undefined) =>
  [...(list ?? [])].filter((f) => isScoreFile(f) || f.type.startsWith('audio/') || /\.(wav|mp3|ogg|flac|m4a|aac)$/i.test(f.name))

type Lane = {
  id: string
  el: HTMLElement; row: HTMLElement; body: HTMLElement; head: HeadRefs
  auto: HTMLElement // the automation section (a drawer component)
  loopTc: TransportControls // loops preview transport
  /** Soundscape tracks only: the source lane, which has its own time axis, scroll and zoom. */
  src: Src | null
}
type Src = SrcView & {
  row: HTMLElement; body: HTMLElement; ticks: HTMLElement; setPps(v: number): void
  more: HTMLElement // the drawer's label in the header cell
  tc: TransportControls // source preview transport
  playhead: HTMLElement // the preview's own playhead, in source time
  end: Accessor<number> // where the source audio ends (samples)
  setHeads(m: Map<string, number>): void
}

/** The project's name in the bar opens its settings; `renameProject`, when given, lets them change the name (it saves it). `cloud` is set for server projects. */
export function mountTimeline(s: Session, projectName: string, renameProject?: (name: string) => Promise<unknown> | void,
  cloud?: { projectId: string; me: string; role: Role; saveCopy?: () => Promise<void>; owner: boolean; locked: boolean; public: boolean; admin: boolean; demo: boolean }) {
  const { doc, undo } = s
  applyLayout()
  const baseTitle = document.title
  const setTitle = (n: string) => (document.title = n ? `${n} · ${baseTitle}` : baseTitle)
  setTitle(projectName)
  let pb: Playback | null = null // created once the doc has synced (needs meta.sampleRate)
  const sel = createSelection() // clips, the open MIDI editor, note, pad and armed looper (local UI state)
  const drawers = createDrawers() // which drawers each track (or MASTER_TRACK) has open (local UI state, all shut by default)
  const collapsed = createCollapsed() // which buses are folded shut (local UI state, all open by default)
  const staged = new Map<string, boolean>() // incoming take hash -> whether this device still has its audio
  let autoLanes: AutoLane[] = [] // as of the last change
  let autoPoints = new Map<string, Point[]>() // lane id -> its points, sorted
  let autoInfos = new Map<string, Map<string, AutoInfo>>() // owner id -> param -> what drives it
  const lanes = new Map<string, Lane>()
  /** A card is being dragged by its title bar: merged filter views split until it lands. */
  /** The user changed their snapshot (`s.snapshot`) of the document, which is not saved anywhere. */
  const [edited, setEdited] = createSignal(false)
  const [reordering, setReordering] = createSignal(false)
  let destroyed = false

  // --- static structure
  const transport = transportControls({
    title: 'play / pause (space)', onToggle: () => toggle(), onRewind: () => { seek(0); scroll.scrollLeft = 0 },
    record: s.snapshot ? undefined : { onToggle: () => void rec.toggleRecord(), onMenu: (e) => offsetMenu(e) },
  })
  const store = createProjectStore(s)
  const drive = createMixDrive() // what automation drives the faders and pans to at the playhead (written every frame while a lane plays)
  const autoValues = createAutoValues() // what automation drives each device's and looper's params to at the playhead (written every frame while a lane plays)
  const avail = createTabAvailability() // whether each header has an auto / presets tab to show
  const [status, setStatus] = createSignal({ text: '', bad: false })
  /** Show a line in the bar; `bad` marks a problem (red) rather than a note. */
  const say = (text: string, bad = false) => setStatus({ text, bad })
  const [cpu, setCpu] = createSignal<{ text: string; hot: boolean } | null>(null)
  const showCpu = (m: { load: number; peak: number }) => setCpu({ text: `cpu ${Math.round(m.load * 100)}%`, hot: m.peak >= 0.8 })
  const [loopText, setLoopText] = createSignal<string | null>(null) // (set every frame while a loop records, so only the leaf text changes)
  const [unread, setUnread] = createSignal(0)
  const [unreadMentions, setUnreadMentions] = createSignal(0)
  const [memberNames, setMemberNames] = createSignal<string[]>([])
  if (!s.local && !s.snapshot) api.project(s.projectId).then((d) => setMemberNames(d.members.map((m) => m.username)), () => {})
  const [chatOpen, setChatOpen] = createSignal(false)
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [scoreOn, setScoreOn] = createSignal(scoreMode.load(s.projectId))
  // pixels per second and the sample rate, for the bindings that place things on the timeline (the remote playheads)
  const [rate, setRate] = createSignal(DEFAULT_SAMPLE_RATE)
  const [pps, setPps] = createSignal(80)
  const scale = () => ({ pps: pps(), rate: rate() })
  // The shared timeline (docs/engine.md §2): the time map follows the regions and the meta (rate, ppq); MIDI clips are placed through it.
  const [mapVer, setMapVer] = createSignal(0)
  const tmap = (): TimeMap => (mapVer(), getTimeMap(doc))
  const [markers, setMarkers] = createSignal<Marker[]>(getMarkers(doc))
  const [keyText, setKeyText] = createSignal<string | undefined>(getKey(doc))
  /** A newer client wrote this project (schema above ours): it opens read-only, with a notice (set after the first sync). */
  const [future, setFuture] = createSignal(false)
  /** Audio clips shown as ghosts for a moment after a tempo edit moved the bars away from where they started. */
  const [ghosts, setGhosts] = createSignal<ReadonlySet<string>>(new Set())
  let ghostTimer: ReturnType<typeof setTimeout> | undefined
  let lastMap: TimeMap | null = null // (null until the first sync: loading the regions is not an edit)
  const xs = (smp: number) => (smp / rate()) * pps() // (`x`, for the bindings)
  const [ready, setReady] = createSignal(false) // the engine is open: waveforms are drawn from then on
  const [peakVer, setPeakVer] = createSignal(0) // counts the peaks that arrived
  const [stagedVer, setStagedVer] = createSignal(0) // counts the answers of which incoming takes this device still has
  const [viewW, setViewW] = createSignal(0) // the scroller's visible width and scroll (waveforms are drawn for the visible part only)
  const [scrollX, setScrollX] = createSignal(0)
  const [myTake, setMyTake] = createSignal<{ trackId: string; start: number } | null>(null, { equals: (a, b) => a?.trackId === b?.trackId && a?.start === b?.start })
  const [takePos, setTakePos] = createSignal(0) // the transport position, written every frame while a take grows
  const chat = chatPanel({
    doc, user: s.user,
    onUnread: setUnread,
    onMentions: setUnreadMentions,
    names: () => [...memberNames(), ...store.remote().map((r) => r.user.username)],
  })
  // the shared change log: only for a live cloud session (snapshots and local projects have no server to log or revert)
  const hist = s.provider ? historyPanel({
    doc,
    revert: (seq) => api.revertHistory(s.projectId, seq),
    restore: (seq) => api.restoreHistory(s.projectId, seq),
    say,
  }) : null
  /** The project's name in the bar: a button that opens the project settings (rename, sharing, audio input). */
  function projectTitle() {
    const el = h('button', { className: 'project-name', title: 'project settings', onpointerdown: (e) => e.stopPropagation(), onclick: () => {
      projectMenu(el, {
        name: projectName,
        rename: renameProject,
        onRenamed: (n) => (el.textContent = projectName = n, setTitle(n)),
        cloud: cloud && { ...cloud, onPublic: (v) => (cloud.public = v), onDemo: (v) => (cloud.demo = v) },
        sampleRate: {
          value: rate(),
          locked: isBlank() ? null : 'tracks',
          set: (r) => isBlank() && metaMap(doc).set('sampleRate', r),
        },
        key: { value: keyText(), set: (v) => setKey(doc, v), disabled: future() },
        onInputChanged: () => void rec.reopenInput(),
        onLoopBindings: () => rec.listenMidi(), // (the keys are read at each press; the input may have changed)
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
    if (!pb || next === rate()) return
    rec.resetLoops()
    pb.destroy()
    setRate(next)
    rec.forgetArmed()
    try {
      pb = openPlayback(doc, s.projectId, rate(), s.userId)
      pb.recorder.onlevel = drawLevel
      pb.oncpu = showCpu
      pb.onmeters = onMeters
      applyOverrides()
    } catch (err) {
      pb = null
      say(`sample rate: ${(err as Error).message}`, true)
    }
    setReady(!!pb)
    syncRec()
  }
  const exportProject = () => {
    if (!pb) return // (the project has not synced yet)
    exportDialog({ name: projectName, render: (o) => renderProject(doc, s.projectId, rate(), s.userId, o), midi: () => exportProjectMidi(doc, projectName) })
  }
  /** The metronome button: add a click track, then mute / unmute it. */
  function clickTrack() {
    const t = getTracks(doc).find((x) => x.role === 'click')
    if (t && !t.muted) { // switching it off tucks it away: every expandable lane and the editor shut
      drawers.closeAll(t.id)
      if (sel.editing && clipsMap(doc).get(sel.editing)?.get('trackId') === t.id) sel.editing = null
    }
    if (t) updateTrack(doc, t.id, { muted: !t.muted })
    else addClickTrack(doc)
  }
  // (chat and history share the sidebar: opening one closes the other)
  const toggleChat = () => {
    if (!chat.open && hist) (hist.setOpen(false), setHistoryOpen(false))
    chat.setOpen(!chat.open)
    setChatOpen(chat.open)
    measure() // the timeline's width changed
  }
  const toggleHistory = () => {
    if (!hist) return
    if (!hist.open) (chat.setOpen(false), setChatOpen(false))
    hist.setOpen(!hist.open)
    setHistoryOpen(hist.open)
    measure()
  }
  // Where the project lives: a phone for this device's browser storage, a cloud for the server.
  const where = h('span', { className: 'dim where', onpointerdown: (e) => e.stopPropagation(), title: s.local ? 'saved in this browser, on this device' : s.snapshot ? 'a snapshot of a cloud project: your changes are not saved' : 'saved in the cloud' })
  where.append(s.local ? icon('phone', 16) : icon('cloud', 18))
  const bar = h('header', { className: 'bar' }) // (filled by `Bar` once the recorder exists)
  const ruler = h('div', { className: 'ruler' }, h('div', { className: 'corner' }, where, projectTitle()))
  const rulerBody = h('div', { className: 'ruler-body' })
  ruler.append(rulerBody)
  const laneBox = h('div', { className: 'lanes' })
  // Background menu "Upload": files go into the clicked track at the clicked position.
  let bgTarget: { trackId: string; at: number } | null = null
  const bgPicker = h('input', { type: 'file', accept: 'audio/*', multiple: true, hidden: true })
  bgPicker.onchange = () => {
    const files = importableFiles(bgPicker.files)
    bgPicker.value = ''
    if (bgTarget && files.length) void dropFiles(files, bgTarget.trackId, bgTarget.at)
  }
  // "upload midi / musicxml" in the new-track menu: each instrument of the score becomes a track, at the playhead.
  let midiTarget: { trackId: string; at: number } | null = null // (null: new tracks at the playhead)
  const midiPicker = h('input', { type: 'file', accept: '.mid,.midi,.kar,.rmi,.musicxml,.xml,.mxl,audio/midi,audio/x-midi', multiple: true, hidden: true })
  midiPicker.onchange = () => {
    const files = [...(midiPicker.files ?? [])]
    midiPicker.value = ''
    const to = midiTarget
    midiTarget = null
    if (files.length) void dropFiles(files, to?.trackId ?? null, to?.at ?? Math.round(position()))
  }
  const addLink = h('button', { className: 'add-track', title: 'new track', onclick: () => {
    const n = getTracks(doc).length + 1
    popover(addLink, [
      ['audio', () => addTrack(doc, `track ${n}`, 'audio', undefined, undefined, nextTrackColor(getTracks(doc)))],
      ['midi', () => {
        doc.transact(() => addInstrument(doc, addTrack(doc, `midi ${n}`, 'midi', undefined, undefined, nextTrackColor(getTracks(doc))), INSTRUMENT_PRESETS[0]))
      }],
      ['soundscape', () => addTrack(doc, `soundscape ${n}`, 'soundscape', undefined, undefined, nextTrackColor(getTracks(doc)))],
      ['bus', () => void newBus(doc)],
      ['upload midi / musicxml', () => midiPicker.click()],
    ])
  } }, '+')
  const overlay = h('div', { className: 'overlay' })
  const playhead = h('div', { className: 'playhead' })
  const snapLine = h('div', { className: 'snap-line', hidden: true }) // where a dragged clip just snapped to
  // The ruler is opaque and above the overlay, so it carries its own copies of the playhead lines.
  const rulerHead = h('div', { className: 'playhead' })
  const rulerHeads = h('div', { className: 'overlay' }, rulerHead)
  overlay.append(playhead, snapLine)
  const hint = h('div', { className: 'hint dim' }, 'drop audio or midi files here, or use + track.')
  const master = h('div', { className: 'lane master', 'data-kind': 'bus' }) // the root bus: a bus lane like the others (header, drawers), closing the list (filled below)
  const dropLine = h('div', { className: 'drop-line', hidden: true }) // where a dragged track would land
  const content = h('div', { className: 'content' }, ruler, laneBox, master, hint, addLink, bgPicker, midiPicker, overlay, dropLine)
  const scroll = h('div', { className: 'scroll' }, content)
  // Drops outside any lane start a new track.
  scroll.ondragover = (e) => e.preventDefault()
  scroll.ondrop = (e) => {
    e.preventDefault()
    void dropFiles(importableFiles(e.dataTransfer?.files), null, fromX(e.clientX - rulerBody.getBoundingClientRect().left))
  }
  // The master bus closes the track list: the header of a bus (filled by `mountTrackHead` below) and its drawers, as one unit after every track.
  const masterHead = h('div', { className: 'head' })
  let masterGain: HTMLInputElement | null = null // its fader, which doubles as its level meter
  const scorePane = h('div', { className: 'score-pane' })
  const el = h('div', { className: 'timeline' }, bar, h('div', { className: 'body' }, scroll, scorePane, chat.el, ...(hist ? [hist.el] : [])))
  // The score mode swaps the tracks for sheet music; the score mounts on first use and stays while hidden (it only draws while shown).
  let score: ScoreView | null = null
  let needFit = false
  let kept = [0, 0]
  const showScore = (on: boolean) => {
    scoreMode.save(s.projectId, on)
    setScoreOn(on)
    if (on) kept = [scroll.scrollLeft, scroll.scrollTop] // (a hidden element may forget its scroll)
    scroll.hidden = on
    scorePane.hidden = !on
    if (!on) {
      if (needFit) { needFit = false; zoom.fit() }
      else [scroll.scrollLeft, scroll.scrollTop] = kept
      return
    }
    score ??= mountScore(scorePane, { doc, projectId: s.projectId })
    score.resize()
    score.setPosition(position())
  }
  scorePane.hidden = !scoreOn()
  scroll.hidden = scoreOn()

  const x = (smp: number) => (smp / rate()) * pps()
  const fromX = (px: number) => Math.max(0, Math.round((px / pps()) * rate()))
  const position = () => pb?.position() ?? 0

  const rec = createRecorder({
    s, doc, undo, rate, pb: () => pb, position: () => position(), say, onChange: () => syncRec(),
    startTransport, stop, loopStatus: () => drawLoopStatus(),
  })
  // the top bar, the remote playheads, the headers, the drawers and the blocks on the lanes are Solid components; what is left here
  // is explicit effects (below) and the per-frame loops, which only write signals or styles
  const disposers: (() => void)[] = []
  disposers.push(() => (document.title = baseTitle))
  const owner = createRoot((dispose) => (disposers.push(dispose), getOwner()!))
  const inRoot = <T,>(f: () => T) => runWithOwner(owner, f)!
  const mainClips = () => {
    const scapes = new Set(store.tracks().filter((t) => t.kind === 'soundscape').map((t) => t.id))
    return store.clips().filter((c) => !scapes.has(c.trackId))
  }
  /** Where the last clip or region of the main timeline ends (samples; 0 when empty). Source clips live in their own time world. */
  const contentEnd = inRoot(() => createMemo(() => {
    const map = tmap()
    return Math.max(0, ...mainClips().map((c) => clipEnd(c, map)), ...store.pads().map((p) => p.start + p.length))
  }))
  /** The main timeline's extent (samples): the content and 30 s more, at least a minute. */
  const total = inRoot(() => createMemo(() => Math.max(60 * scale().rate, contentEnd() + 30 * scale().rate)))
  const totalPx = inRoot(() => createMemo(() => xs(total()))) // (the automation rows are drawn at both)
  /** The track list as a tree (a bus's tracks right under it), from `order` and each track's effective parent; with the folded buses marked. */
  const rows = inRoot(() => createMemo(() => treeRows(store.tracks(), collapsed.isCollapsed)))
  // the peers' knob drags go to our engine as overrides (and show on the cards, which follow `store.drags`)
  const applyOverrides = () => pb?.setOverrides(store.overrides())
  const headCtx: HeadCtx = {
    doc, undo, store, rec, drawers, avail, drive, collapsed, toggleTab, autoMenu,
    live: (d, p, v) => cardDeps.live(d, p, v), drag: (d) => cardDeps.drag(d), commit: (d, p, v) => cardDeps.commit(d, p, v),
  }
  disposers.push(
    mountBar(bar, { score: { on: scoreOn, onToggle: () => showScore(!scoreOn()) }, store, live: !!s.provider, snapshot: s.snapshot, user: s.user, transport: transport.el, status, cpu, loopText, unread, mentions: unreadMentions, chatOpen, history: hist ? { open: historyOpen, onToggle: toggleHistory } : undefined, notice: () => (future() ? 'made with a newer version: read-only. reload the page for the latest.' : null),
      onStatus: () => status().text && alert(status().text), onClickTrack: clickTrack, onZoom: (f) => zoom.button(f), onExport: exportProject, onChat: toggleChat,
      saveCopy: cloud?.saveCopy && { shown: edited, onSave: () => {
        say('saving a copy on this device…')
        cloud.saveCopy!().catch((err) => say(`could not save a copy: ${(err as Error).message}`, true))
      } } }),
    mountRemoteHeads(overlay, { store, offset: HEADER, scale }),
    mountRemoteHeads(rulerHeads, { store, offset: 0, scale }),
    (() => { const m = mountTrackHead(masterHead, headCtx, MASTER_TRACK); masterGain = m.refs.gain; return m.dispose })(),
    createRoot((dispose) => (createEffect(() => (store.overrides(), applyOverrides())), dispose)),
  )
  const ne = noteEditor({
    doc, undo, store,
    selectNote: (id) => sel.selectNote(id),
    noteLive: (trackId, pitch, velocity, on) => liveNote(trackId, pitch, velocity, on),
  })
  const dg = drumGrid({ doc, undo, store })

  // --- transport
  // Auto-stop (audio/autoStop.ts): the master reports and the live notes it needs; decided in `tick`.
  let playedAt = 0
  const masterSeen: MeterSample[] = []
  let noteAt = -Infinity // no live-note state in the engine API: held keys are counted here, with a recency guard
  let held = 0
  const liveNote = (trackId: string, pitch: number, velocity: number, on: boolean) => {
    held = Math.max(0, held + (on ? 1 : -1))
    noteAt = performance.now()
    pb?.noteLive(trackId, pitch, velocity, on)
  }
  const autoStopNow = (now: number) => shouldAutoStop({
    now, since: playedAt, position: position(), end: contentEnd(), busy: rec.busy, armed: !!rec.armedTrack, monitoring: rec.monitoring,
    forever: mainClips().some(isForever), loopers: store.loopers().some((l) => pb?.looperHead(l.id) != null), held, noteAt,
  }, masterSeen)
  function toggle() {
    if (!pb) return
    if (pb.playing) stop()
    else startTransport()
  }
  function startTransport(from?: number) {
    if (!pb?.playing) { pb?.play(from); playedAt = performance.now() }
    transport.setPlaying(true)
    tick()
    ensurePreviewTick() // the loopers' playheads
  }
  function stop() {
    rec.stop(() => {
      pb?.stop()
      transport.setPlaying(false)
      score?.setPosition(position())
      ensurePreviewTick() // let the loopers' playheads clear
    })
  }

  const fmtSec = (smp: number) => `${(smp / rate()).toFixed(1)}s`
  /** The top bar's loop status: only while a loop records. */
  function drawLoopStatus() {
    const st = rec.loops?.status(position())
    setLoopText(!st ? null : st.free ? `rec loop · ${fmtSec(st.samples)}` : `rec loop · ${st.stopping ? 'ends' : 'edge'} in ${fmtSec(st.samples)}`)
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
    masterSeen.push({ at: performance.now(), peak: m.master })
    if (masterSeen.length > 64) masterSeen.shift()
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
      const fader = id === MASTER_TRACK ? masterGain : lanes.get(id)?.head.gain
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
    const input = pb?.recorder
    const l = rec.armedTrack ? lanes.get(rec.armedTrack) : undefined
    const meter = l?.head.meter
    if (!input || !meter) return
    meter.style.setProperty('--lv', String(shape(input.level)))
    meter.classList.toggle('clipping', input.clipped) // (not 'clip': that is the timeline clips' class, with its own ::before)
  }

  /** A take's state changed: the armed track may be gone, the record button follows, and so does the growing region. */
  function syncRec() {
    rec.sync(new Set(store.tracks().map((t) => t.id)))
    transport.setRecord(!!rec.armedTrack, !!rec.take)
    syncTake()
  }
  function syncTake() {
    const t = rec.take
    setMyTake(t ? { trackId: t.trackId, start: t.start } : null)
    if (t) setTakePos(position())
  }
  let lastAware = 0
  function tick() {
    if (destroyed || !pb?.playing) return
    // A take over the playback limit couldn't be played back: end it there (16-bit, so 2 bytes a sample).
    if (rec.take && (position() - rec.take.start) * pb.recorder.info!.channels * 2 >= PLAYBACK_MAX_BYTES - 1024 * 1024) {
      stop()
      say('take stopped: it reached the longest take that can be played back yet')
      return
    }
    drawPlayhead()
    const now = performance.now()
    if (autoStopNow(now)) return stop()
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
    transport.setTime(p / rate())
    score?.setPosition(p)
    if (myTake()) setTakePos(p) // (the growing region follows)
    drawLoopStatus()
  }
  function seek(smp: number) {
    if (rec.take) return // a take is one continuous stretch of the timeline
    pb?.seek(smp)
    drawPlayhead()
  }

  const cardDeps = {
    live: (d: string, p: number, v: number) => pb?.live(d, p, v),
    drag: (d: AwarenessState['dragging']) => s.setLocal({ dragging: d }),
    commit: (d: string, p: number, v: number) => commitParam(doc, undo, d, p, v),
    commitMany: (d: string, values: Record<number, number>) => commitParams(doc, undo, d, values),
    bypass: (d: string, b: boolean) => updateDevice(doc, d, { bypass: b }),
    setInput: (d: string, input: string | undefined) => updateDevice(doc, d, { input }),
    setName: (d: string, name: string) => updateDevice(doc, d, { name }),
    remove: (d: string) => deleteDevice(doc, d),
    rename: (d: string) => {
      const dev = getDevices(doc).find((x) => x.id === d)
      const name = dev && prompt('name', dev.name ?? DEVICES[dev.type]?.name ?? '')?.trim()
      if (name) updateDevice(doc, d, { name })
    },
    reorderStart: () => setReordering(true),
    reorderEnd: () => setReordering(false),
    reorderDrop: (d: string, before: string | null) => reorderDevice(doc, undo, d, before),
  }
  const slide = sliderDraft(store, doc, undo) // the sliders' live values: shown and sent to the peers at once, written when one lets go
  const loopDeps = {
    live: (id: string, patch: Partial<Looper>) => {
      slide.set({ loopers: { [id]: patch } })
      pb?.liveLooper(id, patch) // (the engine applies it now, smoothed)
    },
    release: slide.release,
    setMuted: (id: string, muted: boolean) => updateLooper(doc, id, { muted }),
    autoMenu: (label: HTMLElement, t: ParamTarget) => autoMenu(label, () => t),
    toggleArm: (id: string) => sel.toggleArm(id),
    clear: (id: string) => updateLooper(doc, id, { start: 0, length: 0 }),
    remove: (id: string) => { sel.forgetLooper(id); deleteLooper(doc, id) },
  }

  // --- automation: lanes (one per automated param) live in a collapsible section per track, and one for the global fx
  const rowDeps = {
    doc, x, fromX,
    live: (d: Moving) => {
      slide.set(d)
      for (const [id, p] of Object.entries(d.lanes ?? {})) p && pb?.liveLane(id, p)
      for (const [id, p] of Object.entries(d.points ?? {})) p && pb?.livePoint(id, p)
    },
    release: slide.release, get rate() { return getSampleRate(doc) },
    snap: (smp: number) => gridSnap(tmap(), smp, pps()) ?? smp, // (automation points snap to the bar grid; in a free region they stay where they are)
  }
  const drawCtx: DrawCtx = { ...headCtx, auto: autoValues, deps: cardDeps, reordering, loops: loopDeps, rows: rowDeps, armed: () => sel.armedLooper, width: totalPx, scale }
  const masterBody = busBody(MASTER_TRACK)
  master.append(h('div', { className: 'lane-row master-row' }, masterHead, masterBody.el))
  const masterDrawers = mountLaneDrawers(master, drawCtx, MASTER_TRACK, 'bus') // (the drawers follow the row)
  disposers.push(masterDrawers.dispose, masterBody.dispose)

  function autoMenu(label: HTMLElement, target: () => ParamTarget, clickToo = true) {
    const lane = () => laneOf(doc, target())
    automateMenu(label, {
      state: () => { const l = lane(); return !l ? 'none' : l.enabled ? 'on' : 'off' },
      automate: () => automate(target()),
      lfo: () => automate(target(), true),
      show: () => reveal(target().scope),
      toggle: () => { const l = lane(); if (l) setLaneEnabled(doc, l.id, !l.enabled) },
      remove: () => { const l = lane(); if (l) deleteLane(doc, l.id) },
    }, clickToo)
  }

  /** Automate a param: a lane that starts flat at its current value, so nothing changes until a point is moved (or, with `lfo`, one in LFO mode). */
  function automate(t: ParamTarget, lfo = false) {
    if (!automateParam(doc, t, lfo)) return
    reveal(t.scope)
  }

  function reveal(scope: string) {
    for (const a of rows().find((r) => r.id === scope)?.ancestors ?? []) collapsed.set(a, false) // (not inside a folded bus)
    drawers.open(scope, 'auto')
    ;(scope === MASTER_TRACK ? masterDrawers.refs.auto : lanes.get(scope)?.auto)?.scrollIntoView({ block: 'nearest' })
  }

  /** The tab to open or shut one drawer of a track (or MASTER_TRACK): the one way in. */
  function toggleTab(id: string, n: TabName) {
    if (!drawers.toggle(id, n)) {
      if (n === 'source' || n === 'loopers') { // the transport is about to be hidden: don't leave it playing
        const pv = pb?.preview(id, n === 'source' ? 'source' : 'loops')
        if (pv?.playing) pv.stop()
      }
    }
    refreshPreviews()
  }

  /** The lanes and their points (and what they drive at the playhead) follow the store. */
  function loadAuto() {
    autoLanes = store.lanes().map((l) => ({ ...l }))
    autoPoints = new Map()
    for (const p of store.points()) {
      const q = { ...p } // (reading every field: a moved point reloads)
      ;(autoPoints.get(q.laneId) ?? autoPoints.set(q.laneId, []).get(q.laneId)!).push(q)
    }
    for (const list of autoPoints.values()) list.sort((a, b) => a.pos - b.pos)
    void [store.devices().length, store.loopers().length]
    untrack(() => (readAuto(), publishMix()))
  }
  inRoot(() => createEffect(loadAuto))

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
    autoValues.publish(autoInfos)
  }
  /** The playhead moved: hand the controls a lane drives their values (they follow by themselves). */
  function refreshAuto() {
    readAuto()
    publishMix()
  }
  /** What the automation lanes drive each scope's fader and pan to, for the headers (they show the doc's value where nothing drives). */
  function publishMix() {
    for (const scope of [MASTER_TRACK, ...store.tracks().map((t) => t.id)]) {
      const auto = autoInfos.get(store.mixDevice(scope)?.id ?? '')
      const at = (p: number) => {
        const a = auto?.get(String(p))
        return a?.on && a.value != null ? a.value : null
      }
      drive.set(scope, { gain: at(MIX_GAIN), pan: at(MIX_PAN) })
    }
  }

  /** A bus's lane body (and the master's): no clips, a note of what is in it that also folds it (click). */
  function busBody(id: string) {
    const note = h('span', { className: 'bus-note' })
    const el = h('div', { className: 'lane-body bus-body', 'data-track': id }, note)
    if (id !== MASTER_TRACK) el.onclick = (e) => { if (e.target === el || e.target === note) collapsed.toggle(id) }
    const dispose = createRoot((dispose) => {
      createEffect(() => (el.style.width = `${totalPx()}px`))
      createEffect(() => {
        const all = rows()
        const n = id === MASTER_TRACK ? all.length : all.find((r) => r.id === id)?.below ?? 0
        const what = `${n} ${n === 1 ? 'track' : 'tracks'}`
        note.textContent = n === 0 ? (id === MASTER_TRACK ? 'no tracks yet' : 'empty: move tracks in from their menu') : collapsed.isCollapsed(id) ? `${what} folded` : id === MASTER_TRACK ? `${what} in total` : what
      })
      return dispose
    })
    return { el, dispose }
  }

  /** Dragging a track header (docs/routing.md): the lanes it hit-tests, the line it shows, and the write on the drop. */
  const dragDeps = {
    items: (id: string): DropItem[] => {
      const sub = subtreeOf(rows(), id)
      return rows().filter((r) => !r.hidden && !sub.has(r.id) && lanes.has(r.id)).map((r) => {
        const b = lanes.get(r.id)!.el.getBoundingClientRect()
        return { id: r.id, top: b.top, bottom: b.bottom, bus: r.bus, expanded: r.bus && r.kids > 0 && !collapsed.isCollapsed(r.id) }
      })
    },
    moving: (id: string) => {
      const sub = subtreeOf(rows(), id)
      return rows().filter((r) => !r.hidden && sub.has(r.id)).flatMap((r) => lanes.get(r.id)?.el ?? [])
    },
    preview: (id: string, a: { id: string; at: 'before' | 'after' | 'start' | 'end' }) => {
      const tracks = getTracks(doc)
      const slot = slotFor(tracks, id, a)
      if (!slot || isInSlot(tracks, id, slot)) return null
      const top = content.getBoundingClientRect().top
      const box = (a.id === MASTER_TRACK ? laneBox : lanes.get(a.id)?.el)?.getBoundingClientRect()
      if (!box) return null
      const y = (a.at === 'before' ? box.top : box.bottom) - top + (a.at === 'before' ? -3 : 1)
      return { y, depth: slot.parent === MASTER_TRACK ? 0 : (rows().find((r) => r.id === slot.parent)?.depth ?? 0) + 1 }
    },
    drop: (id: string, a: { id: string; at: 'before' | 'after' | 'start' | 'end' }) => {
      if (future()) return
      const slot = slotFor(getTracks(doc), id, a)
      if (slot && moveTrack(doc, id, slot) && slot.parent !== MASTER_TRACK) collapsed.set(slot.parent, false) // (it lands where you can see it)
    },
    scroller: scroll,
    line: dropLine,
  }

  /** The lane of a track: its header, body (clips or regions), source lane and drawers. Made once for each track (by `mapArray`). */
  function laneFor(t: Track, index: Accessor<number>): Lane {
    const head = h('div', { className: 'head' })
    const mounted = mountTrackHead(head, headCtx, t.id)
    const isBus = t.kind === 'bus'
    const busRow = isBus ? busBody(t.id) : null // a bus has no clips: its lane body is a note that folds it
    const body = busRow?.el ?? h('div', { className: 'lane-body', 'data-track': t.id })
    body.onpointerdown = (e) => {
      if (e.target !== body || isBus) return
      sel.clickEmptyLane()
      select([])
    }
    const atX = (e: MouseEvent) => fromX(e.clientX - body.getBoundingClientRect().left)
    body.ondblclick = (e) => { // empty space on a MIDI lane: new 4-bar clip
      if (e.target !== body || t.kind !== 'midi') return
      newMidiClip(t.id, atX(e))
    }
    if (!isBus) body.ondragover = (e) => e.preventDefault()
    if (!isBus) body.ondrop = (e) => {
      e.preventDefault()
      e.stopPropagation()
      const kind = tracksMap(doc).get(t.id)?.get('kind')
      const at = fromX(e.clientX - body.getBoundingClientRect().left)
      const files = importableFiles(e.dataTransfer?.files)
      // a score merges into a MIDI lane; audio only lands on an audio lane (elsewhere it starts a new track)
      void dropFiles(files.filter(isScoreFile), kind === 'midi' ? t.id : null, at)
      void dropFiles(files.filter((f) => !isScoreFile(f)), kind === 'audio' ? t.id : null, at)
    }
    // background menu: audio lanes take uploads; MIDI lanes and soundscapes make a new region
    if (t.kind === 'audio') bgMenu(body, (e) => [['upload', () => pickInto(t.id, atX(e))]])
    else if (t.kind === 'midi') bgMenu(body, (e) => [['new piano roll', () => newMidiClip(t.id, atX(e))], ['new drum grid', () => newMidiClip(t.id, atX(e), true)], ['upload midi / musicxml', () => { midiTarget = { trackId: t.id, at: atX(e) }; midiPicker.click() }]])
    else if (t.kind === 'soundscape') bgMenu(body, (e) => [['new region', () => newPad(t.id, atX(e))]])
    // soundscape tracks: the main lane is blank like an empty track (regions turn the loopers on); the source audio gets its own lane
    const src: Src | null = t.kind === 'soundscape' ? sourceLane(t.id) : null
    const loopTc = transportControls({ title: 'play / stop the loops', small: true, onToggle: () => togglePreview(t.id, 'loops') })
    const row = h('div', { className: 'lane-row' }, head, body)
    const el = h('div', { className: 'lane' }, row, src?.row ?? null)
    const drawn = mountLaneDrawers(el, drawCtx, t.id, t.kind, loopTc) // (the drawers follow the rows: instruments, loopers, effects, automation, presets)
    const offBlocks = [isBus ? busRow!.dispose : mountLaneBody(body, clipsCtx, t.id, t.kind), src ? mountSourceBody(src.body, clipsCtx, t.id, src) : () => {}]
    dragTrack(head, t.id, dragDeps)
    const l: Lane = { id: t.id, el, row, body, head: mounted.refs, auto: drawn.refs.auto, loopTc, src }
    // the lane's own classes follow the doc, the peers' recordings, the loop pedal and the editor
    el.dataset.kind = t.kind
    createEffect(() => el.style.setProperty('--tc', trackColor(t, index())))
    createEffect(() => el.classList.toggle('locked', store.locks().has(t.id)))
    createEffect(() => el.classList.toggle('current', rec.currentTrack === t.id))
    createEffect(() => el.classList.toggle('muted', !!store.trackById[t.id]?.muted))
    const editClip = createMemo(() => (sel.editing ? store.clipById[sel.editing] : undefined))
    const editing = () => editClip()?.trackId === t.id
    const gridRows = createMemo(() => { // -1: the piano roll
      const c = editClip()
      return editing() && c?.kind === 'midi' && c.view === 'drums' ? store.devicesByTrack(t.id)().filter((d) => isDrum(d)).length : -1
    })
    createEffect(() => {
      el.classList.toggle('editing', editing())
      el.classList.toggle('drums', gridRows() >= 0) // the lane fits the drum grid instead of the piano roll
      if (gridRows() >= 0) el.style.setProperty('--dg-rows', String(gridRows()))
    })
    createEffect(() => (body.style.width = `${totalPx()}px`))
    if (src) {
      createEffect(() => {
        const open = drawers.isOpen(t.id, 'source')
        src.row.hidden = !open
        src.more.classList.toggle('on', open)
      })
      createEffect(() => {
        const r = scale().rate
        src.body.style.width = `${(Math.max(60 * r, src.end() + 30 * r) / r) * src.pps()}px`
      })
      createEffect(() => src.body.classList.toggle('arming', store.loopers().some((x) => x.trackId === t.id && x.id === sel.armedLooper)))
      createEffect(() => (src.pps(), untrack(refreshPreviews))) // (its playhead is placed in source px)
      offBlocks.push(mountTicks(src.ticks, { totalSec: () => Math.max(60 * scale().rate, src.end() + 30 * scale().rate) / scale().rate, pps: src.pps }))
    }
    lanes.set(t.id, l)
    onCleanup(() => {
      lanes.delete(t.id)
      el.remove()
      offBlocks.forEach((f) => f())
      drawn.dispose()
      mounted.dispose()
    })
    return l
  }

  // --- soundscape previews: each soundscape's source and loops have a private transport/playhead
  function togglePreview(trackId: string, mode: PreviewMode) {
    const pv = pb?.preview(trackId, mode)
    if (!pv) return
    if (pv.playing) pv.stop()
    else {
      const end = lanes.get(trackId)?.src?.end() ?? 0
      // loops always start from their beginning; the source resumes unless it already ran out
      pv.play(mode === 'loops' || pv.position() >= end ? 0 : undefined)
    }
    refreshPreviews()
    ensurePreviewTick()
  }

  /** One thin playhead per sounding looper (the lane's heads follow what is written here). */
  function drawLoopHeads(): boolean {
    let shown = false
    for (const [trackId, l] of lanes) {
      if (!l.src) continue
      const heads = new Map<string, number>()
      for (const lp of store.loopers()) {
        const pos = lp.trackId === trackId ? pb?.looperHead(lp.id) : null
        if (pos != null) heads.set(lp.id, pos)
      }
      shown ||= heads.size > 0
      l.src.setHeads(heads)
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
      if (src.playing && src.position() > l.src.end()) src.stop() // ran off the end of the audio
      const sp = src.position(), lp = loops.position()
      l.src.tc.setPlaying(src.playing)
      l.src.tc.setTime(sp / rate())
      l.src.playhead.hidden = !src.playing && sp === 0
      l.src.playhead.style.left = `${(sp / rate()) * l.src.pps()}px`
      l.loopTc.setPlaying(loops.playing)
      l.loopTc.setTime(lp / rate())
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

  /**
   * Left or right click on a lane's empty background opens a menu of `entries(event)` at the cursor.
   * (Upload for lanes that hold audio, "New region" for MIDI lanes and soundscapes.)
   */
  function bgMenu(body: HTMLElement, entries: (e: MouseEvent) => [string, () => void][]) {
    let down: { x: number; y: number; armed: boolean; closed: boolean } | null = null
    // (the popover's own capture listener runs first, so `closedBy` says whether this press closed a menu)
    body.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, armed: !!sel.armedLooper, closed: closedBy(e) }), true)
    const open = (e: MouseEvent) => {
      if (e.target === body) popover(body, entries(e), [e.clientX, e.clientY])
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

  /**
   * A drum grid clip is a one-bar pattern looped across four bars; a piano roll clip is four bars, unlooped. The bars are the
   * timeline's (a 7/8 bar is a 7/8 bar), and a clip made in a metered region starts on a bar line.
   */
  function newMidiClip(trackId: string, at: number, drums = false) {
    const map = tmap()
    const tick = gridSnapTickBar(map, map.sampleToTick(at))
    const bar = map.position(tick).bar
    const lengthTicks = map.barStart(bar + 4) - map.barStart(bar)
    const id = addMidiClip(doc, { trackId, startTick: tick, lengthTicks, ...(drums ? { view: 'drums', loopTicks: map.meterAt(bar).barTicks } : {}) })
    sel.editing = id
    select([id])
  }
  /** A tick moved to the nearest bar line, or left alone inside a free region. */
  const gridSnapTickBar = (map: TimeMap, tick: number) => map.snapTick(tick, 'bar') ?? tick

  /** A soundscape region: a block on the main lane during which all of the loopers are on. */
  function newPad(trackId: string, at: number) {
    sel.pad = addPad(doc, trackId, gridSnap(tmap(), at, pps()) ?? at, 2 * rate())
    select([])
  }

  /** A soundscape's source lane: its own time axis, scroll and zoom (its blocks are `mountSourceBody`). */
  function sourceLane(trackId: string): Src {
    const [pps, setPps] = createSignal(80)
    const [scrollX, setScrollX] = createSignal(0)
    const [heads, setHeads] = createSignal(new Map<string, number>(), { equals: (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v) })
    /** Where the source audio ends (samples): the end of its last clip. */
    const end = createMemo(() => Math.max(0, ...store.clipsByTrack(trackId)().map((c) => clipEnd(c, tmap()))))
    const ticks = h('div', { className: 'src-ticks' })
    const body = h('div', { className: 'lane-body src-body', 'data-track': trackId }, ticks)
    const view = h('div', { className: 'src-view' }, body)
    const tc = transportControls({ title: 'play / pause the source audio', small: true, onToggle: () => togglePreview(trackId, 'source') })
    const more = h('div', { className: 'fx-toggle' }, 'source')
    const head = h('div', { className: 'head src-head' }, more, tc.el)
    const playhead = h('div', { className: 'playhead', hidden: true })
    body.append(playhead)
    const src: Src = { row: h('div', { className: 'lane-row src-row' }, head, view), view, body, ticks, pps, setPps, scrollX, heads, setHeads, end, more, tc, playhead }
    const at = (clientX: number) => Math.max(0, Math.round(((clientX - body.getBoundingClientRect().left) / pps()) * rate()))
    // click or drag on the source ruler to move its playhead (the main transport is unaffected)
    ticks.onpointerdown = (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const seek = (cx: number) => {
        pb?.preview(trackId, 'source').seek(at(cx))
        refreshPreviews()
      }
      seek(e.clientX)
      dragPointer(e, { onDrag: (m) => seek(m.clientX), immediate: true }) // (a finger scrubs at once, no long press)
    }
    body.onpointerdown = (e) => {
      if (e.target !== body) return
      sel.clickEmptySource()
      select([])
    }
    body.ondragover = (e) => e.preventDefault()
    body.ondrop = (e) => {
      e.preventDefault()
      e.stopPropagation()
      void dropFiles(importableFiles(e.dataTransfer?.files), trackId, at(e.clientX))
    }
    bgMenu(body, (e) => [['upload', () => pickInto(trackId, at(e.clientX))]])
    view.addEventListener('scroll', () => setScrollX(view.scrollLeft), { passive: true })
    view.addEventListener('wheel', (e) => { // zoom this lane only
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      const t = (e.clientX - body.getBoundingClientRect().left) / pps()
      setPps(clamp(pps() * Math.exp(-e.deltaY * 0.01), 10, 800))
      view.scrollLeft += t * pps() - (e.clientX - view.getBoundingClientRect().left) - view.scrollLeft
    }, { passive: false })
    // while a looper is armed, a drag here draws its region (capture: clips must not start a drag)
    body.addEventListener('pointerdown', (e) => {
      const lp = sel.armedLooper ? store.loopers().find((x) => x.id === sel.armedLooper && x.trackId === trackId) : undefined
      if (!lp || e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      drawRegion(gctx, e, { ...lp }, src)
    }, true)
    return src
  }

  function select(ids: string[]) {
    sel.selectClips(ids)
    s.setLocal({ selection: ids })
  }

  const zoom = createZoom({
    scroll, rulerBody, header: HEADER, store, sel, rate, map: tmap, pps, isSource: (id) => !!lanes.get(id)?.src,
    setPps,
  })

  // the gestures and the blocks on the lanes see the layout through these
  const geo: GestureCtx['geo'] = {
    rate, map: tmap, pps, position, content,
    lane: (id): LaneGeo | undefined => lanes.get(id),
    lanes: () => lanes.entries(),
    snapLine: (at) => {
      snapLine.hidden = at == null
      if (at != null) snapLine.style.left = `${HEADER + x(at)}px`
    },
  }
  const gctx: GestureCtx = { doc, undo, store, sel, geo, select }
  const clipsCtx: ClipsCtx = {
    ...gctx, scale, map: tmap, ghosts, total, ready, peaks: peakVer, viewW, scrollX, scroller: scroll, header: HEADER, projectId: s.projectId, ne, dg,
    menu: (id) => clipMenu(id), incomingLabel: (m) => incomingLabel(m), myTake, position: takePos,
    drawLive: (region, startPx, widthPx) => pb && drawLiveWave(region, pb.recorder.peaks, { startPx, widthPx, header: HEADER, scroller: scroll, rate: rate(), pps: pps() }),
  }

  // --- layout: explicit effects, each following what it reads (no pass over the whole project)
  /** The playhead lines run through the ruler, the lanes and the master automation, not the empty space below them. */
  const layout = () => (overlay.style.height = `${master.offsetTop + master.offsetHeight}px`)
  /** The scroller's visible size (resize, the chat panel opening). */
  function measure() {
    setViewW(scroll.clientWidth)
    setScrollX(scroll.scrollLeft)
    scroll.style.setProperty('--view', `${scroll.clientWidth}px`)
    layout()
  }
  inRoot(() => {
    createEffect(() => {
      content.style.width = `${HEADER + totalPx()}px`
      rulerBody.style.width = `${totalPx()}px`
    })
    createEffect(() => (hint.hidden = store.tracks().length > 0))
    createEffect(() => el.classList.toggle('future', future()))
    createEffect(() => (store.tracks(), untrack(syncRec))) // (the armed track may have been deleted)
    createEffect(() => zoom.editing(sel.editing))
    // what the selection points at may be gone from the doc (the doc is asked as well: a just-made entity may not have reached the store yet)
    createEffect(() => sel.pruneEditing((id) => (void store.clipById[id], clipsMap(doc).get(id)?.get('kind') === 'midi')))
    createEffect(() => sel.pruneClips((id) => (void store.clipById[id], clipsMap(doc).has(id))))
    createEffect(() => sel.prunePad((id) => (void store.padById[id], padsMap(doc).has(id))))
    createEffect(() => sel.pruneNote((id) => (void store.noteById[id], notesMap(doc).has(id) || !!store.noteById[id])))
    disposers.push(mountRuler(rulerBody, {
      map: tmap, markers, keyText, pps, scrollX, viewW, after: rulerHeads,
      onMenu: (t, at, el) => rulerMenu(t, at, el),
    }))
    // one lane per track, made once; the DOM order, nesting marks and folding follow the tree
    const made = createMemo(mapArray(() => store.tracks(), (t: Track, i: Accessor<number>) => laneFor(t, i)))
    createEffect(() => {
      const byId = new Map(made().map((l) => [l.id, l]))
      const flat = new Map(store.tracks().map((t, i) => [t.id, i]))
      const colour = (id: string) => trackColor(store.trackById[id] ?? {}, flat.get(id) ?? 0)
      let at = laneBox.firstElementChild
      for (const r of rows()) {
        const l = byId.get(r.id)
        if (!l) continue
        if (at === l.el) at = at.nextElementSibling
        else laneBox.insertBefore(l.el, at)
        l.el.hidden = r.hidden
        l.el.dataset.depth = String(r.depth)
        l.el.classList.toggle('in-bus', r.depth > 0)
        l.el.classList.toggle('bus-first', r.depth > 0 && rows().find((x) => x.parent === r.parent)?.id === r.id)
        l.el.style.setProperty('--depth', String(r.depth))
        l.el.style.setProperty('--bands', r.ancestors.map((a, k) => `inset ${4 * (k + 1)}px 0 0 ${colour(a)}`).join(', ') || 'inset 0 0 0 transparent')
        l.el.classList.toggle('folded', r.bus && collapsed.isCollapsed(r.id))
      }
    })
  })

  // --- incoming takes (docs/engine.md §9.3)
  /** Whether this device still has the audio of an incoming take of ours (assumed while the check runs). */
  function stagedHere(hash: string) {
    if (!staged.has(hash)) {
      staged.set(hash, true)
      void hasStaged(s.projectId, hash).then((v) => v === staged.get(hash) || (staged.set(hash, v), setStagedVer((n) => n + 1)))
    }
    return staged.get(hash)!
  }
  function incomingLabel(m: SampleMeta) {
    stagedVer() // (the label follows the check)
    const mine = isMine(rec.takeCtx(), m)
    if (mine && stagedHere(m.hash)) return 'local only · click for options'
    return `incoming from ${m.byName ?? 'someone'}${mine ? ', not on this device' : ''}`
  }
  const failed = (err: unknown) => say((err as Error).message, true)
  function clipMenu(clipId: string): [string, () => void][] {
    const items: [string, () => void][] = [['delete clip', () => { // the whole selection if this clip is in it
      const ids = sel.clips.includes(clipId) ? [...sel.clips] : [clipId]
      deleteClips(doc, ids)
      select([])
    }]]
    const found = store.clipById[clipId]
    const clip = found && { ...found }
    if (clip) { // looping repeats the pass to the end of the clip (drag its right edge to extend), or past it with forever
      const looping = isLooping(clip)
      items.unshift([isForever(clip) ? 'loop to end' : 'loop forever', () => loopForever(doc, clip, clip.kind === 'audio' ? sourceFrames(store, rate(), clip) : 0)])
      if (looping) items.unshift(['no loop', () => unloopClip(doc, clip)]) // the extent back to the first pass
      // a free loop can found the grid: its pass becomes N bars of a metered region from where it starts
      const plan = clip.kind === 'audio' && clip.loopLength ? tempoFromLoop(tmap(), { start: clip.start, length: clip.loopLength }) : null
      if (plan) items.push([`tempo from loop (${plan.bars} bar${plan.bars > 1 ? 's' : ''} at ${Math.round(plan.bpm * 10) / 10} bpm)`, () => applyRegionEdits(doc, plan.edits)])
    }
    const hash = String(clipsMap(doc).get(clipId)?.get('sourceHash'))
    const meta = getSamples(doc)[hash]
    if (meta?.status !== 'incoming') return items
    items.length = 0 // an incoming take is saved or discarded, not just its clip deleted
    const ctx = rec.takeCtx()
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
    if (future()) return say('this project was made with a newer version: reload to edit it', true)
    if (trackId && store.locks().has(trackId)) {
      say(`${store.locks().get(trackId)} is recording on that track`)
      return
    }
    for (const f of files) {
      if (isScoreFile(f)) {
        try {
          const base = f.name.replace(/\.[^.]+$/, '')
          if (isMusicXmlFile(f)) importMusicXml(doc, parseMusicXml(new Uint8Array(await f.arrayBuffer())), { at, trackId, base })
          else importSmf(doc, parseSmf(await f.arrayBuffer()), { at, trackId, base })
          say('')
        } catch (err) {
          say(`${f.name}: ${(err as Error).message}`, true)
        }
        continue
      }
      if (s.snapshot) {
        say('save a copy to this device to add audio', true)
        continue
      }
      say(`uploading ${f.name}…`)
      try {
        const m = await importFile(s.projectId, doc, f)
        const length = Math.round(m.duration * rate())
        trackId = addImportedClip(doc, trackId, { name: f.name, hash: m.hash, length }, at)
        at += length
        say('')
      } catch (err) {
        say(`${f.name}: ${(err as Error).message}`, true)
      }
    }
  }

  // --- input
  /** The ruler's editing menu at a bar (not in a project from the future, which is read-only). */
  function rulerMenu(t: RulerTarget, at: [number, number], anchor: HTMLElement) {
    if (future()) return
    openRulerMenu(anchor, doc, tmap(), t, at, say)
  }
  const rulerBar = (clientX: number) => barAtPx(tmap(), clientX - rulerBody.getBoundingClientRect().left, pps())
  let rulerHold = 0 // a long press on the ruler (touch) opens the menu at that bar, like a right click
  ruler.onpointerdown = (e) => {
    if (e.button !== 0) return
    seek(fromX(e.clientX - rulerBody.getBoundingClientRect().left))
    if (e.pointerType !== 'touch') return
    const { clientX, clientY } = e
    const cancel = () => (clearTimeout(rulerHold), removeEventListener('pointerup', cancel), removeEventListener('pointercancel', cancel), removeEventListener('pointermove', move))
    const move = (m: PointerEvent) => Math.hypot(m.clientX - clientX, m.clientY - clientY) > 8 && cancel()
    rulerHold = window.setTimeout(() => (cancel(), rulerMenu({ bar: rulerBar(clientX) }, [clientX, clientY], ruler)), 500)
    addEventListener('pointerup', cancel)
    addEventListener('pointercancel', cancel)
    addEventListener('pointermove', move)
  }
  ruler.oncontextmenu = (e) => {
    if (e.target instanceof Element && e.target.closest('.corner')) return
    e.preventDefault()
    rulerMenu({ bar: rulerBar(e.clientX) }, [e.clientX, e.clientY], ruler)
  }
  scroll.addEventListener('scroll', () => setScrollX(scroll.scrollLeft), { passive: true })
  addEventListener('resize', measure)
  const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure) // (the scroller, and what moves the playhead lines' height)
  resizes?.observe(scroll)
  resizes?.observe(laneBox)
  resizes?.observe(master)
  const key = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'SELECT' || (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range')) return
    const mod = e.metaKey || e.ctrlKey
    // a project from the future is read-only: you can play it and fit it to the window, nothing else
    if (future() && !(e.code === 'Space' && !e.shiftKey) && !(!mod && !e.shiftKey && e.key.toLowerCase() === 'z')) return
    if (e.code === 'Space') { e.preventDefault(); e.shiftKey ? void rec.toggleRecord() : toggle() }
    else if (!mod && !e.shiftKey && e.key.toLowerCase() === 'z') zoom.fit()
    else if (e.key === 'Escape' && sel.escape()) return
    else if (tag !== 'TEXTAREA' && !(e.target as HTMLElement).isContentEditable && !mod && !e.altKey && !e.repeat && cmdForKey(getKeys(), e.key.length === 1 ? e.key.toLowerCase() : e.key)) {
      e.preventDefault()
      void rec.command(cmdForKey(getKeys(), e.key.length === 1 ? e.key.toLowerCase() : e.key)!, e.timeStamp)
    } // the loop commands, wherever the focus is not a text field
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? undo.redo() : undo.undo() }
    else if (!mod && e.key.toLowerCase() === 's') {
      const at = Math.round(position())
      // (source clips have their own time axis: the playhead means nothing there)
      doc.transact(() => unlocked(sel.clips).filter((id) => !lanes.get(String(clipsMap(doc).get(id)?.get('trackId')))?.src).forEach((id) => splitClip(doc, id, at)))
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      const gone = sel.takeDelete()
      if (gone && 'note' in gone) {
        deleteNote(doc, gone.note)
      } else if (gone) {
        deletePad(doc, gone.pad)
      } else {
        doc.transact(() => unlocked(sel.clips).forEach((id) => deleteClip(doc, id)))
        select([])
      }
    }
  }
  /** The clips not on a track someone is recording on. */
  const unlocked = (ids: string[]) => ids.filter((id) => !store.locks().has(String(clipsMap(doc).get(id)?.get('trackId'))))
  addEventListener('keydown', key)

  // --- sync
  metaMap(doc).observe(rateChanged)
  // the timeline: regions and meta (rate, ppq, key) rebuild the map; a regions edit also ghosts the audio it moved the bars away from
  const onRegions = (_: unknown, tr: { origin: unknown }) => {
    const before = lastMap
    setMapVer((n) => n + 1)
    const after = getTimeMap(doc)
    lastMap = after
    if (!before || destroyed || tr.origin === 'migrate') return
    const ids = offGrid(before, after, mainClips())
    clearTimeout(ghostTimer)
    setGhosts(new Set(ids))
    if (ids.length) ghostTimer = setTimeout(() => setGhosts(new Set()), GHOST_MS)
  }
  const onMarkers = () => setMarkers(getMarkers(doc))
  const onMeta = () => (setMapVer((n) => n + 1), setKeyText(getKey(doc)))
  regionsMap(doc).observeDeep(onRegions)
  markersMap(doc).observeDeep(onMarkers)
  metaMap(doc).observe(onMeta)
  const offPeaks = onPeaks(() => setPeakVer((n) => n + 1))
  const onStatus = ({ status: st }: { status: string }) => (bar.dataset.status = st)
  s.provider?.on('status', onStatus)
  const onDenied = () => say('no access')
  s.provider?.on('authenticationFailed', onDenied)
  // After the first sync: migrate old projects, then start the engine at the project's sample rate.
  void s.synced.then(() => {
    if (destroyed) return
    if (isFutureDoc(doc)) setFuture(true) // (a newer client wrote it: no migration, no sweep, nothing of ours written)
    else {
      migrateToV2(doc)
      migrateToV3(doc)
      migrateToV4(doc)
      migrateToV5(doc)
      sweepOrphans(doc)
      stashLaneRanges(doc)
    }
    lastMap = getTimeMap(doc)
    setMapVer((n) => n + 1)
    setMarkers(getMarkers(doc))
    setKeyText(getKey(doc))
    // (after the migrations, which are not the user's edits)
    if (s.snapshot) doc.on('update', () => setEdited(true))
    chat.markSeen()
    setRate(getSampleRate(doc))
    pb = openPlayback(doc, s.projectId, rate(), s.userId)
    pb.recorder.onlevel = drawLevel
    pb.oncpu = showCpu
    pb.onmeters = onMeters
    applyOverrides()
    rec.listenMidi()
    setReady(true)
    syncRec()
    measure()
    if (refreshPreviews()) ensurePreviewTick()
    if (scoreOn()) { needFit = true; showScore(true) } // (the tracks are hidden, so they cannot be fitted until the score is left)
    zoom.fit() // (zoom is not remembered per project, so every open fits the song to the window)
    if (!s.snapshot && !future()) sweepUnusedTakes(rec.takeCtx())
    if (!s.snapshot && !future()) recoverTakes(rec.takeCtx()).then((n) => {
      if (n && !destroyed) say(`recovered ${n} unfinished take${n > 1 ? 's' : ''}`)
    }, (err) => console.warn('take recovery:', err))
  }, () => say('could not load the project', true))

  return {
    el,
    destroy() {
      destroyed = true
      zoom.destroy()
      cancelAnimationFrame(meterRaf)
      cancelAnimationFrame(previewRaf)
      removeEventListener('keydown', key)
      ne.destroy()
      removeEventListener('resize', measure)
      resizes?.disconnect()
      rec.destroy()
      metaMap(doc).unobserve(rateChanged)
      regionsMap(doc).unobserveDeep(onRegions)
      markersMap(doc).unobserveDeep(onMarkers)
      metaMap(doc).unobserve(onMeta)
      clearTimeout(ghostTimer)
      clearTimeout(rulerHold)
      offPeaks()
      s.provider?.off('status', onStatus)
      s.provider?.off('authenticationFailed', onDenied)
      chat.destroy()
      hist?.destroy()
      pb?.destroy()
      score?.dispose()
      disposers.forEach((d) => d())
      store.dispose()
    },
  }
}
