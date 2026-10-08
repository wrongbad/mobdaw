// Yjs document schema v2 (docs/engine.md §3). Every map is flat and keyed by id; children
// reference their parent by id; positions are integer samples at meta.sampleRate.
//   meta    Y.Map  { schemaVersion, sampleRate, guideBpm? }
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
import { DEVICES } from './devices.ts'
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
export type Track = { id: string; name: string; kind: TrackKind; order: number; gain: number; pan: number; muted: boolean; soloed: boolean }
/** 0 equal-power, 1 linear, 2 s-curve */
export type FadeShape = 0 | 1 | 2
export type AudioClip = {
  id: string; trackId: string; kind: 'audio'
  start: number; length: number; sourceHash: string; sourceOffset: number
  gain: number; fadeIn: number; fadeOut: number; fadeShape: FadeShape
}
export type MidiClip = { id: string; trackId: string; kind: 'midi'; start: number; bpm: number; ppq: number; lengthTicks: number }
export type Clip = AudioClip | MidiClip
export type Note = { id: string; clipId: string; tick: number; durTicks: number; pitch: number; velocity: number }
export type Device = { id: string; trackId: string; type: number; order: number; bypass: boolean; params: Record<string, number> }
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
export type Lane = { id: string; enabled: boolean; order: number } & ParamTarget
/** `value` is normalised (0..1 along the param's own scale); `curve` shapes the segment *after* this point. */
export type AutoCurve = 'linear' | 'hold'
export type Point = { id: string; laneId: string; pos: number; value: number; curve: AutoCurve }
export type ChatMessage = { id: string; username: string; color: string; text: string; ts: number }
export type SampleMeta = { hash: string; name: string; duration: number; size: number; mime: string }

export type AwarenessState = {
  user: { username: string; color: string }
  playhead?: number | null
  selection?: string[]
  /** In-progress parameter drag; collaborators apply it as a transient override. */
  dragging?: { deviceId: string; paramId: number; value: number } | null
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
export function addTrack(doc: Y.Doc, name: string, kind: TrackKind = 'audio', order?: number): string {
  const id = newId()
  const t: Track = { id, name, kind, order: order ?? orderBetween(getTracks(doc).at(-1)?.order), gain: 1, pan: 0, muted: false, soloed: false }
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
  let right = ''
  doc.transact(() => {
    right = addAudioClip(doc, { ...c, start: at, length: c.length - left, sourceOffset: c.sourceOffset + left, fadeIn: 0 })
    updateClip(doc, id, { length: left, fadeOut: 0 })
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
export function addDevice(doc: Y.Doc, trackId: string, type: number): string {
  const id = newId()
  const order = orderBetween(getDevices(doc).filter((d) => d.trackId === trackId).at(-1)?.order)
  doc.transact(() => {
    const m = toMap({ id, trackId, type, order, bypass: false })
    const params = new Y.Map<number>()
    for (const p of DEVICES[type]?.params ?? []) params.set(String(p.id), p.def)
    m.set('params', params)
    devicesMap(doc).set(id, m)
  })
  return id
}
export const updateDevice = (doc: Y.Doc, id: string, patch: Partial<Pick<Device, 'order' | 'bypass'>>) =>
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

// --- automation
export const laneOf = (doc: Y.Doc, t: ParamTarget) =>
  getLanes(doc).find((l) => l.scope === t.scope && l.kind === t.kind && l.owner === t.owner && l.param === t.param)
/** The lane automating `t`, created (enabled, last in its section) if there isn't one yet. */
export function addLane(doc: Y.Doc, t: ParamTarget): string {
  const have = laneOf(doc, t)
  if (have) return have.id
  const id = newId()
  const order = orderBetween(getLanes(doc).filter((l) => l.scope === t.scope).at(-1)?.order)
  const lane: Lane = { id, enabled: true, order, scope: t.scope, kind: t.kind, owner: t.owner, param: t.param }
  doc.transact(() => lanesMap(doc).set(id, toMap(lane)))
  return id
}
export const setLaneEnabled = (doc: Y.Doc, id: string, enabled: boolean) => patchMap(doc, lanesMap(doc).get(id), { enabled })
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
