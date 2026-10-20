// Yjs document schema v4 (docs/engine.md §3). Every map is flat and keyed by id; children
// reference their parent by id; positions are integer samples at meta.sampleRate, except MIDI clips, which sit in
// ticks (meta.ppq per quarter note) on the project timeline defined by `regions` (timemap.ts).
//   meta    Y.Map  { schemaVersion, sampleRate, ppq, key? }
//   regions Y.Map  id -> Y.Map Region (the tempo/meter map: metered or free runs of bars; one always at bar 1, none sharing a bar)
//   markers Y.Map  id -> Y.Map Marker (section marks at a bar)
//   tracks  Y.Map  id -> Y.Map Track
//   clips   Y.Map  id -> Y.Map AudioClip | MidiClip (MIDI: startTick/lengthTicks on the project timeline)
//   notes   Y.Map  id -> Y.Map Note
//   loopers Y.Map  id -> Y.Map Looper (1 to start per 'soundscape' track, add/remove freely; region in *source* time, length 0 = unset)
//   pads    Y.Map  id -> Y.Map Pad (a free-time gate block on the soundscape's timeline: all its loopers on)
//   devices Y.Map  id -> Y.Map Device (params: nested Y.Map paramId -> number)
//   lanes   Y.Map  id -> Y.Map Lane (one automation lane per ParamTarget, see params.ts; `scope` is a track id or MASTER_TRACK)
//   points  Y.Map  id -> Y.Map Point (a lane's keyframes: pos = timeline samples, value = normalised 0..1 of the param's range)
//   samples Y.Map  hash -> plain object SampleMeta
//   chat    Y.Array of plain ChatMessage, append-only; outside the undo scope
import { parseMentions } from './mentions.ts'
import * as Y from 'yjs'
import { DEVICES, LOFI_DRUM, MIX, MIX_GAIN, MIX_PAN } from './devices.ts'
import type { ParamTarget } from './params.ts'
import { defaultRegion, normalizeRegions, timeMap, type TimeMap } from './timemap.ts'

export const SCHEMA_VERSION = 4
export const DEFAULT_SAMPLE_RATE = 48000
export const DEFAULT_PPQ = 960
export const DEFAULT_MIDI_BPM = 120

/**
 * A run of bars from `bar` (1-based) up to the next region's `bar`. Regions partition the timeline: there is always one at bar 1,
 * and no two share a bar (`normalizeRegions` enforces both as a view; `repairRegions` writes it back).
 * metered: every bar is `num`/`den` (beats grouped by `groups` when given, e.g. [2,2,3] for 7/8), at `bpm` quarter notes per
 *          minute; with `rampTo`, the tempo moves linearly in musical time from `bpm` at the region's first beat to `rampTo`
 *          at the next region (ignored in the last region).
 * free:    exactly one bar, `length` samples long, with no beats inside. Its tempo for tick arithmetic is the previous region's.
 */
export type Region =
  | { id: string; bar: number; kind: 'metered'; bpm: number; num: number; den: number; groups?: number[]; rampTo?: number }
  | { id: string; bar: number; kind: 'free'; length: number }
/** A rehearsal mark / section start at a bar (beat 1). `label` is short ("A", "Verse 2"), `text` optional. */
export type Marker = { id: string; bar: number; label: string; text?: string }

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
export type Track = { id: string; name: string; kind: TrackKind; order: number; muted: boolean; soloed: boolean; role?: TrackRole; color?: number; preset?: string }
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
 * `startTick` is the clip's place on the project timeline: ticks from bar 1 beat 1 at `meta.ppq`. Notes keep clip-local
 * `tick`/`durTicks`; a note's global tick is `startTick + tick`. Ticks may be fractional (never rounded on write). Samples come
 * from the time map (`midiClipStartSample` etc.), so a tempo edit moves MIDI and leaves audio where it is.
 */
export type MidiClip = { id: string; trackId: string; kind: 'midi'; startTick: number; lengthTicks: number; loopTicks?: number; forever?: boolean; view?: 'drums' }
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
/** `system: true` marks a message the app wrote (a migration note), not a person: render it as a notice. `username` is then SYSTEM_USER. */
export type ChatMessage = { id: string; username: string; color: string; text: string; ts: number; system?: boolean
  /** Display names mentioned (`@name`, `@name(api)`), set when the message was sent. Absent on older messages: parse the text then. */
  mentions?: string[] }
