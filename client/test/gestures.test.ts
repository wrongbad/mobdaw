import { describe, expect, it } from 'vitest'
import type { AudioClip, MidiClip } from '@mobdaw/shared'
import { snapTracker } from '../src/ui/blocks'
import { repeatSeams, snapTargets, sourceFrames, trimSnap } from '../src/ui/gestures'
import { tickGrid } from '../src/ui/ticks'

const RATE = 48000
const audio = (o: Partial<AudioClip> = {}): AudioClip => ({ id: 'a', trackId: 't', kind: 'audio', start: 0, length: 4 * RATE, sourceHash: 'h', sourceOffset: 0, gain: 1, fadeIn: 0, fadeOut: 0, fadeShape: 0, ...o })
const midi = (o: Partial<MidiClip> = {}): MidiClip => ({ id: 'm', trackId: 't', kind: 'midi', start: 0, bpm: 120, ppq: 480, lengthTicks: 4 * 480 * 4, ...o })

describe('repeatSeams', () => {
  it('has none for a clip that does not loop', () => {
    expect(repeatSeams([audio(), midi()], RATE)).toEqual([])
  })
  it('lists where each pass of a looping audio clip ends (inside the clip)', () => {
    const c = audio({ start: RATE, length: 4 * RATE, loopLength: RATE })
    expect(repeatSeams([c], RATE)).toEqual([2 * RATE, 3 * RATE, 4 * RATE])
  })
  it('shifts by the loop phase', () => {
    const c = audio({ start: 0, length: 3 * RATE, loopLength: RATE, loopPhase: RATE / 4 })
    expect(repeatSeams([c], RATE)).toEqual([0.75 * RATE, 1.75 * RATE, 2.75 * RATE])
  })
  it('a forever clip has seams for ten minutes past its start', () => {
    const c = audio({ start: 0, length: 2 * RATE, loopLength: RATE, forever: true })
    const seams = repeatSeams([c], RATE)
    expect(seams.at(-1)!).toBeGreaterThanOrEqual(599 * RATE)
    expect(seams.length).toBeGreaterThan(500)
  })
  it('a looping MIDI clip repeats its pattern', () => {
    const c = midi({ loopTicks: 480 * 4, lengthTicks: 480 * 12 }) // 2 s a bar at 120 bpm
    expect(repeatSeams([c], RATE)).toEqual([2 * RATE, 4 * RATE]) // (a seam at the very end is not one)
  })
})

describe('snapTargets', () => {
  it('has the start, the playhead, the others\' edges and the pads\' edges', () => {
    const t = snapTargets({ position: 1000.4, others: [audio({ start: 10, length: 20 })], pads: [{ start: 100, length: 50 }], rate: RATE })
    expect(t).toEqual([0, 1000, 10, 30, 100, 150])
  })
  it('adds the other clips\' seams and, for the loop handle, the whole passes of this clip', () => {
    const other = audio({ start: 0, length: 3 * RATE, loopLength: RATE })
    const t = snapTargets({ position: 0, others: [other], pads: [], rate: RATE, loop: { start: 0, pass: RATE, phase: 0, drawn: 2 * RATE } })
    expect(t).toContain(RATE)
    expect(t).toContain(2 * RATE)
    expect(t).toContain(2 * RATE + 600 * RATE) // (up to ten minutes past its drawn end)
    expect(t.filter((x) => x === RATE).length).toBeGreaterThan(1) // (the other's seam and this clip's own pass)
  })
})

describe('trimSnap', () => {
  const at = (targets: number[]) => snapTracker(targets, 100)
  it('moves the edge onto a target within the tolerance', () => {
    // right edge at 1000 + 495, moved by d = 495: the target 1500 is 5 away
    expect(trimSnap(at([1500]), 'r', 0, 1000, 495, 10)).toEqual({ d: 500, at: 1500 })
    // left edge: start 200, d = -195 puts it at 5: the target 0 pulls it to 0
    expect(trimSnap(at([0]), 'l', 200, 1000, -195, 10)).toEqual({ d: -200, at: 0 })
  })
  it('leaves it alone out of reach', () => {
    expect(trimSnap(at([5000]), 'r', 0, 1000, 495, 10)).toEqual({ d: 495, at: null })
  })
})

describe('sourceFrames', () => {
  const store = { samples: { h: { duration: 2 } } } as never
  it('is the source\'s length for audio, infinite for MIDI and unknown sources', () => {
    expect(sourceFrames(store, RATE, audio())).toBe(2 * RATE)
    expect(sourceFrames(store, RATE, audio({ sourceHash: 'x' }))).toBe(Infinity)
    expect(sourceFrames(store, RATE, midi())).toBe(Infinity)
  })
})

describe('tickGrid', () => {
  it('ticks every second when zoomed in, every 5 or 10 when out', () => {
    expect(tickGrid(60, 80)).toEqual({ step: 1, count: 61 })
    expect(tickGrid(60, 20)).toEqual({ step: 5, count: 13 })
    expect(tickGrid(60, 10)).toEqual({ step: 10, count: 7 })
  })
})
