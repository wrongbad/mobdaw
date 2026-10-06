// Turns Yjs doc changes into engine commands (docs/engine-api.md). Pure: it talks to an
// EngineSink, so tests can use a fake engine. Each change reconciles the touched entities
// by id: present and parented -> upsert, otherwise -> remove. Command order never matters.
import * as Y from 'yjs'
import {
  clipsMap, devicesMap, getClips, getDevices, getNotes, notesMap, samplesMap, tracksMap,
  type AudioClip, type Clip, type Device, type MidiClip, type Note, type SampleMeta, type Track,
} from '@mobdaw/shared'

export interface EngineSink {
  call(fn: string, ...args: number[]): void
  /** Hand decoded PCM to the engine (the real sink transfers the buffers). */
  source(h: number, channels: Float32Array[], frames: number): void
}
/** Decode a source at the project rate. Resolve null to skip it (e.g. too long to play). */
export type SourceLoader = (hash: string, meta: SampleMeta) => Promise<Float32Array[] | null>
export type Drag = { deviceId: string; paramId: number; value: number }

type Kind = 'track' | 'clip' | 'note' | 'device'
const key = (d: string, p: number) => `${d}:${p}`
type Dirty = { all: boolean; fields: boolean; params: Set<string> }
const ALL: Dirty = { all: true, fields: true, params: new Set() }

export class Bridge {
  private handles: Record<Kind | 'source', Map<string, number>> = {
    track: new Map(), clip: new Map(), note: new Map(), device: new Map(), source: new Map(),
  }
  private next = 1 // never reused, shared by all kinds (unique per kind is all the contract needs)
  private requested = new Set<string>()
  private wanted = new Set<string>()
  private overrides = new Map<string, number>()
  private unobserve: (() => void)[] = []
  private pos = 0
  private playing = false
  private posAt = 0

  constructor(
    private doc: Y.Doc,
    private sink: EngineSink,
    private loadSource: SourceLoader,
    private rate: number,
    private now: () => number = () => performance.now(),
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
    watch(samplesMap(doc), () => [...this.wanted].forEach((h) => this.wantSource(h)))
    this.syncAll()
  }

  destroy() {
    this.unobserve.forEach((f) => f())
  }

  // --- transport
  play(from = this.pos) {
    this.pos = from
    this.playing = true
    this.posAt = this.now()
    this.sink.call('engine_play', from)
  }
  stop() {
    this.pos = this.position()
    this.playing = false
    this.sink.call('engine_stop')
  }
  seek(pos: number) {
    this.pos = pos
    this.posAt = this.now()
    this.sink.call('engine_seek', pos)
  }
  /** Engine -> main: {type:'pos'} message. */
  onPos(m: { pos: number; playing: boolean }) {
    this.pos = m.pos
    this.playing = m.playing
    this.posAt = this.now()
  }
  get isPlaying() {
    return this.playing
  }
  /** Transport position in samples, extrapolated between engine reports. */
  position() {
    return this.playing ? this.pos + ((this.now() - this.posAt) / 1000) * this.rate : this.pos
  }

  // --- live params
  /** Immediate local value while dragging (not in the doc). */
  live(deviceId: string, paramId: number, value: number) {
    const h = this.handles.device.get(deviceId)
    if (h != null) this.sink.call('engine_param_set', h, paramId, value)
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
    return { track: tracksMap, clip: clipsMap, note: notesMap, device: devicesMap }[kind](this.doc)
  }

  private upsertById(kind: Kind, id: string, d: Dirty = ALL): boolean {
    const v = this.map(kind).get(id)?.toJSON()
    let ok = false
    if (v) {
      if (kind === 'track') ok = this.upsertTrack(v as Track)
      else if (kind === 'clip') ok = this.upsertClip(v as Clip)
      else if (kind === 'note') ok = this.upsertNote(v as Note)
      else ok = this.upsertDevice(v as Device, d)
    }
    if (!ok) this.remove(kind, id)
    return ok
  }

  private touchChildren(kind: Kind, id: string) {
    if (kind === 'track') {
      for (const c of getClips(this.doc)) if (c.trackId === id) this.upsertById('clip', c.id) && this.touchChildren('clip', c.id)
      for (const d of getDevices(this.doc)) if (d.trackId === id) this.upsertById('device', d.id)
    } else if (kind === 'clip') {
      for (const n of getNotes(this.doc)) if (n.clipId === id) this.upsertById('note', n.id)
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
    const fn = { track: 'engine_track_remove', clip: 'engine_clip_remove', note: 'engine_note_remove', device: 'engine_device_remove' }[kind]
    this.sink.call(fn, h)
  }

  private upsertTrack(t: Track): boolean {
    if (t.kind !== 'audio' && t.kind !== 'midi') return false
    this.sink.call('engine_track_upsert', this.handle('track', t.id), t.kind === 'midi' ? 1 : 0, t.gain, t.pan, +t.muted, +t.soloed)
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

  private upsertNote(n: Note): boolean {
    if (!clipsMap(this.doc).has(n.clipId) || !this.handles.clip.has(n.clipId)) return false
    this.sink.call('engine_note_upsert', this.handle('note', n.id), this.handles.clip.get(n.clipId)!, n.tick, n.durTicks, n.pitch, n.velocity)
    return true
  }

  private upsertDevice(d: Device, dirty: Dirty): boolean {
    if (!tracksMap(this.doc).has(d.trackId)) return false
    const h = this.handle('device', d.id)
    if (dirty.all || dirty.fields) {
      this.sink.call('engine_device_upsert', h, this.handle('track', d.trackId), d.type, d.order, +d.bypass)
    }
    for (const [p, v] of Object.entries(d.params ?? {})) {
      if (dirty.all || dirty.params.has(p)) this.sendParam(d.id, h, Number(p), v)
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
    this.requested.add(hash)
    const h = this.handle('source', hash)
    this.loadSource(hash, meta).then(
      (ch) => ch?.length && this.sink.source(h, ch, ch[0].length),
      (e) => (this.requested.delete(hash), console.warn(`source ${hash.slice(0, 8)}:`, e)),
    )
  }
}
