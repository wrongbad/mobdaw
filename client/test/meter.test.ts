import { describe, expect, it } from 'vitest'
import { MAX_DB, MIN_DB, RELEASE, follow, peakToFill } from '../src/ui/meter'

describe('peakToFill', () => {
  it('maps dB linearly onto the bar, -60 dB empty and +6 dB full', () => {
    expect(peakToFill(0)).toBe(0)
    expect(peakToFill(10 ** (MIN_DB / 20))).toBeCloseTo(0, 6)
    expect(peakToFill(10 ** (MAX_DB / 20))).toBeCloseTo(1, 6)
    expect(peakToFill(1)).toBeCloseTo(60 / 66, 6) // full scale
    expect(peakToFill(10 ** (-30 / 20))).toBeCloseTo(30 / 66, 6)
  })
  it('clamps below and above the scale and ignores junk', () => {
    expect(peakToFill(1e-6)).toBe(0)
    expect(peakToFill(100)).toBe(1)
    expect(peakToFill(-1)).toBe(0)
    expect(peakToFill(NaN)).toBe(0)
  })
})

describe('follow', () => {
  it('attacks at once', () => {
    expect(follow(0.1, 0.8, 16)).toBe(0.8)
    expect(follow(0.5, 0.5, 16)).toBe(0.5)
  })
  it('releases at a fixed rate and stops at the target', () => {
    expect(follow(0.9, 0, 100)).toBeCloseTo(0.9 - RELEASE * 0.1, 9)
    expect(follow(0.9, 0.85, 1000)).toBe(0.85)
    let v = 1
    for (let i = 0; i < 100; i++) v = follow(v, 0, 16)
    expect(v).toBe(0)
  })
})
