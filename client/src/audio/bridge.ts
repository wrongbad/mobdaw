// Turns Yjs doc changes into engine commands (docs/engine-api.md). Pure: it talks to an
// EngineSink, so tests can use a fake engine. Each change reconciles the touched entities
// by id: present and parented -> upsert, otherwise -> remove. Command order never matters.
import * as Y from 'yjs'
import {
  KEY_MAX, KEY_MIN, LFO_DEFAULTS, foreverSamples, foreverTicks, isForever, LOOP_CUTOFF_MAX, MASTER_TRACK, SCALE_CODE, clipsMap, devicesMap, getClips, getDevices, getLanes, getLoopers, getNotes, getPads, getPoints, lanesMap,
  getLoop, looperParamDef, loopersMap, metaMap, notesMap, padsMap, paramToPos, pointsMap, resolveTarget, samplesMap, tracksMap,
  type AudioClip, type Clip, type Device, type Lane, type Looper, type MidiClip, type Pad, type Note, type ParamTarget, type Point, type SampleMeta, type Track,
} from '@mobdaw/shared'
import type { MetersMessage } from './meters'

export interface EngineSink {
  call(fn: string, ...args: number[]): void
  /** Hand decoded PCM to the engine (the real sink transfers the buffers). */
  source(h: number, channels: Float32Array[], frames: number): void
  /** Like `call`, but applied by the engine at timeline sample `at` (EngineHost.callAt). A sink without it applies at once. */
  callAt?(at: number, fn: string, ...args: number[]): void
}

/** How far ahead of a recording a live source keeps room, in seconds (topped up by the Recorder with every ~1 s chunk). */
export const LIVE_HEADROOM_S = 30

/**
 * An audio clip that exists only in the engine (the loop pedal's live loops), in the engine's own terms: `length` is what the
 * engine is sent (a forever clip is 24 hours of samples), and `source` is an engine source handle (usually a live one).
 */
export type LiveClip = {
  source: number
  start: number
  length: number
  sourceOffset?: number
  gain?: number
  fadeIn?: number
  fadeOut?: number
  fadeShape?: number
  loopLength?: number
  loopPhase?: number
}
const LIVE_DEFAULTS = { sourceOffset: 0, gain: 1, fadeIn: 0, fadeOut: 0, fadeShape: 0, loopLength: 0, loopPhase: 0 }
/** Decode a source at the project rate. Resolve null to skip it (e.g. too long to play). */
export type SourceLoader = (hash: string, meta: SampleMeta) => Promise<Float32Array[] | null>
export type Drag = { deviceId: string; paramId: number; value: number }

/** Peak levels for the UI: linear (0..1, above 1 is clipping), keyed by doc track id. */
export type Meters = { master: [number, number]; tracks: Map<string, [number, number]> }

/** Map a meters message's engine track handles to doc track ids (`idOf`); handles it doesn't know are dropped. */
export function mapMeters(m: MetersMessage, idOf: (h: number) => string | undefined): Meters {
  const tracks = new Map<string, [number, number]>()
  for (let i = 0; i + 2 < m.tracks.length; i += 3) {
    const id = idOf(m.tracks[i])
    if (id != null) tracks.set(id, [m.tracks[i + 1], m.tracks[i + 2]])
  }
  return { master: [m.master[0], m.master[1]], tracks }
}

/**
 * A transport's position, as the main thread knows it: the engine reports now and then, and in
 * between the position is extrapolated from the clock. The timeline and every preview use one.
 */
