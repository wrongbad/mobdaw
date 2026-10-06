// End-to-end: Yjs doc → Bridge → the real engine.wasm (as built by `npm run build:wasm`),
// driven synchronously in Node the same way engine-processor.ts drives it in the worklet.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addAudioClip, addDevice, addMidiClip, addNote, addSample, addTrack, setParam, type SampleMeta } from '@mobdaw/shared'
import { Bridge } from '../src/audio/bridge'

const SR = 48000
const wasm = readFileSync(new URL('../src/audio/wasm/engine.wasm', import.meta.url))

function host() {
  const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(wasm), {}) as unknown as {
    exports: Record<string, any> & { memory: WebAssembly.Memory }
  }
  const e = x.engine_new(SR)
  const sink = {
    call: (fn: string, ...args: number[]) => x[fn](e, ...args),
    source: (h: number, channels: Float32Array[], frames: number) => {
      const ptr = x.engine_source_alloc(e, h, channels.length, frames)
      channels.forEach((c, i) => new Float32Array(x.memory.buffer, ptr + i * frames * 4, frames).set(c))
      x.engine_source_ready(e, h)
    },
  }
  /** Render n frames; returns peak |L| over them. */
  const render = (n: number) => {
    let peak = 0
    for (let done = 0; done < n; done += 128) {
      x.engine_process(e, 128)
      const out = new Float32Array(x.memory.buffer, x.engine_out_ptr(e), 256)
      for (const v of out) {
        expect(Number.isFinite(v)).toBe(true)
        peak = Math.max(peak, Math.abs(v))
      }
    }
    return peak
  }
  return { sink, render }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('bridge + real engine.wasm', () => {
  it('plays an audio clip through the simple filter, and the filter responds to params', async () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'audio')
    // 8 kHz sine source, 1 s.
    const tone = new Float32Array(SR).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 8000 * i) / SR))
    const meta: SampleMeta = { hash: 'tone', name: 'tone', duration: 1, size: SR * 4, mime: 'audio/wav' }
    addSample(doc, meta)
    addAudioClip(doc, { trackId: t, sourceHash: 'tone', start: 0, length: SR })
    const f = addDevice(doc, t, 1) // simple filter, LP 1 kHz default

    const { sink, render } = host()
    const bridge = new Bridge(doc, sink, async () => [tone, tone], SR, () => 0)
    await tick() // let the source loader resolve
    bridge.play(0)
    render(4800) // settle declick + smoothing
    const filtered = render(4800)

    setParam(doc, f, 1, 16000) // open the filter
    render(4800) // let the log-domain cutoff ramp settle
    const open = render(4800)

    expect(open).toBeGreaterThan(0.3) // ~0.5 peak through an open LP (pan −3 dB)
    expect(filtered).toBeLessThan(open * 0.05) // 8 kHz well into the 1 kHz LP stopband
    bridge.destroy()
  })

  it('plays MIDI notes through the finnwave synth', async () => {
    const doc = new Y.Doc()
    const m = addTrack(doc, 'midi', 'midi')
    addDevice(doc, m, 2)
    const c = addMidiClip(doc, { trackId: m, start: 0 })
    addNote(doc, { clipId: c, tick: 0, durTicks: 960, pitch: 60, velocity: 1 })

    const { sink, render } = host()
    const bridge = new Bridge(doc, sink, async () => null, SR, () => 0)
    await tick()
    bridge.play(0)
    expect(render(SR / 4)).toBeGreaterThan(0.01) // note sounding
    bridge.stop()
    render(SR) // release tail
    expect(render(4800)).toBeLessThan(1e-4) // silent after release
    bridge.destroy()
  })
})
