// End-to-end: Yjs doc → Bridge → the real engine.wasm (as built by `npm run build:wasm`),
// driven synchronously in Node the same way engine-processor.ts drives it in the worklet.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addAudioClip, addClickTrack, addDevice, addDrum, addLane, addMidiClip, addNote, addPoint, addSample, addTrack, deleteLane, getClips, setLaneState, setParam, updateClip, updateDevice, updateLaneLfo, updateTrack, type SampleMeta } from '@mobdaw/shared'
import { Bridge } from '../src/audio/bridge'
import { CallQueue } from '../src/audio/schedule'
import { readMeters } from '../src/audio/meters'
import { setLoop } from '@mobdaw/shared'

const SR = 48000
const wasm = readFileSync(new URL('../src/audio/wasm/engine.wasm', import.meta.url))

function host() {
  const { exports: x } = new WebAssembly.Instance(new WebAssembly.Module(wasm), {}) as unknown as {
    exports: Record<string, any> & { memory: WebAssembly.Memory }
  }
  const e = x.engine_new(SR)
  const queue = new CallQueue()
  const transport = { position: () => x.engine_position(e), playing: () => x.engine_is_playing(e) === 1 }
  const sink = {
    call: (fn: string, ...args: number[]) => x[fn](e, ...args),
    // As the worklet does it: queued, and the render loop cuts its blocks at the sample.
    callAt: (at: number, fn: string, ...args: number[]) => queue.add(at, fn, args),
    source: (h: number, channels: Float32Array[], frames: number) => {
      const ptr = x.engine_source_alloc(e, h, channels.length, frames)
      channels.forEach((c, i) => new Float32Array(x.memory.buffer, ptr + i * frames * 4, frames).set(c))
      x.engine_source_ready(e, h)
    },
  }
  /** Render n frames the way the worklet's process() does; returns the left channel. */
  const samples = (n: number) => {
    const left = new Float32Array(n)
    for (let at = 0; at < n; ) {
      const k = queue.size ? queue.step(Math.min(128, n - at), transport, (c) => x[c.fn](e, ...c.args)) : Math.min(128, n - at)
      x.engine_process(e, k)
      const out = new Float32Array(x.memory.buffer, x.engine_out_ptr(e), 256)
      for (let i = 0; i < k; i++) expect(Number.isFinite(out[i]) && Number.isFinite(out[128 + i])).toBe(true)
      left.set(out.subarray(0, k), at)
      at += k
    }
    return left
  }
  /** Render n frames; returns peak |L| over them. */
  const render = (n: number) => samples(n).reduce((peak, v) => Math.max(peak, Math.abs(v)), 0)
  return { sink, render, samples, x, e }
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

  it('the metronome: a looped one-bar pattern clicks on every beat, ignores solo, and honours its own mute', async () => {
    const doc = new Y.Doc()
    const click = addClickTrack(doc)
    const other = addTrack(doc, 'other', 'midi')
    updateTrack(doc, other, { soloed: true })
    const { sink, render } = host()
    const bridge = new Bridge(doc, sink, async () => null, SR, () => 0)
    await tick()
    bridge.play(0)
    expect(render(1024)).toBeGreaterThan(0.01) // beat 1 (the accent), although another track is soloed
    render(4096)
    expect(render(8192)).toBeLessThan(1e-4) // the click is a short hit, not a tone
    render(10496)
    expect(render(1280)).toBeGreaterThan(0.01) // beat 2, at 0.5 s
    render(SR * 2 - 25088) // to 2 s: the pattern starts over
    expect(render(1280)).toBeGreaterThan(0.01) // the accent of bar 2: looped, not a single bar
    bridge.seek(0)
    updateTrack(doc, click, { muted: true })
    render(4096)
    expect(render(SR / 2)).toBeLessThan(1e-4) // muted
    bridge.destroy()
  }, 20_000)

  it('a forever click keeps looping past the end of its clip', async () => {
    const doc = new Y.Doc()
    addClickTrack(doc)
    const clip = getClips(doc)[0] // four bars at 120 bpm: 8 s
    const { sink, render } = host()
    const bridge = new Bridge(doc, sink, async () => null, SR, () => 0)
    await tick()
    updateClip(doc, clip.id, { forever: false }) // (a click track starts forever)
    bridge.play(10 * SR) // bar 5: beyond the clip
    expect(render(1024)).toBeLessThan(1e-4)
    bridge.stop()
    updateClip(doc, clip.id, { forever: true })
    bridge.play(10 * SR)
    expect(render(1024)).toBeGreaterThan(0.01) // the accent of bar 5
    bridge.destroy()
  }, 20_000)

  it('instruments take the notes in their range: a split keyboard, with layering where the ranges overlap', async () => {
    const doc = new Y.Doc()
    const m = addTrack(doc, 'midi', 'midi')
    const synth = addDevice(doc, m, 2, { keyLo: 60, keyHi: 127 })
    const drum = addDrum(doc, m, { key: 40, params: { 3: 1 } })
    const c = addMidiClip(doc, { trackId: m, start: 0, loopTicks: 960, lengthTicks: 3840 })
    addNote(doc, { clipId: c, tick: 0, durTicks: 480, pitch: 40, velocity: 1 })
    const { sink, render } = host()
    const bridge = new Bridge(doc, sink, async () => null, SR, () => 0)
    await tick()
    bridge.play(0)
    expect(render(2048)).toBeGreaterThan(0.01) // the drum's note
    render(SR / 4)
    updateDevice(doc, drum, { keyLo: 41, keyHi: 41 }) // the note is nobody's now (the synth starts at 60)
    bridge.seek(0)
    render(256)
    expect(render(SR / 2)).toBeLessThan(1e-4)
    updateDevice(doc, synth, { keyLo: 0 }) // the synth takes it
    bridge.seek(0)
    expect(render(SR / 4)).toBeGreaterThan(0.01)
    updateClip(doc, c, { loopTicks: 0 })
    bridge.destroy()
  })

  it('automation: a drawn cutoff lane opens the filter, and deleting the lane gives the knob back', async () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'audio')
    const tone = new Float32Array(SR * 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 8000 * i) / SR))
    addSample(doc, { hash: 'tone', name: 'tone', duration: 2, size: SR * 8, mime: 'audio/wav' })
    addAudioClip(doc, { trackId: t, sourceHash: 'tone', start: 0, length: SR * 2 })
    const f = addDevice(doc, t, 1) // LP at 1 kHz: 8 kHz is in the stopband
    const lane = addLane(doc, { scope: t, kind: 'effect', owner: f, param: '1' })
    addPoint(doc, lane, 0, 0, 'hold') // cutoff 20 Hz ...
    addPoint(doc, lane, SR / 2, 0.95, 'hold') // ... ~11 kHz from 0.5 s

    const { sink, render } = host()
    const bridge = new Bridge(doc, sink, async () => [tone, tone], SR, () => 0)
    await tick()
    bridge.play(0)
    render(4800)
    const closed = render(9600) // still before 0.5 s
    render(4800)
    const open = render(9600)
    expect(closed).toBeLessThan(0.02)
    expect(open).toBeGreaterThan(0.3)

    deleteLane(doc, lane) // the doc's own 1 kHz comes back
    render(9600)
    expect(render(9600)).toBeLessThan(open * 0.05)
    bridge.destroy()
  })

  it('automation: an LFO lane swings the cutoff around the knob', async () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'audio')
    const tone = new Float32Array(SR * 2).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 8000 * i) / SR))
    addSample(doc, { hash: 'tone', name: 'tone', duration: 2, size: SR * 8, mime: 'audio/wav' })
    addAudioClip(doc, { trackId: t, sourceHash: 'tone', start: 0, length: SR * 2 })
    const f = addDevice(doc, t, 1)
    setParam(doc, f, 1, 632) // ~the middle of 20..20000 on the log scale: 8 kHz is in the stopband
    const lane = addLane(doc, { scope: t, kind: 'effect', owner: f, param: '1' })
    setLaneState(doc, lane, 'lfo')
    updateLaneLfo(doc, lane, { rate: 2, depth: 0.5 }) // a 0.5 s cycle: wide open a quarter in, shut at three quarters

    const { sink, render } = host()
    const bridge = new Bridge(doc, sink, async () => [tone, tone], SR, () => 0)
    await tick()
    bridge.play(0)
    render(SR / 8 - 1200)
    const open = render(2400) // around 0.125 s
    render(SR / 4 - 2400)
    const closed = render(2400) // around 0.375 s
    expect(open).toBeGreaterThan(0.3)
    expect(closed).toBeLessThan(0.05)
    bridge.destroy()
  })

  it('a scheduled call takes effect on exactly its sample, mid-block, and a past one applies at once', async () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'audio')
    const { sink, samples } = host()
    const bridge = new Bridge(doc, sink, async () => null, SR, () => 0)
    // a constant source, a clip that began long before the call
    sink.source(900, [new Float32Array(SR).fill(0.5)], SR)
    const at = 7 * 128 + 41
    const first = bridge.liveClip(t, { source: 900, start: 0, length: SR }, at)
    bridge.play(0)
    const a = samples(2048)
    expect(a.findIndex((v) => v !== 0)).toBe(at)
    expect(a[at - 1]).toBe(0)
    expect(Math.abs(a[at])).toBeGreaterThan(0.1) // full level at once: the clip plays from where the timeline is

    bridge.removeLiveClip(first)
    expect(samples(256).every((v) => v === 0)).toBe(true) // removed at once
    // already past: applied immediately, so it sounds from the next sample
    const b = bridge.liveClip(t, { source: 900, start: 0, length: SR, gain: 0.25 }, 100)
    const c = samples(256)
    expect(c[0]).not.toBe(0)
    // a scheduled stop (a shorter length) ends the clip at its new end: before it the clip plays, after it there is silence
    const pos = 2048 + 256 + 256
    bridge.updateLiveClip(b, { length: pos + 2000 }, pos + 500)
    const d = samples(4000)
    expect(Math.abs(d[1000])).toBeGreaterThan(0.01)
    expect(d[2100]).toBe(0)
    bridge.destroy()
  })

  it('a live source plays what was recorded into it, silent past the written frames, and a bound hash keeps the same audio', async () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'audio')
    const loads: string[] = []
    const { sink, samples, x, e } = host()
    const bridge = new Bridge(doc, sink, async (h) => (loads.push(h), null), SR, () => 0)
    const live = bridge.liveSource(1)
    const input = new Float32Array(x.memory.buffer, x.engine_input_ptr(e), 256)
    const write = (frames: number, v: number) => {
      input.fill(v) // (re-wrapped each call: memory may have grown)
      x.engine_source_live_append(e, live, frames)
    }
    for (let i = 0; i < 4; i++) write(128, 0.5) // 512 frames
    expect(x.engine_source_live_written(e, live)).toBe(512)
    bridge.liveClip(t, { source: live, start: 0, length: 2000 })
    bridge.play(0)
    const a = samples(1024)
    expect(Math.abs(a[300])).toBeGreaterThan(0.1) // written
    expect(a[700]).toBe(0) // not yet
    // bind a hash, then write the sample and clip to the doc: nothing is loaded or created again
    expect(bridge.bindLiveSource('take', live)).toBe(true)
    expect(x.engine_source_live_append(e, live, 128)).toBe(0) // finalized
    addSample(doc, { hash: 'take', name: 'take', duration: 1, size: 10, mime: 'audio/wav' })
    addAudioClip(doc, { trackId: t, sourceHash: 'take', start: 0, length: 2000 })
    await tick()
    expect(loads).toEqual([])
    bridge.seek(0)
    const b = samples(1024)
    expect(b.subarray(100, 400)).toEqual(a.subarray(100, 400)) // the doc clip adopted the live one: one clip, not two
    bridge.destroy()
  })

  it('the cycle from meta.loop repeats a click every end - start samples, and recording suspends it', async () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'audio')
    const click = new Float32Array(SR)
    click[1000] = 1
    addSample(doc, { hash: 'click', name: 'click', duration: 1, size: SR * 4, mime: 'audio/wav' })
    addAudioClip(doc, { trackId: t, sourceHash: 'click', start: 0, length: SR })
    const { sink, samples, x, e } = host()
    const bridge = new Bridge(doc, sink, async () => [click], SR)
    await tick()
    updateTrack(doc, t, { pan: -1 })
    setLoop(doc, { start: 1000, end: 1777, on: true })
    bridge.play(900)
    const l = samples(4000)
    const at = [...l.keys()].filter((i) => l[i] !== 0)
    expect(at).toEqual([100, 877, 1654, 2431, 3208, 3985])
    expect(x.engine_position(e)).toBeGreaterThanOrEqual(1000)
    expect(x.engine_position(e)).toBeLessThan(1777)
    bridge.setRecording(true) // a take plays straight through
    bridge.seek(900)
    const s2 = samples(4000)
    expect([...s2.keys()].filter((i) => s2[i] !== 0)).toEqual([100])
  })

  it('meters: the worklet read gives post-fader peaks per doc track and the master', async () => {
    const doc = new Y.Doc()
    const a = addTrack(doc, 'a')
    const b = addTrack(doc, 'b')
    const dc = new Float32Array(SR).fill(0.5)
    addSample(doc, { hash: 'dc', name: 'dc', duration: 1, size: SR * 4, mime: 'audio/wav' })
    addAudioClip(doc, { trackId: a, sourceHash: 'dc', start: 0, length: SR })
    addAudioClip(doc, { trackId: b, sourceHash: 'dc', start: 0, length: SR })
    const { sink, samples, x, e } = host()
    const bridge = new Bridge(doc, sink, async () => [dc], SR)
    await tick()
    updateTrack(doc, a, { pan: -1, gain: 0.5 })
    updateTrack(doc, b, { pan: 1, muted: true })
    bridge.play(0)
    samples(2048)
    readMeters(x, e) // past the gain ramps
    samples(1024)
    const { m, silent } = readMeters(x, e)
    expect(silent).toBe(false)
    const got = bridge.meters(m)
    expect(got.master[0]).toBeCloseTo(0.25, 6)
    expect(got.master[1]).toBe(0)
    expect(got.tracks.get(a)![0]).toBeCloseTo(0.25, 6)
    expect(got.tracks.get(b)).toEqual([0, 0])
    bridge.stop()
    samples(4096)
    readMeters(x, e)
    expect(readMeters(x, e).silent).toBe(true)
  })
})