export class Clock {
  private pos = 0
  private playing = false
  private posAt = 0
  /** The transport cycle the engine applies (`Engine::set_loop`), so the extrapolated position wraps like the engine's. */
  loop: { start: number; end: number } | null = null
  constructor(private rate: number, private now: () => number) {}
  /** Start at `from` (default: where it stopped); returns the start position. */
  play(from = this.pos) {
    this.pos = from
    this.playing = true
    this.posAt = this.now()
    return from
  }
  stop() {
    this.pos = this.position()
    this.playing = false
  }
  seek(pos: number) {
    this.pos = pos
    this.posAt = this.now()
  }
  /** An engine position report. */
  report(m: { pos: number; playing: boolean }) {
    this.pos = m.pos
    this.playing = m.playing
    this.posAt = this.now()
  }
  get isPlaying() {
    return this.playing
  }
  position() {
    if (!this.playing) return this.pos
    const x = this.pos + ((this.now() - this.posAt) / 1000) * this.rate
    const l = this.loop
    // Only reaching the end from before it wraps (a playhead already past it plays on), as in the engine.
    return l && this.pos < l.end && x >= l.end ? l.start + ((x - l.end) % (l.end - l.start)) : x
  }
}

/** `source`: the soundscape's source audio straight through; `loops`: its loopers, continuously. */
export type PreviewMode = 'source' | 'loops'
export type PreviewTransport = {
  readonly playing: boolean
  position(): number
  play(from?: number): void
  stop(): void
  seek(pos: number): void
}

/** The engine's handle for the master bus (`MASTER_TRACK` in engine.rs). */
const MASTER_HANDLE = 0xffffffff
type Kind = 'track' | 'clip' | 'note' | 'device' | 'looper' | 'pad' | 'lane' | 'point'
const key = (d: string, p: number) => `${d}:${p}`
type Dirty = { all: boolean; fields: boolean; params: Set<string> }
const ALL: Dirty = { all: true, fields: true, params: new Set() }

export class Bridge {
  private handles: Record<Kind | 'source', Map<string, number>> = {
    track: new Map(), clip: new Map(), note: new Map(), device: new Map(), looper: new Map(), pad: new Map(), lane: new Map(), point: new Map(),
    source: new Map(),
  }
  /** What each lane in the engine automates, to give the param its static value back when the lane goes away. */
  private laneTargets = new Map<string, ParamTarget>()
  /** Lanes whose engine copy is in LFO mode (so leaving it is sent once, and the centre follows the knob). */
  private lfoLanes = new Set<string>()
  private next = 1 // never reused, shared by all kinds (unique per kind is all the contract needs)
  private requested = new Set<string>()
  private wanted = new Set<string>()
  private overrides = new Map<string, number>()
  private unobserve: (() => void)[] = []
  private clock: Clock
  private previews = new Map<string, { h: number; clock: Clock }>()
  private previewClocks = new Map<number, Clock>()
  private heads = new Map<number, number>()
  private headsAt = -Infinity
  /** Engine-only clips by engine handle (see liveClip), until a doc clip adopts them. */
  private ephemeral = new Map<number, { track: number; c: Required<LiveClip> }>()
  /** Doc track id by engine handle, for the meters. */
  private trackIds = new Map<number, string>()
  /** A take is being recorded: the cycle is off meanwhile (a take is one continuous stretch of the timeline). */
  private recording = false
  /** The `engine_set_loop` arguments last sent, to send only changes. */
  private sentLoop = '0,0,0'