export const SYSTEM_USER = 'mobdaw'
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
export const regionsMap = (doc: Y.Doc) => doc.getMap<YM>('regions')
export const markersMap = (doc: Y.Doc) => doc.getMap<YM>('markers')
export const chatLog = (doc: Y.Doc) => doc.getArray<ChatMessage>('chat')

/** Types to pass to `new Y.UndoManager(undoScope(doc), { trackedOrigins })`. */
export const undoScope = (doc: Y.Doc) => [
  metaMap(doc), tracksMap(doc), clipsMap(doc), notesMap(doc), devicesMap(doc), loopersMap(doc), padsMap(doc), lanesMap(doc), pointsMap(doc), regionsMap(doc), markersMap(doc),
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
/** Project tick resolution (ticks per quarter note). */
export const getPpq = (doc: Y.Doc): number => (metaMap(doc).get('ppq') as number | undefined) ?? DEFAULT_PPQ
/** The project key for display ("D minor"), if one is set. */
export const getKey = (doc: Y.Doc): string | undefined => (metaMap(doc).get('key') as string | undefined) || undefined
export const setKey = (doc: Y.Doc, key: string | undefined) => doc.transact(() => (key ? metaMap(doc).set('key', key) : metaMap(doc).delete('key')))

/** Ticks -> samples at one constant tempo (docs/engine.md §2). Not for clips: they go through the time map. */
export const ticksToSamples = (ticks: number, bpm: number, ppq: number, rate: number) =>
  Math.round((ticks * 60 * rate) / (bpm * ppq))

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

// --- timeline: regions, markers, the cached time map
/** Raw stored regions, unsorted, possibly invalid after concurrent edits. Prefer `getRegions`. */
const rawRegions = (doc: Y.Doc) => all<Region>(regionsMap(doc))
/** The regions as every client sees them: normalized (one at bar 1, none sharing a bar, sorted; see `normalizeRegions`). */
export const getRegions = (doc: Y.Doc): Region[] => normalizeRegions(rawRegions(doc))
/** The region in effect at `bar`. */
export const regionAtBar = (doc: Y.Doc, bar: number): Region => {
  const rs = getRegions(doc)
  let r = rs[0]
  for (const x of rs) if (x.bar <= bar) r = x
  return r
}

/** Fields a region may be given. `groups`/`rampTo` as `undefined` clear them. */
export type RegionPatch = { bpm?: number; num?: number; den?: number; groups?: number[] | undefined; rampTo?: number | undefined; length?: number; kind?: 'metered' | 'free' }
type NewRegion = { bar: number } & (
  | { kind?: 'metered'; bpm: number; num: number; den: number; groups?: number[]; rampTo?: number }
  | { kind: 'free'; length: number }
)

/**
 * Add a region at `bar`, or, when a region already starts there, replace its contents (keeping its id): no two regions share a bar.
 * Adding a *free* region where no region starts on the next bar also adds a metered region at bar+1 that carries on with the
 * meter and tempo that were in effect (without a ramp), so the free bar doesn't change what follows it. One transaction.
 * Returns the region's id.
 */
export function addRegion(doc: Y.Doc, r: NewRegion): string {
  const bar = Math.max(1, Math.round(r.bar))
  const rs = getRegions(doc)
  const here = rs.find((x) => x.bar === bar)
  const before = here ?? regionAtBar(doc, bar)
  const id = here?.id ?? newId()
  doc.transact(() => {
    const fields = r.kind === 'free' ? { kind: 'free', length: r.length } : { kind: 'metered', bpm: r.bpm, num: r.num, den: r.den, ...(r.groups ? { groups: r.groups } : {}), ...(r.rampTo != null ? { rampTo: r.rampTo } : {}) }
    regionsMap(doc).set(id, toMap({ id, bar, ...fields }))
    if (r.kind === 'free' && !rs.some((x) => x.bar === bar + 1)) {
      const prev = before.kind === 'metered' ? before : (rs.filter((x) => x.kind === 'metered' && x.bar < bar).at(-1) as Extract<Region, { kind: 'metered' }> | undefined) ?? (defaultRegion() as Extract<Region, { kind: 'metered' }>)
      const nid = newId()
      regionsMap(doc).set(nid, toMap({ id: nid, bar: bar + 1, kind: 'metered', bpm: prev.bpm, num: prev.num, den: prev.den, ...(prev.groups ? { groups: prev.groups } : {}) }))
    }
  })
  return id
}
/**
 * Edit a region in place (tempo, meter, groups, ramp, free length, or `kind` to switch between metered and free: the other kind's
 * fields are dropped, and a switch to metered without bpm/num/den takes the meter in effect before it). Its `bar` doesn't change here.
 * Returns false if the region is unknown.
 */
export function setRegion(doc: Y.Doc, id: string, patch: RegionPatch): boolean {
  const m = regionsMap(doc).get(id)
  if (!m) return false
  doc.transact(() => {
    const kind = patch.kind ?? (m.get('kind') as Region['kind'])
    if (kind !== m.get('kind')) {
      const bar = m.get('bar') as number
      const prev = getRegions(doc).filter((x) => x.kind === 'metered' && x.bar < bar).at(-1) as Extract<Region, { kind: 'metered' }> | undefined
      for (const k of [...m.keys()]) if (k !== 'id' && k !== 'bar') m.delete(k)
      m.set('kind', kind)
      if (kind === 'free') m.set('length', patch.length ?? DEFAULT_SAMPLE_RATE)
      else {
        m.set('bpm', patch.bpm ?? prev?.bpm ?? 120)
        m.set('num', patch.num ?? prev?.num ?? 4)
        m.set('den', patch.den ?? prev?.den ?? 4)
      }
    }
    const allowed = kind === 'free' ? ['length'] : ['bpm', 'num', 'den', 'groups', 'rampTo']
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'kind' || !allowed.includes(k)) continue
      if (v === undefined) m.delete(k)
      else m.set(k, v)
    }
    // a changed numerator invalidates old groups (they must sum to it)
    if (kind === 'metered' && patch.num != null && patch.groups === undefined && !('groups' in patch)) {
      const g = m.get('groups') as number[] | undefined
      if (g && g.reduce((a, b) => a + b, 0) !== patch.num) m.delete('groups')
    }
  })
  return true
}
/**
 * Delete a region: the previous region simply runs on over its bars (a merge into the previous). The region at bar 1 cannot be
 * deleted (returns false), nor can an unknown id. A same-bar duplicate of the bar-1 region that lost to a smaller id can be.
 */
