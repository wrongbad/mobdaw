// AudioWorklet processor hosting engine.wasm. Runs in AudioWorkletGlobalScope, which has no
// TextDecoder/fetch/etc. and (deliberately) no wasm-bindgen glue: we call raw `extern "C"`
// exports. Loaded via `?worker&url` by engine-host.ts.

// The DOM lib doesn't declare the worklet globals, so declare the little we use.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, ctor: new (options: any) => AudioWorkletProcessor): void

/** The engine's export surface (docs/engine-api.md); everything else is called by name. */
type EngineExports = {
  memory: WebAssembly.Memory
  engine_new(sampleRate: number): number
  engine_out_ptr(e: number): number
  engine_process(e: number, frames: number): void
  engine_set_param(e: number, id: number, value: number): void
  engine_free(e: number): void
  engine_position(e: number): number
  engine_is_playing(e: number): number
  engine_preview_position(e: number, h: number): number
  engine_looper_head(e: number, h: number): number
  engine_preview_is_playing(e: number, h: number): number
  engine_source_alloc(e: number, h: number, channels: number, frames: number): number
  engine_source_ready(e: number, h: number): void
} & Record<string, unknown>
const REPORT = new Set(['engine_play', 'engine_stop', 'engine_seek'])

const BLOCK = 128 // engine render quantum; the output buffer is planar stereo: L[128] then R[128]

class EngineProcessor extends AudioWorkletProcessor {
  private x: EngineExports
  private e: number
  private outPtr: number
  private view: Float32Array
  private sinceReport = 0
  /** Previews that are (or just were) playing: reported until they stop. */
  private previews = new Set<number>()
  /** Looper handles, to poll their read heads for the playheads. */
  private loopers = new Set<number>()
  private loopersSounding = false
  private warned = new Set<string>()
  /** Input capture (docs/engine.md §9.2): armed by a 'record' message, begins with the engine playing. */
  private rec: { channels: number; buf: Float32Array[]; fill: number; started: boolean; next: number; ended: boolean } | null = null

  constructor(options: { processorOptions: { wasmBytes: ArrayBuffer } }) {
    super()
    // Synchronous compile is allowed off the main thread. engine.wasm declares no imports
    // (checked in milestone 1), so the import object is empty.
    const module = new WebAssembly.Module(options.processorOptions.wasmBytes)
    this.x = new WebAssembly.Instance(module, {}).exports as unknown as EngineExports
    this.e = this.x.engine_new(sampleRate)
    this.outPtr = this.x.engine_out_ptr(this.e)
    this.view = new Float32Array(this.x.memory.buffer, this.outPtr, 2 * BLOCK)
    this.port.onmessage = (ev: MessageEvent) => {
      const m = ev.data
      if (m?.type === 'param') this.x.engine_set_param(this.e, m.id, m.value)
      else if (m?.type === 'call') this.call(m.fn, m.args)
      else if (m?.type === 'source') this.loadSource(m.h, m.channels, m.frames)
      else if (m?.type === 'record') this.record(m.on, m.channels)
    }
    this.port.postMessage({ type: 'ready' })
  }

  private call(fn: string, args: number[]) {
    const f = this.x[fn]
    if (typeof f !== 'function') {
      if (!this.warned.has(fn)) console.warn(`engine.wasm has no export ${fn}`), this.warned.add(fn)
      return
    }
    f(this.e, ...args)
    if (fn === 'engine_looper_upsert') this.loopers.add(args[0])
    else if (fn === 'engine_looper_remove') this.loopers.delete(args[0])
    if (REPORT.has(fn)) this.report()
    if (fn.startsWith('engine_preview_') && typeof args[0] === 'number') {
      const h = args[0]
      if (fn === 'engine_preview_play') this.previews.add(h)
      if (fn === 'engine_preview_remove') this.previews.delete(h)
      else if (this.previews.has(h) || fn === 'engine_preview_stop' || fn === 'engine_preview_seek') this.reportPreview(h)
    }
  }

  private reportPreview(h: number) {
    if (typeof this.x.engine_preview_position !== 'function') return
    const playing = this.x.engine_preview_is_playing(this.e, h) === 1
    this.port.postMessage({ type: 'preview', h, pos: this.x.engine_preview_position(this.e, h), playing })
    if (!playing) this.previews.delete(h)
  }

