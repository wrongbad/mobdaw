// Regression for the bore calibration (docs/bore.md): every winds/strings preset speaks at a few notes, through the real
// engine.wasm. Catches DSP edits that silently break the fitted sounding region. SLOW (a couple of seconds).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addMidiClip, addNote, addTrack } from '@mobdaw/shared'
import { Bridge } from '../src/audio/bridge'
import { INSTRUMENT_PRESETS, addInstrument } from '../src/content/presets'

const SR = 48000
const wasm = readFileSync(new URL('../src/audio/wasm/engine.wasm', import.meta.url))
const tick = () => new Promise((r) => setTimeout(r, 0))

/** Render `frames` of a one-note project; returns the left channel. */
async function playNote(presetId: string, pitch: number, frames: number) {
  const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(wasm), {}) as unknown as { exports: Record<string, any> & { memory: WebAssembly.Memory } }
  const e = x.engine_new(SR)
  const doc = new Y.Doc()
  const t = addTrack(doc, 'midi', 'midi')
  addInstrument(doc, t, INSTRUMENT_PRESETS.find((p) => p.id === presetId)!)
  const c = addMidiClip(doc, { trackId: t, startTick: 0 })
  addNote(doc, { clipId: c, tick: 0, durTicks: 1920, pitch, velocity: 0.8 })
  const sink = {
    call: (fn: string, ...args: number[]) => x[fn](e, ...args),
    callAt: (_at: number, fn: string, ...args: number[]) => x[fn](e, ...args),
    source: () => {},
  }
  const bridge = new Bridge(doc, sink, async () => null, SR, () => 0)
  await tick()
  bridge.play(0)
  const out = new Float32Array(frames)
  for (let at = 0; at < frames; at += 128) {
    x.engine_process(e, 128)
    out.set(new Float32Array(x.memory.buffer, x.engine_out_ptr(e), 128), at)
  }
  bridge.destroy()
  return out
}

describe.runIf(process.env.SLOW)('bore presets', () => {
  const bores = INSTRUMENT_PRESETS.filter((p) => p.category === 'winds' || p.category === 'strings')
  it('has the ten plan presets', () => expect(bores).toHaveLength(10))
  for (const p of bores) {
    it(`${p.name} speaks at a few notes`, async () => {
      for (const pitch of [48, 60, 72]) {
        const out = await playNote(p.id, pitch, SR * 0.6)
        expect(out.every(Number.isFinite)).toBe(true)
        // the second half of 0.6 s: past the attack, still sounding
        let peak = 0
        for (let i = SR * 0.3; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
        expect(peak, `${p.id} at ${pitch}`).toBeGreaterThan(0.01)
        expect(peak, `${p.id} at ${pitch}`).toBeLessThan(2)
      }
    }, 20_000)
  }
})