export function deleteRegion(doc: Y.Doc, id: string): boolean {
  const m = regionsMap(doc).get(id)
  if (!m) return false
  const first = getRegions(doc)[0]
  if (first.id === id) return false
  doc.transact(() => regionsMap(doc).delete(id))
  return true
}
/**
 * Write `normalizeRegions` back: drop same-bar losers (smallest id wins) and add the default region at bar 1 when none exists. Writes nothing
 * when the stored regions are already valid. Run on open and from `sweepOrphans`; concurrent runs write the same thing (the synthesized
 * region has a fixed id).
 */
export function repairRegions(doc: Y.Doc) {
  const raw = rawRegions(doc)
  const want = normalizeRegions(raw)
  const keep = new Set(want.map((r) => r.id))
  const missing = want.filter((r) => !regionsMap(doc).has(r.id))
  if (raw.every((r) => keep.has(r.id)) && !missing.length) return
  doc.transact(() => {
    for (const r of raw) if (!keep.has(r.id)) regionsMap(doc).delete(r.id)
    for (const r of missing) regionsMap(doc).set(r.id, toMap(r))
  })
}

export const getMarkers = (doc: Y.Doc): Marker[] => all<Marker>(markersMap(doc)).sort((a, b) => a.bar - b.bar || (a.id < b.id ? -1 : 1))
export function addMarker(doc: Y.Doc, m: Pick<Marker, 'bar' | 'label'> & Partial<Pick<Marker, 'text'>>): string {
  const id = newId()
  doc.transact(() => markersMap(doc).set(id, toMap({ id, bar: Math.max(1, Math.round(m.bar)), label: m.label, ...(m.text ? { text: m.text } : {}) } satisfies Marker)))
  return id
}
/** `text: ''`/undefined clears the description. */
export function updateMarker(doc: Y.Doc, id: string, patch: Partial<Pick<Marker, 'bar' | 'label' | 'text'>>) {
  const m = markersMap(doc).get(id)
  if (!m) return
  doc.transact(() => {
    if (patch.bar != null) m.set('bar', Math.max(1, Math.round(patch.bar)))
    if (patch.label != null) m.set('label', patch.label)
    if ('text' in patch) (patch.text ? m.set('text', patch.text) : m.delete('text'))
  })
}
export const deleteMarker = (doc: Y.Doc, id: string) => doc.transact(() => markersMap(doc).delete(id))

