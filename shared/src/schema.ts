// Yjs document schema v2 (docs/engine.md §3). Every map is flat and keyed by id; children
// reference their parent by id; positions are integer samples at meta.sampleRate.
//   meta    Y.Map  { schemaVersion, sampleRate }
//   tracks  Y.Map  id -> Y.Map Track
//   clips   Y.Map  id -> Y.Map AudioClip | MidiClip
//   notes   Y.Map  id -> Y.Map Note
//   loopers Y.Map  id -> Y.Map Looper (1 to start per 'soundscape' track, add/remove freely; region in *source* time, length 0 = unset)
//   pads    Y.Map  id -> Y.Map Pad (a free-time gate block on the soundscape's timeline: all its loopers on)
//   devices Y.Map  id -> Y.Map Device (params: nested Y.Map paramId -> number)
//   lanes   Y.Map  id -> Y.Map Lane (one automation lane per ParamTarget, see params.ts; `scope` is a track id or MASTER_TRACK)
//   points  Y.Map  id -> Y.Map Point (a lane's keyframes: pos = timeline samples, value = normalised 0..1 of the param's range)
//   samples Y.Map  hash -> plain object SampleMeta
//   chat    Y.Array of plain ChatMessage, append-only; outside the undo scope
import * as Y from 'yjs'
import { DEVICES, LOFI_DRUM } from './devices.ts'
import type { ParamTarget } from './params.ts'

export const SCHEMA_VERSION = 2
export const DEFAULT_SAMPLE_RATE = 48000
export const DEFAULT_PPQ = 960
export const DEFAULT_MIDI_BPM = 120

/**
 * 'soundscape': its audio clips are a *source* lane in their own time world, read by its loopers;
 * pads on the main timeline switch the loopers on. The clips are never played linearly.
 */
export type TrackKind = 'audio' | 'midi' | 'soundscape'
/** A device whose `trackId` is this sits on the master bus: the project's global fx chain, run over the sum of all tracks. */
export const MASTER_TRACK = 'master'
export const LOOPERS_PER_TRACK = 1
export const LOOP_SPEED_MIN = 0.1
export const LOOP_SPEED_MAX = 4
/** Tape low-pass range in Hz; the top is fully open (bypassed). */
export const LOOP_CUTOFF_MIN = 200
export const LOOP_CUTOFF_MAX = 20000
/** `role: 'click'` marks the metronome's track: it ignores other tracks' solo (still audible), and its own mute counts. */
export type TrackRole = 'click'
export type Track = { id: string; name: string; kind: TrackKind; order: number; gain: number; pan: number; muted: boolean; soloed: boolean; role?: TrackRole; color?: number }
/** 0 equal-power, 1 linear, 2 s-curve */
export type FadeShape = 0 | 1 | 2
/**
 * `length` is the clip's extent on the timeline. `loopLength` (samples; absent or 0 = no loop) is the pass: the source frames
 * `[sourceOffset, sourceOffset + loopLength)`, which repeat to fill the extent; the clip loops when `loopLength < length`. `loopPhase`
 * (samples in `[0, loopLength)`, absent = 0) is where in the pass the clip's start falls, so timeline sample `t` reads pass position
 * `((t - start) + loopPhase) mod loopLength`. `forever` (only while looping) keeps the pass repeating past `length`, like MIDI's.
 * Fades apply at the clip's own edges only; the engine crossfades the seams between passes (docs/engine-api.md).
 */
export type AudioClip = {
  id: string; trackId: string; kind: 'audio'
  start: number; length: number; sourceHash: string; sourceOffset: number
  gain: number; fadeIn: number; fadeOut: number; fadeShape: FadeShape
  loopLength?: number; loopPhase?: number; forever?: boolean
}
/**
 * `lengthTicks` is the clip's extent on the timeline. `loopTicks` (absent or 0 = no loop) is the pattern length: the notes in
 * `[0, loopTicks)` repeat every `loopTicks` until `lengthTicks`, and notes at or after `loopTicks` are ignored. `view: 'drums'`
 * opens the drum grid instead of the piano roll (absent = piano roll); it is only a view of the same notes.
 * `forever` (only while looping) keeps the pattern repeating past `lengthTicks` for as long as the transport runs: `lengthTicks`
 * stays the finite part that sets the scroll bounds and the export's end.
 */