  /** The sounding loopers' read heads; one empty report after the last one stops, to clear the playheads. */
  private reportLoopers() {
    if (typeof this.x.engine_looper_head !== 'function') return
    const heads: [number, number][] = []
    for (const h of this.loopers) {
      const pos = this.x.engine_looper_head(this.e, h)
      if (pos >= 0) heads.push([h, pos])
    }
    if (heads.length === 0 && !this.loopersSounding) return
    this.loopersSounding = heads.length > 0
    this.port.postMessage({ type: 'loopers', heads })
  }

  private loadSource(h: number, channels: Float32Array[], frames: number) {
    if (typeof this.x.engine_source_alloc !== 'function') return
    const ptr = this.x.engine_source_alloc(this.e, h, channels.length, frames) >>> 0
    // memory may have grown during alloc: build the view from the current buffer
    const dst = new Float32Array(this.x.memory.buffer, ptr, channels.length * frames)
    channels.forEach((c, i) => dst.set(c, i * frames))
    this.x.engine_source_ready(this.e, h)
  }

  private record(on: boolean, channels = 1) {
    if (on) {
      this.rec = { channels, buf: [], fill: 0, started: false, next: 0, ended: false }
      this.rec.buf = this.fresh(this.rec)
    } else if (this.rec) {
      this.flush(true)
      this.rec = null
    }
  }

  private fresh(r: { channels: number }) {
    return Array.from({ length: r.channels }, () => new Float32Array(sampleRate)) // ~1 s chunks
  }

  /** Hand the captured frames to the main thread (transferred, not copied). */
  private flush(final = false) {
    const r = this.rec!
    const ch = r.buf.map((b) => (r.fill < b.length ? b.slice(0, r.fill) : b))
    this.port.postMessage({ type: 'rec', channels: ch, frames: r.fill, final }, ch.map((c) => c.buffer))
    r.buf = this.fresh(r)
    r.fill = 0
  }

  /** Copy this call's input into the take. Runs in the same call that advances the engine, so frame i is timeline sample start+i. */
  private capture(input: Float32Array[] | undefined, frames: number) {
    const r = this.rec!
    for (let c = 0; c < r.channels; c++) {
      const src = input?.[c] // an unconnected or narrower input records silence
      if (src) r.buf[c].set(src.subarray(0, frames), r.fill)
    }
    r.fill += frames
    if (r.fill >= r.buf[0].length) this.flush()
  }

  private report() {
    if (typeof this.x.engine_position !== 'function') return
    this.sinceReport = 0
    this.port.postMessage({ type: 'pos', pos: this.x.engine_position(this.e), playing: this.x.engine_is_playing(this.e) === 1 })
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const total = out[0].length
    const r = this.rec
    if (r && !r.ended && this.x.engine_is_playing(this.e) === 1) {
      const pos = this.x.engine_position(this.e)
      if (!r.started) {
        r.started = true
        r.next = pos
        this.port.postMessage({ type: 'recstart', pos }) // the timeline sample of the first captured frame
      }
      // A take is one continuous stretch of the timeline: if the transport jumped, capture ends here.
      if (pos === r.next) this.capture(inputs[0], total), (r.next = pos + total)
      else r.ended = true
    } else if (r?.started) r.ended = true // stopped: a later play must not append to this take
    for (let at = 0; at < total; at += BLOCK) {
      const n = Math.min(BLOCK, total - at)
      this.x.engine_process(this.e, n)
      // memory.grow detaches the old ArrayBuffer; re-wrap when it changes.
      if (this.view.buffer !== this.x.memory.buffer) {
        this.view = new Float32Array(this.x.memory.buffer, this.outPtr, 2 * BLOCK)
      }
      out[0].set(this.view.subarray(0, n), at)
      if (out[1]) out[1].set(this.view.subarray(BLOCK, BLOCK + n), at)
    }
    // ~30 position reports a second while playing (the timeline, and each playing preview)
    this.sinceReport += total
    if (this.sinceReport >= sampleRate / 30) {
      this.sinceReport = 0
      if (typeof this.x.engine_is_playing === 'function' && this.x.engine_is_playing(this.e)) this.report()
      for (const h of this.previews) this.reportPreview(h)
      this.reportLoopers()
    }
    return true
  }
}

registerProcessor('mobdaw-engine', EngineProcessor)
