// Built-in content: presets, templates and the demo song. The templates must build valid documents, and the demo is
// rendered offline through the real engine.wasm (as engine.integration.test.ts drives it) to check the mix.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  DEVICES, FINNWAVE, LOFI_DRUM, MASTER_TRACK, SCHEMA_VERSION, TRACK_COLORS, addTrack, clipsMap, devicesMap, getClips, getDevices,
  getLanes, getLoop, getNotes, getPoints, getTempo, getTracks, isDrum, lanesMap, notesMap, patternTicks, pointsMap, samplesPerBar, sweepOrphans,
  tracksMap, metaMap, type Device,
} from '@mobdaw/shared'
import { Bridge } from '../src/audio/bridge'
import { CallQueue } from '../src/audio/schedule'
import { encodeWavPlanar } from '../src/audio/wav'
import { contentEnd } from '../src/audio/range'
import { DRUM_KITS, EFFECT_PRESETS, INSTRUMENT_PRESETS, addDrumKit, addEffectPreset, addInstrument, applyInstrumentPreset, replaceDrumKit } from '../src/content/presets'
import { TEMPLATES } from '../src/content/templates'
import { DEMO_BARS, DEMO_BPM, buildDemo } from '../src/content/demo'

const SR = 48000

function inRange(type: number, params: Record<string, number>) {
  const defs = DEVICES[type]?.params ?? []
  for (const [id, v] of Object.entries(params)) {
    const def = defs.find((p) => String(p.id) === id)
    expect(def, `param ${id} of device type ${type}`).toBeDefined()
    expect(v).toBeGreaterThanOrEqual(def!.min)
    expect(v).toBeLessThanOrEqual(def!.max)
  }
}

describe('presets', () => {
  it('instrument presets are distinct finnwave patches with params in range', () => {
    expect(INSTRUMENT_PRESETS.length).toBeGreaterThanOrEqual(10)
    expect(new Set(INSTRUMENT_PRESETS.map((p) => p.id)).size).toBe(INSTRUMENT_PRESETS.length)
    expect(new Set(INSTRUMENT_PRESETS.map((p) => JSON.stringify(p.params))).size).toBe(INSTRUMENT_PRESETS.length)
    for (const p of INSTRUMENT_PRESETS) {
      expect(p.type).toBe(FINNWAVE)
      expect(Object.keys(p.params)).toHaveLength(DEVICES[FINNWAVE].params.length)
      inRange(p.type, p.params)
    }
    expect(new Set(INSTRUMENT_PRESETS.map((p) => p.category))).toEqual(new Set(['keys', 'bass', 'lead', 'pad', 'pluck', 'fx']))
  })

  it('drum kits cover the GM keys with lofi drum params in range', () => {
    expect(DRUM_KITS.length).toBeGreaterThanOrEqual(4)
    for (const k of DRUM_KITS) {
      const keys = k.drums.map((d) => d.key)
      expect(new Set(keys).size).toBe(keys.length)
      for (const key of [36, 37, 38, 39, 42, 45, 46, 47]) expect(keys).toContain(key)
      for (const d of k.drums) inRange(LOFI_DRUM, d.params)
    }
  })

  it('effect presets use effects, with params in range', () => {
    expect(EFFECT_PRESETS.length).toBeGreaterThanOrEqual(6)
    for (const p of EFFECT_PRESETS) for (const d of p.devices) {
      expect(DEVICES[d.type]?.instrument).toBe(false)
      inRange(d.type, d.params)
    }
  })

  it('helpers put presets on tracks; a kit added twice reuses its keys, replace swaps the whole kit', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'm', 'midi')
    const inst = addInstrument(doc, t, INSTRUMENT_PRESETS[0])
    const dev = () => devicesMap(doc).get(inst)!.toJSON() as Device
    expect(dev().params).toEqual(INSTRUMENT_PRESETS[0].params)
    applyInstrumentPreset(doc, inst, INSTRUMENT_PRESETS[3])
    expect(dev().params).toEqual(INSTRUMENT_PRESETS[3].params)
    expect(dev().name).toBe(INSTRUMENT_PRESETS[3].name)

    const drums = () => getDevices(doc).filter((d) => d.trackId === t && isDrum(d))
    const first = addDrumKit(doc, t, DRUM_KITS[0])
    expect(drums()).toHaveLength(DRUM_KITS[0].drums.length)
    const again = addDrumKit(doc, t, DRUM_KITS[1])
    DRUM_KITS[1].drums.forEach((d, i) => {
      const j = DRUM_KITS[0].drums.findIndex((x) => x.key === d.key)
      if (j >= 0) expect(again[i]).toBe(first[j]) // same key: the existing drum takes the new sound
    })
    expect(drums()).toHaveLength(new Set([...DRUM_KITS[0].drums, ...DRUM_KITS[1].drums].map((d) => d.key)).size)
    expect(drums().find((d) => d.keyLo === 36)!.params).toEqual(DRUM_KITS[1].drums.find((d) => d.key === 36)!.params)
    replaceDrumKit(doc, t, DRUM_KITS[3])
    expect(drums().map((d) => d.keyLo).sort()).toEqual(DRUM_KITS[3].drums.map((d) => d.key).sort())
    expect(getDevices(doc).some((d) => d.id === inst)).toBe(true) // the synth stays

    const fx = addEffectPreset(doc, MASTER_TRACK, EFFECT_PRESETS.find((p) => p.devices.length > 1)!)
    expect(getDevices(doc).filter((d) => d.trackId === MASTER_TRACK).map((d) => d.id)).toEqual(fx)
  })
})