  constructor(
    private doc: Y.Doc,
    private sink: EngineSink,
    private loadSource: SourceLoader,
    private rate: number,
    private now: () => number = () => performance.now(),
    /** The local user's id: an 'incoming' take is only on its recorder's device, so only they may load it. */
    private me?: number | null,
  ) {
    const watch = (m: Y.AbstractType<any>, fn: (evs: Y.YEvent<any>[]) => void) => {
      m.observeDeep(fn)
      this.unobserve.push(() => m.unobserveDeep(fn))
    }
    const dirtyIds = (kind: Kind) => (evs: Y.YEvent<any>[]) => this.reconcile(kind, evs)
    watch(tracksMap(doc), dirtyIds('track'))
    watch(clipsMap(doc), dirtyIds('clip'))
    watch(notesMap(doc), dirtyIds('note'))
    watch(devicesMap(doc), dirtyIds('device'))
    watch(loopersMap(doc), dirtyIds('looper'))
    watch(padsMap(doc), dirtyIds('pad'))
    watch(lanesMap(doc), dirtyIds('lane'))
    watch(pointsMap(doc), dirtyIds('point'))
    watch(samplesMap(doc), () => [...this.wanted].forEach((h) => this.wantSource(h)))
    const onMeta = (ev: Y.YMapEvent<unknown>) => ev.keysChanged.has('loop') && this.syncLoop()
    metaMap(doc).observe(onMeta)
    this.unobserve.push(() => metaMap(doc).unobserve(onMeta))
    this.clock = new Clock(rate, now)
    this.syncAll()
    this.syncLoop()
  }

  // --- transport cycle (meta.loop)
  /**
   * Send the doc's loop region to the engine (`engine_set_loop`) when it changes. While a take is recorded the cycle is
   * sent off, and it comes back when recording ends (looped recording is not supported: a take is one continuous
   * stretch of the timeline, and the worklet ends capture at any jump).
   */
  private syncLoop() {
    const l = getLoop(this.doc)
    const on = !!l?.on && !this.recording
    this.clock.loop = on ? { start: l!.start, end: l!.end } : null
    const args = on ? [l!.start, l!.end, 1] : [0, 0, 0]
    const key = args.join(',')
    if (key === this.sentLoop) return
    this.sentLoop = key
    this.sink.call('engine_set_loop', ...args)
  }

  /** A take started (true) or ended: the cycle is suspended meanwhile. */
  setRecording(on: boolean) {
    this.recording = on
    this.syncLoop()
  }

  /** Engine -> main: a {type:'meters'} message, with the track handles mapped to doc track ids. */
  meters(m: MetersMessage): Meters {
    return mapMeters(m, (h) => this.trackIds.get(h))
  }

  destroy() {
    this.unobserve.forEach((f) => f())
  }

  // --- transport
  play(from?: number) {
    this.sink.call('engine_play', this.clock.play(from))
  }
  stop() {
    this.clock.stop()
    this.sink.call('engine_stop')
  }
  seek(pos: number) {
    this.clock.seek(pos)
    this.sink.call('engine_seek', pos)
  }
  /** Engine -> main: {type:'pos'} message. */
  onPos(m: { pos: number; playing: boolean }) {
    this.clock.report(m)
  }
  get isPlaying() {
    return this.clock.isPlaying
  }
  /** Transport position in samples, extrapolated between engine reports. */
  position() {
    return this.clock.position()
  }

  // --- previews: private transports on a soundscape track, independent of the timeline
  preview(trackId: string, mode: PreviewMode): PreviewTransport {
    const key = `${trackId}:${mode}`
    let p = this.previews.get(key)
    if (!p) {
      const h = this.next++
      p = { h, clock: new Clock(this.rate, this.now) }
      this.previews.set(key, p)
      this.previewClocks.set(h, p.clock)
      this.sink.call('engine_preview_upsert', h, this.handle('track', trackId), mode === 'loops' ? 1 : 0)
    }
    const { h, clock } = p
    return {
      get playing() { return clock.isPlaying },
      position: () => clock.position(),
      play: (from) => this.sink.call('engine_preview_play', h, clock.play(from)),
      stop: () => (clock.stop(), this.sink.call('engine_preview_stop', h)),
      seek: (pos) => (clock.seek(pos), this.sink.call('engine_preview_seek', h, pos)),
    }
  }
  /** The engine's handle for a track (made on first use, like every handle). */
  trackHandle(id: string) {
    return this.handle('track', id)
  }
  /** Engine -> main: {type:'preview'} message. */
  onPreviewPos(m: { h: number; pos: number; playing: boolean }) {
    this.previewClocks.get(m.h)?.report(m)
  }
  /** Engine -> main: {type:'loopers'} message: the read heads (handle, source sample) of the sounding loopers. */
  onLooperHeads(m: { heads: [number, number][] }) {
    this.heads = new Map(m.heads)
    this.headsAt = this.now()
  }
  /** Where a looper's read head is on the source tape (samples), or null while it isn't sounding. */
  looperHead(id: string): number | null {
    const h = this.handles.looper.get(id)
    if (h == null || this.now() - this.headsAt > 250) return null // (stale: the engine stopped reporting)
    return this.heads.get(h) ?? null
  }
  /** A removed track takes its previews with it (the engine handle would dangle). */
  private dropPreviews(trackId: string) {
    for (const [key, p] of this.previews) {
      if (!key.startsWith(`${trackId}:`)) continue
      this.sink.call('engine_preview_remove', p.h)
      this.previews.delete(key)
      this.previewClocks.delete(p.h)
    }
  }