export type MidiClip = { id: string; trackId: string; kind: 'midi'; start: number; bpm: number; ppq: number; lengthTicks: number; loopTicks?: number; forever?: boolean; view?: 'drums' }
export type Clip = AudioClip | MidiClip
export type Note = { id: string; clipId: string; tick: number; durTicks: number; pitch: number; velocity: number }
/** `name`, `keyLo` and `keyHi` are optional: an instrument's label and its note range (MIDI 0..127 inclusive; absent = 0 and 127). Not params. */
export type Device = { id: string; trackId: string; type: number; order: number; bypass: boolean; params: Record<string, number>; name?: string; keyLo?: number; keyHi?: number }
export const KEY_MIN = 0
export const KEY_MAX = 127
/** Loop region in source time (samples of the track's source clips); `length` 0 means unset. */
/** `gain` (0..1), `muted` and the tape controls are absent on loopers saved before they existed: read them with `?? 1` / `?? false` /
 * `?? 0` (`sat`: saturation 0..1; `warble`: wow/flutter depth 0..1) / `?? LOOP_CUTOFF_MAX` (`cutoff`: low-pass Hz). */
export type Looper = {
  id: string; trackId: string; slot: number; speed: number; start: number; length: number
  gain?: number; muted?: boolean; sat?: number; cutoff?: number; warble?: number
}
/** All of the soundscape's loopers are on over `[start, start+length)` of the timeline (samples). Each pad restarts the loops. */
export type Pad = { id: string; trackId: string; start: number; length: number }
/**
 * While `enabled`, the lane replaces the param's value (the doc keeps the static value; disabling or deleting the lane gives it back).
 * `order` sorts the lanes within their scope's automation section.
 */
export type Lane = {
  id: string
  enabled: boolean
  order: number
  /** Absent means keyframes. In 'lfo' mode the points are kept but not read, and the param's own (static) value is the centre. */
  mode?: LaneMode
  /** LFO settings (see LFO_*), meaningful in 'lfo' mode. `depth` is normalised: the wave swings the slider by +- this much. */
  shape?: number
  rate?: number
  depth?: number
  /**
   * The param's range when the lane was made (not shown). Points are normalised, so they only mean something against
   * this: if the param's range changes later, the lane keeps sweeping what it was drawn for. Absent on lanes from before
   * this was stored; `stashLaneRanges` fills those in.
   */
  min?: number
  max?: number
  scale?: 'lin' | 'log' | 'pow'
} & ParamTarget
export type LaneMode = 'keyframes' | 'lfo'
/** What the lane's mode menu offers; 'off' is `enabled: false`. */
export type LaneState = 'off' | LaneMode
export const LFO_SHAPES = ['Sine', 'Triangle', 'Square'] // engine dsp::lfo order
export const LFO_RATE_MIN = 0.05
export const LFO_RATE_MAX = 20
export const LFO_DEFAULTS = { shape: 0, rate: 1, depth: 0.25 }
export const laneState = (l: Pick<Lane, 'enabled' | 'mode'>): LaneState => (!l.enabled ? 'off' : l.mode === 'lfo' ? 'lfo' : 'keyframes')
/** `value` is normalised (0..1 along the param's own scale); `curve` shapes the segment *after* this point. */
export type AutoCurve = 'linear' | 'hold'
export type Point = { id: string; laneId: string; pos: number; value: number; curve: AutoCurve }
export type ChatMessage = { id: string; username: string; color: string; text: string; ts: number }
/**
 * `status`: absent means the audio is in storage and anyone in the project can load it. 'incoming' is a take still only on
 * the recorder's device (`by`, their user id; `byName`, their name when recorded); 'missing' is audio whose upload was deleted. `peaks`: base64 waveform
 * (probe.ts `peaksToBase64`), so clips can be drawn without the audio. See docs/engine.md §9.
 */
export type SampleStatus = 'incoming' | 'missing'
export type SampleMeta = { hash: string; name: string; duration: number; size: number; mime: string; status?: SampleStatus; by?: number; byName?: string; peaks?: string }