const size = (doc: Y.Doc) => [tracksMap, clipsMap, notesMap, devicesMap, lanesMap, pointsMap].map((m) => m(doc).size)

describe('templates', () => {
  it('exports the five templates with plain one-sentence blurbs', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(['empty', 'beat', 'band', 'loopjam', 'demo'])
    for (const t of TEMPLATES) {
      expect(t.blurb).toMatch(/^[A-Z][^.!]*\.$/)
      expect(t.blurb).not.toMatch(/!/)
    }
  })

  for (const t of TEMPLATES) {
    it(`${t.id} builds a valid document`, () => {
      const doc = new Y.Doc()
      t.build(doc)
      const meta = metaMap(doc)
      expect(meta.get('sampleRate')).toBe(SR)
      expect(meta.get('schemaVersion')).toBe(SCHEMA_VERSION)
      expect(meta.get('bpm')).toBeTypeOf('number')
      expect(meta.get('beatsPerBar')).toBe(4)
      const tracks = getTracks(doc)
      expect(tracks.length).toBeGreaterThan(0)
      for (const tr of tracks) {
        expect(tr.color).toBeTypeOf('number')
        expect(tr.color! >= 0 && tr.color! < TRACK_COLORS.length).toBe(true)
      }
      for (const d of getDevices(doc)) inRange(d.type, d.params)
      const bpm = getTempo(doc).bpm
      const clips = new Map(getClips(doc).map((c) => [c.id, c]))
      for (const c of clips.values()) if (c.kind === 'midi') expect(c.bpm).toBe(bpm)
      for (const n of getNotes(doc)) {
        const c = clips.get(n.clipId)
        expect(c?.kind).toBe('midi')
        if (c?.kind !== 'midi') continue
        expect(n.tick).toBeGreaterThanOrEqual(0)
        expect(n.tick + n.durTicks).toBeLessThanOrEqual(patternTicks(c))
        expect(n.velocity > 0 && n.velocity <= 1).toBe(true)
        expect(Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127).toBe(true)
      }
      for (const p of getPoints(doc)) expect(p.value >= 0 && p.value <= 1).toBe(true)
      const before = size(doc)
      sweepOrphans(doc)
      expect(size(doc)).toEqual(before)
    })
  }

  it('the demo is ~32 bars with a loop region, automation and a master chain', () => {
    const doc = new Y.Doc()
    buildDemo(doc)
    expect(getTempo(doc)).toEqual({ bpm: DEMO_BPM, beatsPerBar: 4 })
    const bar = samplesPerBar(getTempo(doc), SR)
    expect(Math.round(contentEnd(doc, SR) / bar)).toBe(DEMO_BARS)
    const loop = getLoop(doc)!
    expect(loop.on).toBe(false)
    expect(loop.end).toBeGreaterThan(loop.start)
    expect(getLanes(doc).length).toBeGreaterThanOrEqual(1)
    expect(getDevices(doc).filter((d) => d.trackId === MASTER_TRACK).length).toBeGreaterThanOrEqual(2)
  })
})

// --- offline render through the real engine

const wasm = readFileSync(new URL('../src/audio/wasm/engine.wasm', import.meta.url))

/** Render the doc from 0 for `frames` frames, as the worklet does (128-frame blocks, scheduled calls cut blocks). */
async function render(doc: Y.Doc, frames: number): Promise<[Float32Array, Float32Array]> {
  const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(wasm), {}) as unknown as {
    exports: Record<string, any> & { memory: WebAssembly.Memory }
  }
  const e = x.engine_new(SR)
  const queue = new CallQueue()
  const transport = { position: () => x.engine_position(e), playing: () => x.engine_is_playing(e) === 1 }
  const sink = {
    call: (fn: string, ...args: number[]) => x[fn](e, ...args),
    callAt: (at: number, fn: string, ...args: number[]) => queue.add(at, fn, args),
    source: () => {},
  }
  const bridge = new Bridge(doc, sink, async () => null, SR, () => 0)
  await new Promise((r) => setTimeout(r, 0))
  bridge.play(0)
  const L = new Float32Array(frames), R = new Float32Array(frames)
  for (let at = 0; at < frames; ) {
    const k = queue.size ? queue.step(Math.min(128, frames - at), transport, (c) => x[c.fn](e, ...c.args)) : Math.min(128, frames - at)
    x.engine_process(e, k)
    const out = new Float32Array(x.memory.buffer, x.engine_out_ptr(e), 256)
    L.set(out.subarray(0, k), at)
    R.set(out.subarray(128, 128 + k), at)
    at += k
  }
  bridge.destroy()
  return [L, R]
}