  // --- live params
  /** Immediate local value while dragging (not in the doc). */
  live(deviceId: string, paramId: number, value: number) {
    const h = this.handles.device.get(deviceId)
    if (h != null) this.sink.call('engine_param_set', h, paramId, value)
    this.followKnob(deviceId, String(paramId), value)
  }
  /** Replace the set of remote drag overrides; params whose override ended revert to the doc value. */
  setOverrides(drags: Drag[]) {
    const next = new Map(drags.map((d) => [key(d.deviceId, d.paramId), d]))
    for (const k of this.overrides.keys()) {
      if (next.has(k)) continue
      this.overrides.delete(k)
      const [deviceId, p] = k.split(':')
      const v = this.docParam(deviceId, Number(p))
      if (v != null) this.live(deviceId, Number(p), v)
    }
    for (const [k, d] of next) {
      if (this.overrides.get(k) === d.value) continue
      this.overrides.set(k, d.value)
      this.live(d.deviceId, d.paramId, d.value)
    }
  }
  private docParam(deviceId: string, paramId: number) {
    const v = (devicesMap(this.doc).get(deviceId)?.get('params') as Y.Map<number> | undefined)?.get(String(paramId))
    return typeof v === 'number' ? v : undefined
  }

  // --- reconcile
  private syncAll() {
    for (const t of tracksMap(this.doc).values()) this.upsertTrack(t.toJSON() as Track)
    for (const c of getClips(this.doc)) this.upsertClip(c)
    for (const n of getNotes(this.doc)) this.upsertNote(n)
    for (const d of getDevices(this.doc)) this.upsertDevice(d, ALL)
    for (const l of getLoopers(this.doc)) this.upsertLooper(l)
    for (const p of getPads(this.doc)) this.upsertPad(p)
    for (const l of getLanes(this.doc)) this.upsertLane(l)
    for (const p of getPoints(this.doc)) this.upsertPoint(p)
  }

  private reconcile(kind: Kind, evs: Y.YEvent<any>[]) {
    const dirty = new Map<string, Dirty>()
    const root = this.map(kind)
    const of = (id: string) => dirty.get(id) ?? (dirty.set(id, { all: false, fields: false, params: new Set() }), dirty.get(id)!)
    for (const ev of evs) {
      if (ev.target === root) for (const id of ev.keys.keys()) of(id).all = true
      else if (ev.path[1] === 'params') for (const p of ev.keys.keys()) of(String(ev.path[0])).params.add(p)
      else of(String(ev.path[0])).fields = true
    }
    for (const [id, d] of dirty) {
      const existed = this.handles[kind].has(id)
      const live = this.upsertById(kind, id, d)
      if (live !== existed) this.touchChildren(kind, id) // appeared or vanished: children may now (not) render
    }
  }

  private map(kind: Kind) {
    return { track: tracksMap, clip: clipsMap, note: notesMap, device: devicesMap, looper: loopersMap, pad: padsMap, lane: lanesMap, point: pointsMap }[kind](this.doc)
  }