export type AwarenessState = {
  user: { username: string; color: string }
  playhead?: number | null
  selection?: string[]
  /** In-progress parameter drag; collaborators apply it as a transient override. */
  dragging?: { deviceId: string; paramId: number; value: number }[] | null
  /** A take in progress: collaborators treat the track as read-only and draw a growing region from `start` (timeline samples). */
  recording?: { trackId: string; start: number } | null
}

export const docName = (projectId: string) => `project:${projectId}`

export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(9))
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_') // 12 url-safe chars
}

export function userColor(username: string): string {
  let h = 0
  for (const ch of username) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 65% 62%)`
}

type YM = Y.Map<unknown>
export const metaMap = (doc: Y.Doc) => doc.getMap<unknown>('meta')
export const tracksMap = (doc: Y.Doc) => doc.getMap<YM>('tracks')
export const clipsMap = (doc: Y.Doc) => doc.getMap<YM>('clips')
export const notesMap = (doc: Y.Doc) => doc.getMap<YM>('notes')
export const loopersMap = (doc: Y.Doc) => doc.getMap<YM>('loopers')
export const padsMap = (doc: Y.Doc) => doc.getMap<YM>('pads')
export const devicesMap = (doc: Y.Doc) => doc.getMap<YM>('devices')
export const lanesMap = (doc: Y.Doc) => doc.getMap<YM>('lanes')
export const pointsMap = (doc: Y.Doc) => doc.getMap<YM>('points')
export const samplesMap = (doc: Y.Doc) => doc.getMap<SampleMeta>('samples')
export const chatLog = (doc: Y.Doc) => doc.getArray<ChatMessage>('chat')

/** Types to pass to `new Y.UndoManager(undoScope(doc), { trackedOrigins })`. */
export const undoScope = (doc: Y.Doc) => [
  metaMap(doc), tracksMap(doc), clipsMap(doc), notesMap(doc), devicesMap(doc), loopersMap(doc), padsMap(doc), lanesMap(doc), pointsMap(doc),
]

const all = <T>(m: Y.Map<YM>) => [...m.values()].map((v) => v.toJSON() as T)
export const getTracks = (doc: Y.Doc) => all<Track>(tracksMap(doc)).sort((a, b) => a.order - b.order)
export const getClips = (doc: Y.Doc) => all<Clip>(clipsMap(doc)).filter((c) => c.kind === 'audio' || c.kind === 'midi')
export const getNotes = (doc: Y.Doc) => all<Note>(notesMap(doc))
export const getPads = (doc: Y.Doc) => all<Pad>(padsMap(doc)).sort((a, b) => a.start - b.start)
export const getLoopers = (doc: Y.Doc) => all<Looper>(loopersMap(doc)).sort((a, b) => a.slot - b.slot)
export const getDevices = (doc: Y.Doc) => all<Device>(devicesMap(doc)).sort((a, b) => a.order - b.order)
export const getLanes = (doc: Y.Doc) => all<Lane>(lanesMap(doc)).filter((l) => l.owner != null).sort((a, b) => a.order - b.order)
export const getPoints = (doc: Y.Doc) => all<Point>(pointsMap(doc))
export const getSamples = (doc: Y.Doc): Record<string, SampleMeta> => samplesMap(doc).toJSON()
export const getSampleRate = (doc: Y.Doc): number => (metaMap(doc).get('sampleRate') as number | undefined) ?? DEFAULT_SAMPLE_RATE

/** MIDI tick -> sample offset within the clip (docs/engine.md §2). */
export const ticksToSamples = (ticks: number, bpm: number, ppq: number, rate: number) =>
  Math.round((ticks * 60 * rate) / (bpm * ppq))
export const clipLength = (c: Clip, rate: number) =>
  c.kind === 'audio' ? c.length : ticksToSamples(c.lengthTicks, c.bpm, c.ppq, rate)

/** Fractional order value that sorts between `before` and `after` (either may be undefined). */
export function orderBetween(before?: number, after?: number): number {
  if (before == null && after == null) return 1
  if (before == null) return after! - 1
  if (after == null) return before + 1
  return (before + after) / 2
}

const toMap = (o: object) => new Y.Map<unknown>(Object.entries(o))
const patchMap = (doc: Y.Doc, m: YM | undefined, patch: object) => {
  if (m) doc.transact(() => Object.entries(patch).forEach(([k, v]) => m.set(k, v)))
}

// --- tracks
export function addTrack(doc: Y.Doc, name: string, kind: TrackKind = 'audio', order?: number, role?: TrackRole, color?: number): string {
  const id = newId()
  const t: Track = { id, name, kind, order: order ?? orderBetween(getTracks(doc).at(-1)?.order), gain: 1, pan: 0, muted: false, soloed: false, ...(role ? { role } : {}), ...(color != null ? { color } : {}) }
  doc.transact(() => {
    tracksMap(doc).set(id, toMap(t))
    if (kind === 'soundscape') for (let slot = 0; slot < LOOPERS_PER_TRACK; slot++) addLooper(doc, id, slot)
  })
  return id
}
export const updateTrack = (doc: Y.Doc, id: string, patch: Partial<Omit<Track, 'id'>>) => patchMap(doc, tracksMap(doc).get(id), patch)

export function deleteTrack(doc: Y.Doc, id: string) {
  doc.transact(() => {
    for (const c of getClips(doc)) if (c.trackId === id) deleteClip(doc, c.id)
    for (const d of getDevices(doc)) if (d.trackId === id) deleteDevice(doc, d.id)
    for (const p of getPads(doc)) if (p.trackId === id) padsMap(doc).delete(p.id)
    for (const l of getLoopers(doc)) if (l.trackId === id) loopersMap(doc).delete(l.id)
    tracksMap(doc).delete(id)
  })
}

// --- loopers
export function addLooper(doc: Y.Doc, trackId: string, slot: number): string {
  const id = newId()
  doc.transact(() => loopersMap(doc).set(id, toMap({ id, trackId, slot, speed: 1, start: 0, length: 0, gain: 1, muted: false } satisfies Looper)))
  return id
}
/** Adds a looper in the lowest free slot (slots set its colour and number). */
export function addNextLooper(doc: Y.Doc, trackId: string): string {
  const used = new Set(getLoopers(doc).filter((l) => l.trackId === trackId).map((l) => l.slot))
  let slot = 0
  while (used.has(slot)) slot++
  return addLooper(doc, trackId, slot)
}
export function deleteLooper(doc: Y.Doc, id: string) {
  doc.transact(() => {
    for (const l of getLanes(doc)) if (l.kind === 'looper' && l.owner === id) deleteLane(doc, l.id)
    loopersMap(doc).delete(id)
  })
}
export const updateLooper = (doc: Y.Doc, id: string, patch: Partial<Pick<Looper, 'speed' | 'start' | 'length' | 'gain' | 'muted' | 'sat' | 'cutoff' | 'warble'>>) =>
  patchMap(doc, loopersMap(doc).get(id), patch)

// --- pads
export function addPad(doc: Y.Doc, trackId: string, start: number, length: number): string {
  const id = newId()
  doc.transact(() => padsMap(doc).set(id, toMap({ id, trackId, start, length } satisfies Pad)))
  return id
}
export const updatePad = (doc: Y.Doc, id: string, patch: Partial<Pick<Pad, 'start' | 'length'>>) =>
  patchMap(doc, padsMap(doc).get(id), patch)
export const deletePad = (doc: Y.Doc, id: string) => doc.transact(() => padsMap(doc).delete(id))

// --- clips
export function addAudioClip(
  doc: Y.Doc,
  c: Pick<AudioClip, 'trackId' | 'sourceHash' | 'start' | 'length'> & Partial<Omit<AudioClip, 'id' | 'kind'>>,
): string {
  const id = newId()
  const clip: AudioClip = { sourceOffset: 0, gain: 1, fadeIn: 0, fadeOut: 0, fadeShape: 0, ...c, id, kind: 'audio' }
  doc.transact(() => clipsMap(doc).set(id, toMap(clip)))
  return id
}

export function addMidiClip(doc: Y.Doc, c: Pick<MidiClip, 'trackId' | 'start'> & Partial<Omit<MidiClip, 'id' | 'kind'>>): string {
  const id = newId()
  const ppq = c.ppq ?? DEFAULT_PPQ
  const clip: MidiClip = { bpm: DEFAULT_MIDI_BPM, ppq, lengthTicks: 16 * ppq, ...c, id, kind: 'midi' }
  doc.transact(() => clipsMap(doc).set(id, toMap(clip)))
  return id
}

export const updateClip = (doc: Y.Doc, id: string, patch: Partial<Omit<AudioClip, 'id' | 'kind'> & Omit<MidiClip, 'id' | 'kind'>>) =>
  patchMap(doc, clipsMap(doc).get(id), patch)

/** Show a MIDI clip as a drum grid or a piano roll (`view` is absent for the latter). Same notes either way. */
export function setMidiView(doc: Y.Doc, id: string, view: 'drums' | 'piano') {
  const m = clipsMap(doc).get(id)
  if (m) doc.transact(() => (view === 'drums' ? m.set('view', 'drums') : m.delete('view')))
}

export function deleteClip(doc: Y.Doc, id: string) {
  doc.transact(() => {
    for (const n of getNotes(doc)) if (n.clipId === id) notesMap(doc).delete(n.id)
    clipsMap(doc).delete(id)
  })
}

/** Split an audio clip at timeline sample `at`; returns the new (right-hand) clip id, or null. */
export function splitClip(doc: Y.Doc, id: string, at: number): string | null {
  const c = clipsMap(doc).get(id)?.toJSON() as Clip | undefined
  if (c?.kind !== 'audio' || at <= c.start || at >= c.start + c.length) return null
  const left = at - c.start
  const pass = c.loopLength ?? 0
  let right = ''
  doc.transact(() => {
    // a looping clip keeps its pass; the right half starts `left` further into it. Forever goes to the right half.
    const half = pass > 0 ? { loopPhase: ((c.loopPhase ?? 0) + left) % pass } : { sourceOffset: c.sourceOffset + left }
    right = addAudioClip(doc, { ...c, start: at, length: c.length - left, fadeIn: 0, ...half })
    updateClip(doc, id, { length: left, fadeOut: 0, ...(c.forever ? { forever: false } : {}) })
  })
  return right
}

// --- notes
export function addNote(doc: Y.Doc, n: Omit<Note, 'id'>): string {
  const id = newId()
  doc.transact(() => notesMap(doc).set(id, toMap({ ...n, id })))
  return id
}
export const updateNote = (doc: Y.Doc, id: string, patch: Partial<Omit<Note, 'id'>>) => patchMap(doc, notesMap(doc).get(id), patch)
export const deleteNote = (doc: Y.Doc, id: string) => doc.transact(() => notesMap(doc).delete(id))

// --- devices
/** Append a device to a track's chain with default params. */
export function addDevice(doc: Y.Doc, trackId: string, type: number, extra: Partial<Pick<Device, 'name' | 'keyLo' | 'keyHi'>> = {}, initial: Record<string, number> = {}): string {
  const id = newId()
  const order = orderBetween(getDevices(doc).filter((d) => d.trackId === trackId).at(-1)?.order)
  doc.transact(() => {
    const m = toMap({ id, trackId, type, order, bypass: false, ...extra })
    const params = new Y.Map<number>()
    for (const p of DEVICES[type]?.params ?? []) params.set(String(p.id), initial[String(p.id)] ?? p.def)
    m.set('params', params)
    devicesMap(doc).set(id, m)
  })
  return id
}
export const updateDevice = (doc: Y.Doc, id: string, patch: Partial<Pick<Device, 'order' | 'bypass' | 'name' | 'keyLo' | 'keyHi'>>) =>
  patchMap(doc, devicesMap(doc).get(id), patch)
export function setParam(doc: Y.Doc, deviceId: string, paramId: number, value: number) {
  const params = devicesMap(doc).get(deviceId)?.get('params') as Y.Map<number> | undefined
  params?.set(String(paramId), value)
}
export function deleteDevice(doc: Y.Doc, id: string) {
  doc.transact(() => {
    for (const l of getLanes(doc)) if (l.kind !== 'looper' && l.owner === id) deleteLane(doc, l.id)
    devicesMap(doc).delete(id)
  })
}

/** The first MIDI note a new drum takes (GM kick); further drums count up from it. */
export const DRUM_KEY_FIRST = 36
const DRUM_NAMES = ['kick', 'rim', 'snare', 'clap', 'tom', 'hat', 'open hat', 'perc']
/** An instrument whose note range is a single note: a row in the drum grid. */
export const isDrum = (d: Pick<Device, 'type' | 'keyLo' | 'keyHi'>) => !!DEVICES[d.type]?.instrument && (d.keyLo ?? KEY_MIN) === (d.keyHi ?? KEY_MAX)

/** The lowest single-note key from `DRUM_KEY_FIRST` up that no drum on the track has. */
export function nextDrumKey(doc: Y.Doc, trackId: string): number {
  const used = new Set(getDevices(doc).filter((d) => d.trackId === trackId && isDrum(d)).map((d) => d.keyLo))
  let k = DRUM_KEY_FIRST
  while (used.has(k) && k < KEY_MAX) k++
  return k
}

/** Add a lofi drum to a MIDI track's synths lane on a single note (default: the lowest unused one from 36), named after it. */
export function addDrum(doc: Y.Doc, trackId: string, o: { key?: number; name?: string; params?: Record<string, number> } = {}): string {
  const key = o.key ?? nextDrumKey(doc, trackId)
  const name = o.name ?? DRUM_NAMES[(key - DRUM_KEY_FIRST) % DRUM_NAMES.length] ?? 'drum'
  return addDevice(doc, trackId, LOFI_DRUM, { name, keyLo: key, keyHi: key }, o.params)
}

/** The pattern length of a MIDI clip in ticks: its loop when it loops, else its whole length. */
export const patternTicks = (c: Pick<MidiClip, 'lengthTicks' | 'loopTicks'>) => (c.loopTicks && c.loopTicks > 0 && c.loopTicks < c.lengthTicks ? c.loopTicks : c.lengthTicks)
type Loopy = Pick<MidiClip, 'lengthTicks' | 'loopTicks' | 'forever'> | Pick<AudioClip, 'length' | 'loopLength' | 'forever'>
/** Whether a clip (either kind) repeats a pass shorter than its extent. */
export const isLooping = (c: Loopy) => ('lengthTicks' in c ? patternTicks(c) < c.lengthTicks : !!c.loopLength && c.loopLength > 0 && c.loopLength < c.length)
/** Whether a clip repeats past its end: a `forever` flag only counts while it loops. */
export const isForever = (c: Loopy) => !!c.forever && isLooping(c)
export const FOREVER_SECONDS = 24 * 3600
export const foreverTicks = (c: Pick<MidiClip, 'bpm' | 'ppq'>) => (FOREVER_SECONDS * c.bpm * c.ppq) / 60

/**
 * The metronome: a MIDI track named "click" (`role: 'click'`, first in the list) with two lofi drums, "accent" (the higher,
 * brighter one) and "tick", and a drum-grid clip at 0, 120 bpm in 4/4: one bar looped across four, with the tick on all four
 * beats and the accent doubled onto beat 1 (so muting the accent synth leaves a plain click). The clip loops `forever`. One transaction,
 * so one undo step. Returns the track id.
 */
export function addClickTrack(doc: Y.Doc): string {
  let id = ''
  doc.transact(() => {
    id = addTrack(doc, 'click', 'midi', orderBetween(undefined, getTracks(doc)[0]?.order), 'click')
    const accent = 37, tick = 36
    addDrum(doc, id, { key: accent, name: 'accent', params: { 0: 3500, 1: 0.8, 2: 40, 3: 0.8 } })
    addDrum(doc, id, { key: tick, name: 'tick', params: { 0: 1500, 1: 0.65, 2: 35, 3: 0.6 } })
    const ppq = DEFAULT_PPQ
    const clip = addMidiClip(doc, { trackId: id, start: 0, bpm: 120, ppq, lengthTicks: 16 * ppq, loopTicks: 4 * ppq, forever: true, view: 'drums' })
    for (let beat = 0; beat < 4; beat++) addNote(doc, { clipId: clip, tick: beat * ppq, durTicks: ppq / 4, pitch: tick, velocity: 1 })
    addNote(doc, { clipId: clip, tick: 0, durTicks: ppq / 4, pitch: accent, velocity: 1 })
  })
  return id
}

// --- automation
export const laneOf = (doc: Y.Doc, t: ParamTarget) =>
  getLanes(doc).find((l) => l.scope === t.scope && l.kind === t.kind && l.owner === t.owner && l.param === t.param)
/** The lane automating `t`, created (enabled, last in its section) if there isn't one yet. */
export function addLane(doc: Y.Doc, t: ParamTarget, range?: Pick<Lane, 'min' | 'max' | 'scale'>): string {
  const have = laneOf(doc, t)
  if (have) return have.id
  const id = newId()
  const order = orderBetween(getLanes(doc).filter((l) => l.scope === t.scope).at(-1)?.order)
  const lane: Lane = { id, enabled: true, order, scope: t.scope, kind: t.kind, owner: t.owner, param: t.param }
  if (range) Object.assign(lane, { min: range.min, max: range.max, scale: range.scale })
  doc.transact(() => lanesMap(doc).set(id, toMap(lane)))
  return id
}
export const setLaneEnabled = (doc: Y.Doc, id: string, enabled: boolean) => patchMap(doc, lanesMap(doc).get(id), { enabled })
/** Off / keyframes / LFO. Switching never touches the points, so going back finds the drawing as it was. */
export const setLaneState = (doc: Y.Doc, id: string, state: LaneState) =>
  patchMap(doc, lanesMap(doc).get(id), state === 'off' ? { enabled: false } : { enabled: true, mode: state })
export const updateLaneLfo = (doc: Y.Doc, id: string, patch: Partial<Pick<Lane, 'shape' | 'rate' | 'depth'>>) =>
  patchMap(doc, lanesMap(doc).get(id), {
    ...(patch.shape != null ? { shape: Math.min(LFO_SHAPES.length - 1, Math.max(0, Math.round(patch.shape))) } : {}),
    ...(patch.rate != null ? { rate: Math.min(LFO_RATE_MAX, Math.max(LFO_RATE_MIN, patch.rate)) } : {}),
    ...(patch.depth != null ? { depth: Math.min(1, Math.max(0, patch.depth)) } : {}),
  })
export function deleteLane(doc: Y.Doc, id: string) {
  doc.transact(() => {
    for (const p of getPoints(doc)) if (p.laneId === id) pointsMap(doc).delete(p.id)
    lanesMap(doc).delete(id)
  })
}
export function addPoint(doc: Y.Doc, laneId: string, pos: number, value: number, curve: AutoCurve = 'linear'): string {
  const id = newId()
  const p: Point = { id, laneId, pos: Math.max(0, Math.round(pos)), value: Math.min(1, Math.max(0, value)), curve }
  doc.transact(() => pointsMap(doc).set(id, toMap(p)))
  return id
}
export const updatePoint = (doc: Y.Doc, id: string, patch: Partial<Pick<Point, 'pos' | 'value' | 'curve'>>) =>
  patchMap(doc, pointsMap(doc).get(id), {
    ...patch,
    ...(patch.pos != null ? { pos: Math.max(0, Math.round(patch.pos)) } : {}),
    ...(patch.value != null ? { value: Math.min(1, Math.max(0, patch.value)) } : {}),
  })
export const deletePoint = (doc: Y.Doc, id: string) => doc.transact(() => pointsMap(doc).delete(id))

// --- chat
export const CHAT_MAX = 2000
export function addChatMessage(doc: Y.Doc, user: AwarenessState['user'], text: string): string | null {
  const t = text.trim().slice(0, CHAT_MAX)
  if (!t) return null
  const id = newId()
  chatLog(doc).push([{ id, username: user.username, color: user.color, text: t, ts: Date.now() }])
  return id
}

export function deleteChatMessage(doc: Y.Doc, id: string) {
  const log = chatLog(doc)
  const i = log.toArray().findIndex((m) => m.id === id)
  if (i >= 0) log.delete(i, 1)
}

// --- samples
export function addSample(doc: Y.Doc, s: SampleMeta) {
  samplesMap(doc).set(s.hash, s)
}

/** Replace a sample's `status`. Undefined clears it (an incoming take was uploaded), along with who recorded it. */
export function setSampleStatus(doc: Y.Doc, hash: string, status: SampleStatus | undefined) {
  const m = samplesMap(doc).get(hash)
  if (!m) return
  const { status: _, by, byName, ...rest } = m
  samplesMap(doc).set(hash, status ? { ...rest, ...(status === 'incoming' ? { by, byName } : {}), status } : rest)
}

/**
 * Delete a sample and every clip that plays it, in one transaction. `origin` lets the caller keep it out of undo (the
 * samples map isn't in the undo scope, so undoing would bring the clips back without their audio).
 */
export function discardSample(doc: Y.Doc, hash: string, origin?: unknown) {
  doc.transact(() => {
    for (const c of getClips(doc)) if (c.kind === 'audio' && c.sourceHash === hash) deleteClip(doc, c.id)
    samplesMap(doc).delete(hash)
  }, origin)
}

/**
 * Delete entities whose parent no longer exists (left by concurrent edits, e.g. A adds a
 * note while B deletes its clip). Cheap enough to run opportunistically before an edit.
 */
export function sweepOrphans(doc: Y.Doc) {
  doc.transact(() => {
    const tracks = tracksMap(doc), clips = clipsMap(doc)
    for (const c of getClips(doc)) if (!tracks.has(c.trackId)) deleteClip(doc, c.id)
    for (const d of getDevices(doc)) if (d.trackId !== MASTER_TRACK && !tracks.has(d.trackId)) deleteDevice(doc, d.id)
    for (const l of getLoopers(doc)) if (!tracks.has(l.trackId)) loopersMap(doc).delete(l.id)
    for (const p of getPads(doc)) if (!tracks.has(p.trackId)) padsMap(doc).delete(p.id)
    for (const n of getNotes(doc)) if (!clips.has(n.clipId)) notesMap(doc).delete(n.id)
    for (const l of all<Lane>(lanesMap(doc))) {
      const owner = l.kind === 'looper' ? loopersMap(doc).has(l.owner) : devicesMap(doc).has(l.owner)
      if (l.owner == null || !owner) deleteLane(doc, l.id)
    }
    for (const p of getPoints(doc)) if (!lanesMap(doc).has(p.laneId)) pointsMap(doc).delete(p.id)
    // two clients automating the same param at once make two lanes: keep the first (by id)
    const seen = new Set<string>()
    for (const l of getLanes(doc).sort((x, y) => (x.id < y.id ? -1 : 1))) {
      const k = `${l.scope}/${l.kind}/${l.owner}/${l.param}`
      if (seen.has(k)) deleteLane(doc, l.id)
      else seen.add(k)
    }
  })
}

// --- migration
/**
 * v1 (seconds, no kind) -> v2 (samples). Runs when meta.schemaVersion is absent. Every write
 * is a pure function of the old values, so concurrent clients running it converge to the
 * same state. Origin 'migrate' keeps it out of the undo stack.
 */
export function migrateToV2(doc: Y.Doc) {
  const meta = metaMap(doc)
  if (meta.get('schemaVersion') != null) return
  const sr = DEFAULT_SAMPLE_RATE
  const smp = (sec: unknown) => Math.round(Number(sec) * sr)
  doc.transact(() => {
    meta.set('sampleRate', sr)
    for (const t of tracksMap(doc).values()) {
      if (t.get('kind') == null) t.set('kind', 'audio')
      if (t.get('pan') == null) t.set('pan', 0)
      if (t.get('soloed') == null) t.set('soloed', false)
    }
    for (const c of clipsMap(doc).values()) {
      if (c.get('kind') != null) continue
      c.set('kind', 'audio')
      c.set('sourceHash', c.get('sampleHash'))
      c.set('start', smp(c.get('start')))
      c.set('length', smp(c.get('duration')))
      c.set('sourceOffset', smp(c.get('offset')))
      c.set('fadeIn', 0)
      c.set('fadeOut', 0)
      c.set('fadeShape', 0)
      for (const k of ['sampleHash', 'duration', 'offset']) c.delete(k)
    }
    meta.set('schemaVersion', SCHEMA_VERSION)
  }, 'migrate')
}
/** A forever audio clip's length in samples (what the engine is sent), mirroring `foreverTicks`. */
export const foreverSamples = (rate: number) => FOREVER_SECONDS * rate
/** A clip's pass in samples: its loop when it loops, else its whole (finite) length. */
export const passLength = (c: Clip, rate: number) =>
  c.kind === 'audio' ? (isLooping(c) ? c.loopLength! : c.length) : ticksToSamples(patternTicks(c), c.bpm, c.ppq, rate)