const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-12))
function stats(chs: Float32Array[], from = 0, to = chs[0].length) {
  let peak = 0, sum = 0, finite = true
  for (const c of chs) for (let i = from; i < to; i++) {
    const v = c[i]
    if (!Number.isFinite(v)) finite = false
    peak = Math.max(peak, Math.abs(v))
    sum += v * v
  }
  return { peak, rms: Math.sqrt(sum / ((to - from) * chs.length)), finite }
}

/** RBJ biquad (low-pass or high-pass), for a rough band split. */
function biquad(x: Float32Array, kind: 'lp' | 'hp', hz: number): Float32Array {
  const w = (2 * Math.PI * hz) / SR, a = Math.sin(w) / (2 * Math.SQRT1_2), c = Math.cos(w)
  const b0 = kind === 'lp' ? (1 - c) / 2 : (1 + c) / 2, b1 = kind === 'lp' ? 1 - c : -(1 + c), b2 = b0
  const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a
  const y = new Float32Array(x.length)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v
  }
  return y
}
/** RMS (dBFS) of the mono sum in three bands: low < 250 Hz, mid 250 Hz-4 kHz, high > 4 kHz. */
function bands(L: Float32Array, R: Float32Array, from: number, to: number) {
  const m = new Float32Array(to - from).map((_, i) => (L[from + i] + R[from + i]) / 2)
  const rms = (y: Float32Array) => db(Math.sqrt(y.reduce((s, v) => s + v * v, 0) / y.length))
  return {
    low: rms(biquad(biquad(m, 'lp', 250), 'lp', 250)),
    mid: rms(biquad(biquad(biquad(m, 'hp', 250), 'hp', 250), 'lp', 4000)),
    high: rms(biquad(biquad(m, 'hp', 4000), 'hp', 4000)),
  }
}

describe('demo render', () => {
  it('renders a balanced, unclipped mix with no dropouts', async () => {
    const doc = new Y.Doc()
    buildDemo(doc)
    const bar = samplesPerBar(getTempo(doc), SR)
    const frames = Math.ceil(DEMO_BARS * bar + 3 * SR)
    const [L, R] = await render(doc, frames)

    mkdirSync('/tmp/claude-0', { recursive: true })
    writeFileSync('/tmp/claude-0/demo.wav', Buffer.from(await encodeWavPlanar([L, R], SR, 16).arrayBuffer()))

    const all = stats([L, R])
    expect(all.finite).toBe(true)
    expect(all.peak).toBeLessThan(1)
    expect(all.peak).toBeGreaterThan(0.1)
    expect(db(all.rms)).toBeGreaterThan(-30)
    expect(db(all.rms)).toBeLessThan(-8)

    // per section: the intro is quieter, the body holds its level, nothing drops out
    const sec = (a: number, b: number) => ({ ...stats([L, R], Math.round(a * bar), Math.round(b * bar)), ...bands(L, R, Math.round(a * bar), Math.round(b * bar)) })
    const sections = { intro: sec(0, 4), a: sec(4, 12), a2: sec(12, 20), b: sec(20, 28), outro: sec(28, 32) }
    const report = Object.fromEntries(Object.entries(sections).map(([k, v]) =>
      [k, `peak ${db(v.peak).toFixed(1)} rms ${db(v.rms).toFixed(1)} | low ${v.low.toFixed(1)} mid ${v.mid.toFixed(1)} high ${v.high.toFixed(1)}`]))
    console.log(`demo: peak ${db(all.peak).toFixed(1)} dBFS, rms ${db(all.rms).toFixed(1)} dBFS\n` + Object.entries(report).map(([k, v]) => `  ${k.padEnd(6)} ${v}`).join('\n'))
    for (const k of ['a', 'a2', 'b'] as const) {
      expect(db(sections[k].rms)).toBeGreaterThan(-24)
      expect(Math.abs(db(sections[k].rms) - db(sections.a.rms))).toBeLessThan(4)
      // the bass carries the low end and nothing is harsh: no band far above the others
      expect(sections[k].low).toBeGreaterThan(sections[k].mid - 6)
      expect(sections[k].high).toBeLessThan(sections[k].mid)
      expect(sections[k].high).toBeGreaterThan(sections[k].mid - 24)
    }
    expect(db(sections.intro.rms)).toBeLessThan(db(sections.a.rms))
    expect(db(sections.intro.rms)).toBeGreaterThan(-40)
    // every bar of the song sounds (the first two bars are only the pad and the dust)
    for (let b = 0; b < DEMO_BARS; b++) expect(db(stats([L, R], Math.round(b * bar), Math.round((b + 1) * bar)).rms), `bar ${b + 1}`).toBeGreaterThan(-45)
    // and the tail dies away
    expect(stats([L, R], frames - SR / 2, frames).rms).toBeLessThan(all.rms / 10)
  }, 120_000)
})