type MapCache = { map: TimeMap | null }
const mapCaches = new WeakMap<Y.Doc, MapCache>()
/**
 * The project's time map (regions + sample rate + ppq), cached per doc and rebuilt after any change to `regions` or `meta`. Cheap to
 * call per frame. Inside an open transaction that touched those maps it is rebuilt every call (observers have not run yet). A map
 * is immutable: after an edit, hold on to the new one `getTimeMap` returns.
 */
export function getTimeMap(doc: Y.Doc): TimeMap {
  let c = mapCaches.get(doc)
  if (!c) {
    const cache: MapCache = { map: null }
    c = cache
    mapCaches.set(doc, cache)
    const regions: unknown = regionsMap(doc), meta: unknown = metaMap(doc)
    doc.on('beforeObserverCalls', (tr) => {
      for (const t of tr.changed.keys()) if (t === regions || t === meta || t.parent === regions) return void (cache.map = null)
    })
  }
  if (c.map && !(doc as unknown as { _transaction: unknown })._transaction) return c.map
  const map = timeMap(rawRegions(doc), getSampleRate(doc), getPpq(doc))
  c.map = map
  return map
}

/** Timeline sample of a MIDI clip's start / end (its finite extent), through the time map. `src` is the doc or a map. */
const mapOf = (src: Y.Doc | TimeMap): TimeMap => ('tickToSample' in src ? src : getTimeMap(src))
export const midiClipStartSample = (src: Y.Doc | TimeMap, c: Pick<MidiClip, 'startTick'>) => mapOf(src).tickToSample(c.startTick)
export const midiClipEndSample = (src: Y.Doc | TimeMap, c: Pick<MidiClip, 'startTick' | 'lengthTicks'>) => mapOf(src).tickToSample(c.startTick + c.lengthTicks)
/** A MIDI clip's start / end / pass-end ticks on the project timeline, and its sample position for a clip-local tick. */
export const midiClipEndTick = (c: Pick<MidiClip, 'startTick' | 'lengthTicks'>) => c.startTick + c.lengthTicks
export const midiNoteSample = (src: Y.Doc | TimeMap, c: Pick<MidiClip, 'startTick'>, tick: number) => mapOf(src).tickToSample(c.startTick + tick)
/** A clip's start on the timeline in samples (audio: stored; MIDI: via the map). */
export const clipStart = (c: Clip, src: Y.Doc | TimeMap) => (c.kind === 'audio' ? c.start : midiClipStartSample(src, c))
/** A clip's extent in samples. A MIDI clip's depends on the tempo where it sits. */
export const clipLength = (c: Clip, src: Y.Doc | TimeMap) => (c.kind === 'audio' ? c.length : midiClipEndSample(src, c) - midiClipStartSample(src, c))
export const clipEnd = (c: Clip, src: Y.Doc | TimeMap) => clipStart(c, src) + clipLength(c, src)

// --- tracks
export function addTrack(doc: Y.Doc, name: string, kind: TrackKind = 'audio', order?: number, role?: TrackRole, color?: number): string {
  const id = newId()
  const t: Track = { id, name, kind, order: order ?? orderBetween(getTracks(doc).at(-1)?.order), muted: false, soloed: false, ...(role ? { role } : {}), ...(color != null ? { color } : {}) }
  doc.transact(() => {
    tracksMap(doc).set(id, toMap(t))
    ensureMixDevice(doc, id)
    if (kind === 'soundscape') for (let slot = 0; slot < LOOPERS_PER_TRACK; slot++) addLooper(doc, id, slot)
  })
  return id
}
export const updateTrack = (doc: Y.Doc, id: string, patch: Partial<Omit<Track, 'id'>>) => patchMap(doc, tracksMap(doc).get(id), patch)

