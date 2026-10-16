import { describe, expect, it } from 'vitest'
import { GAP_MS, SILENT_MS, shouldAutoStop, type AutoStopState, type MeterSample } from '../src/audio/autoStop'

const base: AutoStopState = {
  now: 0, since: 0, position: 1000, end: 500, busy: false, armed: false, monitoring: false, forever: false, loopers: false, held: 0, noteAt: -Infinity,
}
const LOUD: [number, number] = [0.2, 0.2]
const TAIL: [number, number] = [1e-4, 5e-5] // under -70 dBFS
const ZERO: [number, number] = [0, 0]
/** Reports every 33 ms from `from` to `to` (ms) at `peak`. */
const run = (from: number, to: number, peak: [number, number]): MeterSample[] => {
  const out: MeterSample[] = []
  for (let at = from; at <= to; at += 33) out.push({ at, peak })
  return out
}
const at = (now: number, over: Partial<AutoStopState> = {}) => ({ ...base, now, ...over })

describe('autoStop', () => {
  it('stops after the silence window, past the end', () => {
    const s = [...run(0, 1000, LOUD), ...run(1033, 2000, TAIL)]
    expect(shouldAutoStop(at(1033 + SILENT_MS - 40), s.filter((m) => m.at <= 1033 + SILENT_MS - 40))).toBe(false)
    expect(shouldAutoStop(at(1033 + SILENT_MS + 10), s.filter((m) => m.at <= 1033 + SILENT_MS + 10))).toBe(true)
  })
  it('does not stop before the end', () => {
    expect(shouldAutoStop(at(2000, { position: 400 }), run(0, 2000, TAIL))).toBe(false)
    expect(shouldAutoStop(at(2000, { position: 500 }), run(0, 2000, TAIL))).toBe(false)
  })
  it('does not stop while a tail is above the threshold', () => {
    expect(shouldAutoStop(at(3000), run(0, 3000, [0.01, 0]))).toBe(false)
    expect(shouldAutoStop(at(3000), run(0, 3000, [0, 0.01]))).toBe(false)
  })
  it('resets the timer on a loud blip', () => {
    const s = [...run(0, 1000, TAIL), { at: 1010, peak: LOUD }, ...run(1043, 1400, TAIL)]
    expect(shouldAutoStop(at(1400), s)).toBe(false)
    expect(shouldAutoStop(at(1010 + 33 + SILENT_MS + 10), [...s, ...run(1433, 1600, TAIL)])).toBe(true)
  })
  it('does not count a gap in the reports as silence', () => {
    const s = [...run(0, 100, TAIL), ...run(100 + GAP_MS * 4, 100 + GAP_MS * 4 + 100, TAIL)]
    expect(shouldAutoStop(at(100 + GAP_MS * 4 + 100 + 40), s)).toBe(false) // quiet only since the hole closed
    expect(shouldAutoStop(at(100 + GAP_MS * 4 + 100 + SILENT_MS), s)).toBe(false) // reports stopped (not a zero): unknown
  })
  it('counts the hole after the engine\'s zero report as silence', () => {
    const s = [...run(0, 1000, LOUD), { at: 1033, peak: ZERO }]
    expect(shouldAutoStop(at(1033 + 100), s)).toBe(false)
    expect(shouldAutoStop(at(1033 + SILENT_MS), s)).toBe(true)
  })
  it('counts silence from the transport start at the earliest', () => {
    const s: MeterSample[] = [{ at: 0, peak: ZERO }]
    expect(shouldAutoStop(at(5100, { since: 5000 }), s)).toBe(false)
    expect(shouldAutoStop(at(5000 + SILENT_MS, { since: 5000 }), s)).toBe(true)
  })
  it('stops an empty project once silent (end 0, playhead moving)', () => {
    expect(shouldAutoStop(at(2000, { end: 0, position: 10 }), [{ at: 0, peak: ZERO }])).toBe(true)
  })
  const quietAll = [{ at: 0, peak: ZERO }] as MeterSample[]
  it.each<[string, Partial<AutoStopState>]>([
    ['recording', { busy: true }],
    ['loop pedal', { busy: true }],
    ['armed', { armed: true }],
    ['monitoring', { monitoring: true }],
    ['forever clip', { forever: true }],
    ['loopers', { loopers: true }],
    ['held note', { held: 1 }],
    ['recent live note', { noteAt: 1500 }],
  ])('%s blocks it', (_, over) => {
    expect(shouldAutoStop(at(2000), quietAll)).toBe(true)
    expect(shouldAutoStop(at(2000, over), quietAll)).toBe(false)
  })
  it('a live note older than a second no longer blocks', () => {
    expect(shouldAutoStop(at(2000, { noteAt: 900 }), quietAll)).toBe(true)
  })
})
