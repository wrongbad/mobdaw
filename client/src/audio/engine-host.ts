// Main-thread side of the wasm engine: loads engine.wasm and the worklet processor, and
// exposes the raw call surface of docs/engine-api.md plus the M1 test voice's params.
import wasmUrl from './wasm/engine.wasm?url'
import processorUrl from './engine-processor.ts?worker&url'

/** Test-voice param ids; must match engine/crates/engine/src/test_voice.rs. */
export const P = { gate: 0, freq: 1, rolloff: 2, cutoff: 3, damping: 4, gain: 5 } as const

// We ship the raw wasm *bytes* to the worklet (processorOptions are structured-cloned) and
// compile there with `new WebAssembly.Module(bytes)`. Cloning a compiled Module into a
// worklet is less portable than cloning bytes.
let wasmBytes: Promise<ArrayBuffer> | null = null
const loadWasm = () => (wasmBytes ??= fetch(wasmUrl).then((r) => {
  if (!r.ok) throw new Error(`engine.wasm: HTTP ${r.status}`)
  return r.arrayBuffer()
}))

const modulesAdded = new WeakMap<BaseAudioContext, Promise<void>>()
const addProcessor = (ctx: BaseAudioContext) => {
  let p = modulesAdded.get(ctx)
  if (!p) modulesAdded.set(ctx, (p = ctx.audioWorklet.addModule(processorUrl)))
  return p
}

export class EngineHost {
  private constructor(readonly node: AudioWorkletNode) {}

  /** Create the engine node (not yet connected). Rejects with a readable error on failure. */
  static async create(ctx: BaseAudioContext): Promise<EngineHost> {
    const [bytes] = await Promise.all([loadWasm(), addProcessor(ctx)])
    // Each node gets its own copy of the bytes (cloned, not transferred, so we can reuse them).
    const node = new AudioWorkletNode(ctx, 'mobdaw-engine', {
      // One input, for recording and input monitoring (the worklet hands it to the engine only while monitored); 'max' takes the mic's own channel count.
      numberOfInputs: 1,
      channelCount: 2,
      channelCountMode: 'max',
      channelInterpretation: 'discrete',
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasmBytes: bytes },
    })
    await new Promise<void>((resolve, reject) => {
      node.port.onmessage = (ev) => ev.data?.type === 'ready' && resolve()
      node.onprocessorerror = () => reject(new Error('engine processor failed to start (see console)'))
    })
    node.onprocessorerror = (e) => console.error('engine processor error', e)
    const host = new EngineHost(node)
    node.port.onmessage = (ev) => {
      if (ev.data?.type === 'pong') host.pings.get(ev.data.id)?.(), host.pings.delete(ev.data.id)
      else if (ev.data?.type === 'pos') host.onpos?.(ev.data)
      else if (ev.data?.type === 'preview') host.onpreview?.(ev.data)
      else if (ev.data?.type === 'loopers') host.onloopers?.(ev.data)
      else if (ev.data?.type === 'recstart') host.onrecstart?.(ev.data)
      else if (ev.data?.type === 'rec') host.onrec?.(ev.data)
      else if (ev.data?.type === 'level') host.onlevel?.(ev.data)
    }
    return host
  }

  private pings = new Map<number, () => void>()
  private pingId = 0

  /** Resolves once the worklet has handled every message posted before this call (messages arrive in order). */
  sync(): Promise<void> {
    return new Promise((resolve) => {
      const id = ++this.pingId
      this.pings.set(id, resolve)
      this.node.port.postMessage({ type: 'ping', id })
    })
  }

  /** Called with the processor's {type:'pos'} messages. */
  onpos: ((m: { pos: number; playing: boolean }) => void) | null = null
  /** Called with the processor's {type:'preview'} messages (one per playing preview). */
  onpreview: ((m: { h: number; pos: number; playing: boolean }) => void) | null = null

  /** Called with the processor's {type:'loopers'} messages: `[handle, source sample]` per sounding looper. */
  onloopers: ((m: { heads: [number, number][] }) => void) | null = null

  /** Capture began: `pos` is the timeline sample of the first captured frame. */
  onrecstart: ((m: { pos: number }) => void) | null = null
  /** A chunk of captured input: planar, one array per channel. The last one has `final`. */
  onrec: ((m: { channels: Float32Array[]; frames: number; final: boolean }) => void) | null = null

  /** Input level: `peaks` are max |x| per 64 frames (BUCKET); `rec` when those frames went into the take. */
  onlevel: ((m: { peaks: Float32Array; rec: boolean }) => void) | null = null

  /** Report the input's level (while a microphone is armed). */
  meter(on: boolean) {
    this.node.port.postMessage({ type: 'meter', on })
  }

  /** Play the input through the engine track `h`'s chain (input monitoring), or stop (`h` null). */
  monitor(h: number | null) {
    this.node.port.postMessage({ type: 'monitor', h: h ?? 0, on: h != null })
  }

  /** Start (`on`, with the channel count to capture) or end capturing the node's input. Capture begins once the engine plays. */
  record(on: boolean, channels = 1) {
    this.node.port.postMessage({ type: 'record', on, channels })
  }

  /** Call `exports[fn](enginePtr, ...args)` in the worklet; calls apply in order. */
  call(fn: string, args: number[] = []) {
    this.node.port.postMessage({ type: 'call', fn, args })
  }

  /** Hand decoded planar PCM to the engine; the buffers are transferred, not copied. */
  source(h: number, channels: Float32Array[], frames: number) {
    this.node.port.postMessage({ type: 'source', h, channels, frames }, channels.map((c) => c.buffer))
  }

  setParam(id: number, value: number) {
    this.node.port.postMessage({ type: 'param', id, value })
  }

  dispose() {
    this.node.disconnect()
    this.node.port.close()
  }
}