  private upsertById(kind: Kind, id: string, d: Dirty = ALL): boolean {
    const v = this.map(kind).get(id)?.toJSON()
    let ok = false
    if (v) {
      if (kind === 'track') ok = this.upsertTrack(v as Track)
      else if (kind === 'clip') ok = this.upsertClip(v as Clip)
      else if (kind === 'note') ok = this.upsertNote(v as Note)
      else if (kind === 'looper') ok = this.upsertLooper(v as Looper)
      else if (kind === 'pad') ok = this.upsertPad(v as Pad)
      else if (kind === 'lane') ok = this.upsertLane(v as Lane)
      else if (kind === 'point') ok = this.upsertPoint(v as Point)
      else ok = this.upsertDevice(v as Device, d)
    }
    if (!ok) this.remove(kind, id)
    return ok
  }

  private touchChildren(kind: Kind, id: string) {
    if (kind === 'track') {
      for (const c of getClips(this.doc)) if (c.trackId === id) this.upsertById('clip', c.id) && this.touchChildren('clip', c.id)
      for (const d of getDevices(this.doc)) if (d.trackId === id) this.upsertById('device', d.id)
      for (const l of getLoopers(this.doc)) if (l.trackId === id) this.upsertById('looper', l.id)
      for (const p of getPads(this.doc)) if (p.trackId === id) this.upsertById('pad', p.id)
    } else if (kind === 'clip') {
      for (const n of getNotes(this.doc)) if (n.clipId === id) this.upsertById('note', n.id)
    } else if (kind === 'lane') {
      for (const p of getPoints(this.doc)) if (p.laneId === id) this.upsertById('point', p.id)
    }
  }

  private handle(kind: Kind | 'source', id: string) {
    let h = this.handles[kind].get(id)
    if (h == null) {
      this.handles[kind].set(id, (h = this.next++))
      if (kind === 'track') this.trackIds.set(h, id)
    }
    return h
  }

  private remove(kind: Kind, id: string) {
    const h = this.handles[kind].get(id)
    if (h == null) return
    this.handles[kind].delete(id)
    if (kind === 'track') this.dropPreviews(id), this.trackIds.delete(h)
    const fn = {
      track: 'engine_track_remove', clip: 'engine_clip_remove', note: 'engine_note_remove', device: 'engine_device_remove', looper: 'engine_looper_remove',
      pad: 'engine_pad_remove', lane: 'engine_lane_remove', point: 'engine_point_remove',
    }[kind]
    this.sink.call(fn, h)
    if (kind === 'lane') {
      const t = this.laneTargets.get(id)
      this.laneTargets.delete(id)
      this.lfoLanes.delete(id)
      if (t) this.restoreStatic(t) // the engine only replaced the value: hand the param its own back
    }
  }

  /** Re-send the doc's value of an automated param (its lane was disabled or removed). */
  private restoreStatic(t: ParamTarget) {
    if (t.kind === 'looper') {
      const l = loopersMap(this.doc).get(t.owner)?.toJSON() as Looper | undefined
      if (l) this.upsertLooper(l)
      return
    }
    const h = this.handles.device.get(t.owner)
    const v = this.docParam(t.owner, Number(t.param))
    if (h != null && v != null) this.sendParam(t.owner, h, Number(t.param), v)
  }

  private upsertLane(l: Lane): boolean {
    const r = resolveTarget(this.doc, l)
    if (!r || l.owner == null) return false
    const scale = SCALE_CODE[r.def.scale]
    if (l.kind === 'looper') {
      const code = looperParamDef(l.param)?.id
      if (code == null) return false
      this.sink.call('engine_lane_upsert', this.handle('lane', l.id), 1, this.handle('looper', l.owner), code, +l.enabled, r.def.min, r.def.max, scale)
    } else {
      this.sink.call('engine_lane_upsert', this.handle('lane', l.id), 0, this.handle('device', l.owner), Number(l.param), +l.enabled, r.def.min, r.def.max, scale)
    }
    this.laneTargets.set(l.id, { scope: l.scope, kind: l.kind, owner: l.owner, param: l.param })
    this.sendLfo(l)
    if (!l.enabled) this.restoreStatic(l)
    return true
  }

