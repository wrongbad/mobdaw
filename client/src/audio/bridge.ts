// Turns Yjs doc changes into engine commands (docs/engine-api.md). Pure: it talks to an
// EngineSink, so tests can use a fake engine. Each change reconciles the touched entities
// by id: present and parented -> upsert, otherwise -> remove. Command order never matters.
import * as Y from 'yjs'
import {
  LFO_DEFAULTS, LOOP_CUTOFF_MAX, MASTER_TRACK, SCALE_CODE, clipsMap, devicesMap, getClips, getDevices, getLanes, getLoopers, getNotes, getPads, getPoints, lanesMap,
  looperParamDef, loopersMap, notesMap, padsMap, paramToPos, pointsMap, resolveTarget, samplesMap, tracksMap,
  type AudioClip, type Clip, type Device, type Lane, type Looper, type MidiClip, type Pad, type Note, type ParamTarget, type Point, type SampleMeta, type Track,
} from '@mobdaw/shared'

export interface EngineSink {
  call(fn: string, ...args: number[]): void
  /** Hand decoded PCM to the engine (the real sink transfers the buffers). */
  source(h: number, channels: Float32Array[], frames: number): void
}
/** Decode a source at the project rate. Resolve null to skip it (e.g. too long to play). */
export type SourceLoader = (hash: string, meta: SampleMeta) => Promise<Float32Array[] | null>
export type Drag = { deviceId: string; paramId: number; value: number }

/**
 * A transport's position, as the main thread knows it: the engine reports now and then, and in
 * between the position is extrapolated from the clock. The timeline and every preview use one.
 */
export class Clock {
  private pos = 0
  private playing = false
  private posAt = 0
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
    return this.playing ? this.pos + ((this.now() - this.posAt) / 1000) * this.rate : this.pos
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
    this.clock = new Clock(rate, now)
    this.syncAll()
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
    if (h == null) this.handles[kind].set(id, (h = this.next++))
    return h
  }

  private remove(kind: Kind, id: string) {
    const h = this.handles[kind].get(id)
    if (h == null) return
    this.handles[kind].delete(id)
    if (kind === 'track') this.dropPreviews(id)
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
    this.sink.call('engine_track_upsert', this.handle('track', t.id), code, t.gain, t.pan, +t.muted, +t.soloed)
    return true
  }

  private upsertClip(c: Clip): boolean {
    if (!tracksMap(this.doc).has(c.trackId)) return false // orphan
    const h = this.handle('clip', c.id)
    const track = this.handle('track', c.trackId)
    if (c.kind === 'midi') {
      const m = c as MidiClip
      this.sink.call('engine_clip_midi_upsert', h, track, m.start, m.bpm, m.ppq, m.lengthTicks)
    } else if (c.kind === 'audio') {
      const a = c as AudioClip
      this.wantSource(a.sourceHash)
      this.sink.call('engine_clip_audio_upsert', h, track, this.handle('source', a.sourceHash), a.start, a.length,
        a.sourceOffset, a.gain, a.fadeIn, a.fadeOut, a.fadeShape)
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