export function deleteTrack(doc: Y.Doc, id: string) {
  doc.transact(() => {
    for (const c of getClips(doc)) if (c.trackId === id) deleteClip(doc, c.id)
    for (const d of getDevices(doc)) if (d.trackId === id) dropDevice(doc, d.id)
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

export function addMidiClip(doc: Y.Doc, c: Pick<MidiClip, 'trackId' | 'startTick'> & Partial<Omit<MidiClip, 'id' | 'kind'>>): string {
  const id = newId()
  const clip: MidiClip = { lengthTicks: 16 * getPpq(doc), ...c, id, kind: 'midi' }
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
/**
 * Append a device to a track's chain with default params (just before the pinned mix device, which stays last). A mix device
 * is made through `ensureMixDevice`, so there is only ever one.
 */
export function addDevice(doc: Y.Doc, trackId: string, type: number, extra: Partial<Pick<Device, 'name' | 'keyLo' | 'keyHi'>> = {}, initial: Record<string, number> = {}): string {
  if (type === MIX) return ensureMixDevice(doc, trackId)
  const id = newId()
  const order = orderInChain(doc, trackId)
  doc.transact(() => {
    const m = toMap({ id, trackId, type, order, bypass: false, ...extra })
    const params = new Y.Map<number>()
    for (const p of DEVICES[type]?.params ?? []) params.set(String(p.id), initial[String(p.id)] ?? p.def)
    m.set('params', params)
    devicesMap(doc).set(id, m)
  })
  return id
}
/** A device's `order` kept below the pinned mix device of its chain. */
const beforeMix = (doc: Y.Doc, d: Pick<Device, 'id' | 'trackId' | 'type'>, order: number) => {
  const mix = d.type === MIX ? undefined : getMixDevice(doc, d.trackId)
  if (!mix || order < mix.order) return order
  return orderBetween(getDevices(doc).filter((x) => x.trackId === d.trackId && x.id !== d.id && x.id !== mix.id).at(-1)?.order, mix.order)
}
/** The `order` that puts a new device at the end of `trackId`'s chain, before its mix device. */
const orderInChain = (doc: Y.Doc, trackId: string) => {
  const chain = getDevices(doc).filter((d) => d.trackId === trackId)
  const mix = chain.find((d) => d.type === MIX)
  return orderBetween(chain.filter((d) => d !== mix).at(-1)?.order, mix?.order)
}
/** The mix device is pinned last and always on: its `order` and `bypass` are ignored here. */
export function updateDevice(doc: Y.Doc, id: string, patch: Partial<Pick<Device, 'order' | 'bypass' | 'name' | 'keyLo' | 'keyHi'>>) {
  const m = devicesMap(doc).get(id)
  if (!m) return
  if (m.get('type') === MIX) {
    const { order: _o, bypass: _b, ...rest } = patch
    return patchMap(doc, m, rest)
  }
  patchMap(doc, m, patch.order == null ? patch : { ...patch, order: beforeMix(doc, m.toJSON() as Device, patch.order) })
}
export function setParam(doc: Y.Doc, deviceId: string, paramId: number, value: number) {
  const params = devicesMap(doc).get(deviceId)?.get('params') as Y.Map<number> | undefined
  params?.set(String(paramId), value)
}
/** The mix device of a track (or `MASTER_TRACK`), or undefined before `ensureMixDevice` has made it. */
export const getMixDevice = (doc: Y.Doc, scope: string) => getDevices(doc).find((d) => d.trackId === scope && d.type === MIX)
/** Set a mix device param: `gain` (linear, 0..2) or `pan` (-1..1). */
export function setMixParam(doc: Y.Doc, scope: string, which: 'gain' | 'pan', value: number) {
  const d = getMixDevice(doc, scope)
  if (d) setParam(doc, d.id, which === 'gain' ? MIX_GAIN : MIX_PAN, value)
}
/** A mix device's `gain` and `pan` (unity and centre while it is missing). */
export function getMix(doc: Y.Doc, scope: string): { gain: number; pan: number } {
  const p = getMixDevice(doc, scope)?.params
  return { gain: p?.[MIX_GAIN] ?? 1, pan: p?.[MIX_PAN] ?? 0 }
}
const mixId = (scope: string) => `mix:${scope}`
/**
 * Make sure `scope` (a track id or `MASTER_TRACK`) has exactly one mix device, last in its chain. The id is a function of the
 * scope, so clients doing this at once write the same entry. `seed` sets the params of a device made now. Writes nothing when
 * all is in order. Returns the device's id.
 */
export function ensureMixDevice(doc: Y.Doc, scope: string, seed: { gain?: number; pan?: number } = {}): string {
  const all = getDevices(doc).filter((d) => d.trackId === scope)
  const mixes = all.filter((d) => d.type === MIX).sort((a, b) => (a.id === mixId(scope) ? -1 : b.id === mixId(scope) ? 1 : a.id < b.id ? -1 : 1))
  const keep = mixes[0]
  doc.transact(() => {
    for (const d of mixes.slice(1)) dropDevice(doc, d.id)
    if (!keep) {
      const params = new Y.Map<number>()
      params.set(String(MIX_GAIN), seed.gain ?? 1)
      params.set(String(MIX_PAN), seed.pan ?? 0)
      const m = toMap({ id: mixId(scope), trackId: scope, type: MIX, order: orderBetween(all.at(-1)?.order), bypass: false })
      m.set('params', params)
      devicesMap(doc).set(mixId(scope), m)
    } else {
      const m = devicesMap(doc).get(keep.id)!
      if (keep.bypass) m.set('bypass', false)
      const rest = all.filter((d) => d.id !== keep.id)
      if (rest.length && rest.some((d) => d.order >= keep.order)) m.set('order', orderBetween(Math.max(...rest.map((d) => d.order))))
    }
  })
  return keep?.id ?? mixId(scope)
}
/** A mix device goes with its track and nowhere else. */
const pinned = (doc: Y.Doc, id: string) => {
  const m = devicesMap(doc).get(id)
  return m?.get('type') === MIX && (m.get('trackId') === MASTER_TRACK || tracksMap(doc).has(m.get('trackId') as string))
}
/** Delete a device and its lanes. A track's (or master's) mix device stays: it is deleted with its track. */
export function deleteDevice(doc: Y.Doc, id: string) {
  if (!pinned(doc, id)) dropDevice(doc, id)
}
function dropDevice(doc: Y.Doc, id: string) {
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
/** How many ticks "forever" covers for a MIDI clip starting at `startTick`: 24 hours of the map's time from its start. */
export const foreverTicks = (map: TimeMap, startTick: number) => map.sampleToTick(map.tickToSampleExact(startTick) + FOREVER_SECONDS * map.sampleRate) - startTick

/**
 * The metronome: a MIDI track named "click" (`role: 'click'`, first in the list) with two lofi drums, "accent" (the higher,
 * brighter one) and "tick". It has no clip: the host generates its beats from the time map (client/src/audio/click.ts). One transaction,
 * so one undo step. Returns the track id.
 */
export function addClickTrack(doc: Y.Doc): string {
  let id = ''
  doc.transact(() => {
    id = addTrack(doc, 'click', 'midi', orderBetween(undefined, getTracks(doc)[0]?.order), 'click')
    const accent = 37, tick = 36
    addDrum(doc, id, { key: accent, name: 'accent', params: { 0: 3500, 1: 0.8, 2: 40, 3: 0.8 } })
    addDrum(doc, id, { key: tick, name: 'tick', params: { 0: 1500, 1: 0.65, 2: 35, 3: 0.6 } })
    // no clip: what it plays is generated from the time map (client/src/audio/click.ts)
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
/** `handles`: the known mention handles (project members and who is here); the mentions in the text are stored with the message. */
export function addChatMessage(doc: Y.Doc, user: AwarenessState['user'], text: string, handles: string[] = []): string | null {
  const t = text.trim().slice(0, CHAT_MAX)
  if (!t) return null
  const id = newId()
  const mentions = parseMentions(t, handles)
  chatLog(doc).push([{ id, username: user.username, color: user.color, text: t, ts: Date.now(), ...(mentions.length ? { mentions } : {}) }])
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
  if (isFutureDoc(doc)) return
  repairRegions(doc)
  doc.transact(() => {
    const tracks = tracksMap(doc), clips = clipsMap(doc)
    for (const c of getClips(doc)) if (!tracks.has(c.trackId)) deleteClip(doc, c.id)
    for (const d of getDevices(doc)) if (d.trackId !== MASTER_TRACK && !tracks.has(d.trackId)) dropDevice(doc, d.id)
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
    meta.set('schemaVersion', 2)
  }, 'migrate')
}

/**
 * v2 -> v3: a track's `gain` and `pan` move into a mix device (see `ensureMixDevice`), seeded from them, and the master bus
 * gets one at unity and centre. Also the load-time repair, so it runs on every load and writes nothing when all is in order:
 * one mix device per track and for the master, last in its chain. Run `migrateToV2` first. Origin 'migrate' keeps it out of undo.
 */
export function migrateToV3(doc: Y.Doc) {
  if (isFutureDoc(doc)) return
  const meta = metaMap(doc)
  doc.transact(() => {
    const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def)
    for (const t of tracksMap(doc).values()) {
      const id = t.get('id') as string
      ensureMixDevice(doc, id, { gain: num(t.get('gain'), 1), pan: num(t.get('pan'), 0) })
      t.delete('gain')
      t.delete('pan')
    }
    ensureMixDevice(doc, MASTER_TRACK)
    const v = meta.get('schemaVersion')
    if (typeof v === 'number' && v < 3) meta.set('schemaVersion', 3)
  }, 'migrate')
}
/** A forever audio clip's length in samples (what the engine is sent). */
export const foreverSamples = (rate: number) => FOREVER_SECONDS * rate
/** A clip's pass in samples: its loop when it loops, else its whole (finite) length. */
export const passLength = (c: Clip, src: Y.Doc | TimeMap) =>
  c.kind === 'audio' ? (isLooping(c) ? c.loopLength! : c.length) : mapOf(src).tickToSample(c.startTick + patternTicks(c)) - midiClipStartSample(src, c)

/**
 * Whether the doc was written by a newer client (`meta.schemaVersion` above `SCHEMA_VERSION`). This client must not write into it: an
 * older shape written into a newer doc is silent corruption. The migrations and `sweepOrphans` do nothing for such a doc; the UI should
 * call this after the first sync and open the project read-only with a "reload for the latest version" notice. (Clients deployed before
 * v4 have no such check: docs/todo.md.)
 */
export const isFutureDoc = (doc: Y.Doc): boolean => {
  const v = metaMap(doc).get('schemaVersion')
  return typeof v === 'number' && v > SCHEMA_VERSION
}

/** Append a message from the app itself (rendered as a notice, not a person). A fixed `id` writes it once: a repeat is skipped. */
export function addSystemMessage(doc: Y.Doc, text: string, id: string = newId()): string | null {
  const t = text.trim().slice(0, CHAT_MAX)
  if (!t || chatLog(doc).toArray().some((m) => m.id === id)) return null
  chatLog(doc).push([{ id, username: SYSTEM_USER, color: 'hsl(0 0% 60%)', text: t, ts: Date.now(), system: true }])
  return id
}

/** Make sure the timeline basics exist: `meta.ppq`, and a valid regions map (a default 120 bpm 4/4 region at bar 1). Writes nothing when in order. Fresh docs call this once. */
export function ensureTimeline(doc: Y.Doc) {
  if (metaMap(doc).get('ppq') == null) doc.transact(() => metaMap(doc).set('ppq', DEFAULT_PPQ))
  repairRegions(doc)
}

type LegacyMidi = { id: string; trackId: string; start: number; bpm: number; ppq: number; lengthTicks: number; loopTicks?: number }
const legacyMidiClips = (doc: Y.Doc): LegacyMidi[] =>
  getClips(doc).filter((c) => c.kind === 'midi' && (c as unknown as { startTick?: number }).startTick == null).map((c) => {
    const o = c as unknown as Partial<LegacyMidi>
    return { id: c.id, trackId: c.trackId, start: Number(o.start) || 0, bpm: o.bpm && o.bpm > 0 ? o.bpm : DEFAULT_MIDI_BPM, ppq: o.ppq && o.ppq > 0 ? o.ppq : DEFAULT_PPQ, lengthTicks: Number(o.lengthTicks) || 0, ...(o.loopTicks ? { loopTicks: o.loopTicks } : {}) }
  })

/**
 * v3 -> v4: one shared timeline (docs/engine.md §3). Idempotent, origin 'migrate' (out of undo), and a pure function of the old doc, so
 * clients migrating at once write the same thing (fixed region ids). Run after `migrateToV2`/`V3`. Does nothing for a doc from the future.
 *  1. Picks the tempo map: the click track's clip gives bpm, `loopTicks/ppq` quarters per bar as n/4, and its start (a start other than 0
 *     becomes a leading free region of that length, then the metered region from bar 2); else the bpm carrying the most MIDI time (120 if none), 4/4.
 *  2. Converts every legacy MIDI clip (`start`/`bpm`/`ppq`): `startTick = sampleToTick(start)`, and the notes' `tick`/`durTicks` and the clip's
 *     `lengthTicks`/`loopTicks` scale by (mapBpm/clipBpm)*(meta.ppq/clip.ppq), so every note starts and ends on the same sample (+-1). A clip that
 *     straddles the end of a leading free region cannot be (the tempo changes under it); it is rare and uses the tempo where it starts.
 *  3. Audio, pads, loopers and automation are untouched.
 *  4. Appends one system chat message (`addSystemMessage`, id 'migrate-v4') summarising the map and the clips now off the grid. Not written
 *     when the doc has no MIDI clips.
 * Also the repair for fresh docs: `ensureTimeline`.
 */
export function migrateToV4(doc: Y.Doc) {
  if (isFutureDoc(doc)) return
  const meta = metaMap(doc)
  const legacy = legacyMidiClips(doc)
  const sv = meta.get('schemaVersion')
  if (typeof sv === 'number' && sv >= 4 && !legacy.length) return ensureTimeline(doc)
  if (typeof sv !== 'number') return // not even v2 yet
  const v: number = sv
  const rate = getSampleRate(doc)
  doc.transact(() => {
    const ppq = DEFAULT_PPQ
    if (meta.get('ppq') == null) meta.set('ppq', ppq)
    let regions = rawRegions(doc)
    let mapBpm = 120, num = 4
    if (!regions.length && v < 4) {
      const tracks = new Map(getTracks(doc).map((t) => [t.id, t]))
      const clicks = legacy.filter((c) => tracks.get(c.trackId)?.role === 'click').sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1))
      const click = clicks[0]
      let leading = 0
      if (click) {
        mapBpm = click.bpm
        const q = (click.loopTicks || click.lengthTicks) / click.ppq
        num = Number.isInteger(q) && q >= 1 && q <= 64 ? q : 4
        leading = Math.max(0, Math.round(click.start))
      } else if (legacy.length) {
        const totals = new Map<number, number>()
        for (const c of legacy) totals.set(c.bpm, (totals.get(c.bpm) ?? 0) + (c.lengthTicks * 60 * rate) / (c.bpm * c.ppq))
        mapBpm = [...totals].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
      }
      const metered = (id: string, bar: number): Region => ({ id, bar, kind: 'metered', bpm: mapBpm, num, den: 4 })
      const made: Region[] = leading > 0 ? [{ id: 'default', bar: 1, kind: 'free', length: leading }, metered('migrate-2', 2)] : [metered('default', 1)]
      for (const r of made) regionsMap(doc).set(r.id, toMap(r))
      regions = made
    }
    const map = timeMap(regions, rate, ppq)
    const trackName = new Map(getTracks(doc).map((t) => [t.id, t.name]))
    const off: string[] = []
    const notes = getNotes(doc)
    for (const c of legacy) {
      const startTick = map.sampleToTick(c.start)
      const sp = map.spanAt(startTick)
      const f = (sp.bpm0 / c.bpm) * (ppq / c.ppq)
      const m = clipsMap(doc).get(c.id)!
      m.set('startTick', startTick)
      m.set('lengthTicks', c.lengthTicks * f)
      if (c.loopTicks) m.set('loopTicks', c.loopTicks * f)
      for (const k of ['start', 'bpm', 'ppq']) m.delete(k)
      for (const n of notes) {
        if (n.clipId !== c.id) continue
        const nm = notesMap(doc).get(n.id)!
        nm.set('tick', n.tick * f)
        nm.set('durTicks', n.durTicks * f)
      }
      if (Math.abs(c.bpm - sp.bpm0) > 1e-9 && sp.region.kind === 'metered') off.push(`'${trackName.get(c.trackId) ?? 'midi'}' at bar ${map.position(startTick).bar}`)
    }
    // the click's stored pattern only chose the map above: the click is generated from the map now, so its clips go
    const clickTracks = new Set(getTracks(doc).filter((t) => t.role === 'click').map((t) => t.id))
    const clickClips = new Set(legacy.filter((c) => clickTracks.has(c.trackId)).map((c) => c.id))
    for (const n of notes) if (clickClips.has(n.clipId)) notesMap(doc).delete(n.id)
    for (const id of clickClips) clipsMap(doc).delete(id)
    if (legacy.some((c) => !clickClips.has(c.id)) && v < 4) {
      const first = map.regions[0]
      const m = map.regions.find((r) => r.kind === 'metered') as Extract<Region, { kind: 'metered' }> | undefined
      let text = `migrated to a shared timeline at ${+(m?.bpm ?? 120).toFixed(2)} bpm ${m?.num ?? 4}/${m?.den ?? 4}`
      if (first.kind === 'free') text += `, with a ${+(first.length / rate).toFixed(2)} s free region before bar 2`
      if (off.length) text += `; ${off.length} MIDI clip${off.length === 1 ? ' had its' : 's had their'} own tempo and ${off.length === 1 ? 'is' : 'are'} now off the grid: ${off.join(', ')}`
      addSystemMessage(doc, text, 'migrate-v4')
    }
    meta.set('schemaVersion', 4)
  }, 'migrate')
}