  /**
   * An LFO lane swings around the param's own value, so the engine needs that value (as a position on the
   * slider) with the wave: sent whenever the lane changes and whenever the knob does. Lanes that are not in
   * LFO mode send nothing, except once on the way out of it.
   */
  private sendLfo(l: Lane, value?: number) {
    const h = this.handles.lane.get(l.id)
    const r = resolveTarget(this.doc, l)
    if (h == null || !r) return
    const lfo = l.enabled && l.mode === 'lfo'
    if (lfo) this.lfoLanes.add(l.id)
    else if (!this.lfoLanes.delete(l.id)) return
    const v = value ?? this.overrides.get(key(l.owner, Number(l.param))) ?? r.value
    this.sink.call('engine_lane_lfo', h, +lfo, l.shape ?? LFO_DEFAULTS.shape, l.rate ?? LFO_DEFAULTS.rate, l.depth ?? LFO_DEFAULTS.depth, paramToPos(r.def, v))
  }

  /** The static value of `owner`'s `param` moved: the LFO lanes around it follow. */
  private followKnob(owner: string, param: string, value?: number) {
    if (!this.lfoLanes.size) return
    for (const l of getLanes(this.doc)) if (l.owner === owner && l.param === param && this.lfoLanes.has(l.id)) this.sendLfo(l, value)
  }

  private upsertPoint(p: Point): boolean {
    const lane = this.handles.lane.get(p.laneId)
    if (lane == null || !lanesMap(this.doc).has(p.laneId)) return false
    this.sink.call('engine_point_upsert', this.handle('point', p.id), lane, p.pos, p.value, +(p.curve === 'hold'))
    return true
  }

  private upsertTrack(t: Track): boolean {
    const code = { audio: 0, midi: 1, soundscape: 2 }[t.kind]
    if (code == null) return false
    this.sink.call('engine_track_upsert', this.handle('track', t.id), code, t.gain, t.pan, +t.muted, +t.soloed, +(t.role === 'click'))
    return true
  }

  private upsertClip(c: Clip): boolean {
    if (!tracksMap(this.doc).has(c.trackId)) return false // orphan
    if (c.kind === 'audio' && !this.handles.clip.has(c.id)) this.claimLiveClip(c as AudioClip)
    const h = this.handle('clip', c.id)
    const track = this.handle('track', c.trackId)
    if (c.kind === 'midi') {
      const m = c as MidiClip
      this.sink.call('engine_clip_midi_upsert', h, track, m.start, m.bpm, m.ppq, isForever(m) ? Math.max(m.lengthTicks, foreverTicks(m)) : m.lengthTicks, m.loopTicks ?? 0)
    } else if (c.kind === 'audio') {
      const a = c as AudioClip
      this.wantSource(a.sourceHash)
      const pass = a.loopLength && a.loopLength > 0 ? a.loopLength : 0
      this.sink.call('engine_clip_audio_upsert', h, track, this.handle('source', a.sourceHash), a.start,
        isForever(a) ? Math.max(a.length, foreverSamples(this.rate)) : a.length,
        a.sourceOffset, a.gain, a.fadeIn, a.fadeOut, a.fadeShape, pass, pass ? a.loopPhase ?? 0 : 0)
    } else return false
    return true
  }

  private upsertLooper(l: Looper): boolean {
    if (!tracksMap(this.doc).has(l.trackId)) return false
    const h = this.handle('looper', l.id)
    this.sink.call('engine_looper_upsert', h, this.handle('track', l.trackId), l.speed, l.start, l.length)
    this.sink.call('engine_looper_mix', h, l.gain ?? 1, +(l.muted ?? false))
    this.sink.call('engine_looper_tape', h, l.sat ?? 0, l.cutoff ?? LOOP_CUTOFF_MAX, l.warble ?? 0)
    for (const k of ['speed', 'gain', 'sat', 'cutoff', 'warble']) this.followKnob(l.id, k)
    return true
  }

  private upsertPad(p: Pad): boolean {
    if (!tracksMap(this.doc).has(p.trackId)) return false // orphan
    this.sink.call('engine_pad_upsert', this.handle('pad', p.id), this.handle('track', p.trackId), p.start, p.length)
    return true
  }

  private upsertNote(n: Note): boolean {
    if (!clipsMap(this.doc).has(n.clipId) || !this.handles.clip.has(n.clipId)) return false
    this.sink.call('engine_note_upsert', this.handle('note', n.id), this.handles.clip.get(n.clipId)!, n.tick, n.durTicks, n.pitch, n.velocity)
    return true
  }

  private upsertDevice(d: Device, dirty: Dirty): boolean {
    if (d.trackId !== MASTER_TRACK && !tracksMap(this.doc).has(d.trackId)) return false
    const h = this.handle('device', d.id)
    if (dirty.all || dirty.fields) {
      this.sink.call('engine_device_upsert', h, d.trackId === MASTER_TRACK ? MASTER_HANDLE : this.handle('track', d.trackId), d.type, d.order, +d.bypass)
      this.sink.call('engine_device_keys', h, d.keyLo ?? KEY_MIN, d.keyHi ?? KEY_MAX)
    }
    for (const [p, v] of Object.entries(d.params ?? {})) {
      if (dirty.all || dirty.params.has(p)) {
        this.sendParam(d.id, h, Number(p), v)
        this.followKnob(d.id, p)
      }
    }
    return true
  }

  private sendParam(deviceId: string, h: number, p: number, v: number) {
    if (this.overrides.has(key(deviceId, p))) return // a remote drag owns it until it ends
    this.sink.call('engine_param_set', h, p, v)
  }

  // --- live sources and engine-only clips (the loop pedal; docs/engine.md §9.2)
  /**
   * Reserve a live source for a take that is about to be recorded: an engine source handle that grows as the Recorder
   * writes into it (pass the handle to `Recorder.start`), with `LIVE_HEADROOM_S` of room up front. Clips on it
   * (`liveClip`) are silent where it has not been written yet.
   */
  liveSource(channels = 2): number {
    const h = this.next++
    this.sink.call('engine_source_live_alloc', h, channels, LIVE_HEADROOM_S * this.rate)
    return h
  }

  /**
   * The finished take became the doc sample `hash`: map `hash` to the live source `h` and finalize it (no more frames). The
   * bridge then never decodes or loads that sample, and doc clips on `hash` use `h`, so what was heard live keeps sounding
   * unchanged. Call it before the sample and its clip are written to the doc (see `finishTake`'s `onHash`). Returns false,
   * leaving `h` unbound, when `hash` already has a source of its own (identical audio loaded before).
   */
  bindLiveSource(hash: string, h: number): boolean {
    if (this.handles.source.has(hash)) return false
    this.handles.source.set(hash, h)
    this.requested.add(hash)
    this.wanted.add(hash)
    this.sink.call('engine_source_live_finalize', h)
    return true
  }

  /** Throw away a live source that was never bound (a discarded take). Clips still reading it must be removed first. */
  dropLiveSource(h: number) {
    this.sink.call('engine_source_free', h)
  }

  /**
   * Make an audio clip that is not in the doc and return its engine handle: now, or applied exactly at timeline sample `at`
   * (the clip's own `start` is independent of `at`; a clip that starts before `at` simply plays from the right place when it
   * arrives, since playback is stateless). The clip is adopted by a doc clip that later appears on the same track and source
   * with the same `start` and `sourceOffset` (automatic), or explicitly by `adoptLiveClip`.
   */
  liveClip(trackId: string, c: LiveClip, at?: number): number {
    const h = this.next++
    this.ephemeral.set(h, { track: this.handle('track', trackId), c: { ...LIVE_DEFAULTS, ...c } })
    this.sendLive(h, at)
    return h
  }

  /** Change an engine-only clip (the pedal's stop: a new `length`), now or at sample `at`. False once it is adopted or removed. */
  updateLiveClip(h: number, patch: Partial<LiveClip>, at?: number): boolean {
    const e = this.ephemeral.get(h)
    if (!e) return false
    Object.assign(e.c, patch)
    this.sendLive(h, at)
    return true
  }

  /** Remove an engine-only clip, now or at sample `at`. */
  removeLiveClip(h: number, at?: number) {
    if (!this.ephemeral.delete(h)) return
    this.callOrAt(at, 'engine_clip_remove', h)
  }

  /**
   * Make the engine-only clip `h` the engine copy of doc clip `clipId`. The doc's upsert is then the same call with
   * the same handle (an inaudible no-op if the fields match), and removing the doc clip removes it. Normally not needed:
   * a doc clip matching the clip's track, source, `start` and `sourceOffset` adopts it by itself when it is written, so
   * nothing is created twice. If `clipId` already got a handle of its own, this switches to `h` and removes the other.
   */
  adoptLiveClip(h: number, clipId: string): boolean {
    if (!this.ephemeral.delete(h)) return false
    const old = this.handles.clip.get(clipId)
    this.handles.clip.set(clipId, h)
    if (old != null && old !== h) {
      this.upsertById('clip', clipId)
      this.sink.call('engine_clip_remove', old)
    }
    return true
  }

  private callOrAt(at: number | undefined, fn: string, ...args: number[]) {
    if (at != null && this.sink.callAt) this.sink.callAt(at, fn, ...args)
    else this.sink.call(fn, ...args)
  }

  private sendLive(h: number, at?: number) {
    const e = this.ephemeral.get(h)
    if (!e) return
    const c = e.c
    this.callOrAt(at, 'engine_clip_audio_upsert', h, e.track, c.source, c.start, c.length, c.sourceOffset, c.gain, c.fadeIn, c.fadeOut, c.fadeShape, c.loopLength, c.loopLength ? c.loopPhase : 0)
  }

  /** A new doc audio clip takes over the engine-only clip it describes, if any (so it is not created a second time). */
  private claimLiveClip(a: AudioClip) {
    const track = this.handles.track.get(a.trackId), source = this.handles.source.get(a.sourceHash)
    if (track == null || source == null) return
    for (const [h, e] of this.ephemeral) {
      if (e.track === track && e.c.source === source && e.c.start === a.start && e.c.sourceOffset === (a.sourceOffset ?? 0)) {
        this.ephemeral.delete(h)
        this.handles.clip.set(a.id, h)
        return
      }
    }
  }

  // --- sources
  private wantSource(hash: string) {
    this.wanted.add(hash)
    if (this.requested.has(hash)) return
    const meta = samplesMap(this.doc).get(hash)
    if (!meta) return // metadata not synced yet; retried when the samples map changes
    // Not requested (so retried when the sample changes, e.g. once the take is uploaded): silence until then.
    if (meta.status === 'missing' || (meta.status === 'incoming' && (meta.by == null || meta.by !== this.me))) return
    this.requested.add(hash)
    const h = this.handle('source', hash)
    this.loadSource(hash, meta).then(
      (ch) => ch?.length && this.sink.source(h, ch, ch[0].length),
      (e) => (this.requested.delete(hash), console.warn(`source ${hash.slice(0, 8)}:`, e)),
    )
  }
}
