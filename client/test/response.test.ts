import { describe, expect, it } from 'vitest'
import { FILTER_BANDPASS, FILTER_BELL, FILTER_HIGH_SHELF, FILTER_LOW_SHELF, FILTER_HIGHPASS, FILTER_LOWPASS, FILTER_NOTCH, FILTER_PEAK, dampingAtNodeDb, filterNodeDb, filterResponseDb } from '@mobdaw/shared'

const R = Math.SQRT1_2
const db = (g: number) => 20 * Math.log10(g)

describe('filter response', () => {
  it('lowpass: flat, -3 dB at a Butterworth cutoff, -12 dB/octave above', () => {
    expect(filterResponseDb({ mode: FILTER_LOWPASS, cutoff: 1000, damping: R }, 20)).toBeCloseTo(0, 1)
    expect(filterResponseDb({ mode: FILTER_LOWPASS, cutoff: 1000, damping: R }, 1000)).toBeCloseTo(-3.01, 1)
    const a = filterResponseDb({ mode: FILTER_LOWPASS, cutoff: 100, damping: R }, 2000)
    const b = filterResponseDb({ mode: FILTER_LOWPASS, cutoff: 100, damping: R }, 4000)
    expect(a - b).toBeCloseTo(12, 0)
  })
  it('highpass mirrors lowpass', () => {
    expect(filterResponseDb({ mode: FILTER_HIGHPASS, cutoff: 1000, damping: R }, 1000)).toBeCloseTo(-3.01, 1)
    expect(filterResponseDb({ mode: FILTER_HIGHPASS, cutoff: 1000, damping: R }, 20000)).toBeCloseTo(0, 0)
    expect(filterResponseDb({ mode: FILTER_HIGHPASS, cutoff: 1000, damping: R }, 50)).toBeLessThan(-50)
  })
  it('gain at the cutoff follows damping: 1/2R, and 1/R for peak', () => {
    for (const d of [0.1, 0.5, 1.5]) {
      expect(filterResponseDb({ mode: FILTER_LOWPASS, cutoff: 2000, damping: d }, 2000)).toBeCloseTo(db(1 / (2 * d)), 3)
      expect(filterResponseDb({ mode: FILTER_BANDPASS, cutoff: 2000, damping: d }, 2000)).toBeCloseTo(db(1 / (2 * d)), 3)
      expect(filterResponseDb({ mode: FILTER_PEAK, cutoff: 2000, damping: d }, 2000)).toBeCloseTo(db(1 / d), 3)
    }
  })
  it('notch is silent at the cutoff and flat away from it', () => {
    expect(filterResponseDb({ mode: FILTER_NOTCH, cutoff: 1000, damping: R }, 1000)).toBeLessThan(-100)
    expect(filterResponseDb({ mode: FILTER_NOTCH, cutoff: 1000, damping: R }, 20)).toBeCloseTo(0, 1)
  })
  it('node height round-trips to damping', () => {
    for (const mode of [FILTER_LOWPASS, FILTER_NOTCH, FILTER_PEAK]) {
      for (const d of [0.05, 0.7071, 2]) expect(dampingAtNodeDb(mode, filterNodeDb({ mode, cutoff: 1000, damping: d }))).toBeCloseTo(d, 6)
    }
  })
  it('bell: full gain at the centre, flat far away; shelves: gain on their side, half of it at the cutoff', () => {
    for (const gain of [-12, 9, 24]) {
      expect(filterResponseDb({ mode: FILTER_BELL, cutoff: 1000, damping: R, gain }, 1000)).toBeCloseTo(gain, 2)
      expect(filterResponseDb({ mode: FILTER_BELL, cutoff: 1000, damping: R, gain }, 20)).toBeCloseTo(0, 0)
      expect(filterResponseDb({ mode: FILTER_LOW_SHELF, cutoff: 1000, damping: R, gain }, 20)).toBeCloseTo(gain, 0)
      expect(filterResponseDb({ mode: FILTER_LOW_SHELF, cutoff: 1000, damping: R, gain }, 1000)).toBeCloseTo(gain / 2, 0)
      expect(filterResponseDb({ mode: FILTER_HIGH_SHELF, cutoff: 1000, damping: R, gain }, 20000)).toBeCloseTo(gain, 0)
      expect(filterResponseDb({ mode: FILTER_HIGH_SHELF, cutoff: 1000, damping: R, gain }, 1000)).toBeCloseTo(gain / 2, 0)
    }
    expect(filterResponseDb({ mode: FILTER_BELL, cutoff: 1000, damping: R, gain: 0 }, 3000)).toBeCloseTo(0, 6)
    expect(filterNodeDb({ mode: FILTER_BELL, cutoff: 1000, damping: R, gain: 7 })).toBe(7)
  })
  it('bell, low shelf and high shelf match the engine mix (time-domain SVF)', () => {
    const sr = 48000
    const measure = (mode: number, fc: number, damping: number, gainDb: number, hz: number) => {
      const a = 10 ** (gainDb / 40)
      const k = 2 * damping
      let warp = 1, d = damping, m0 = 1, m1 = 0, m2 = 0
      if (mode === FILTER_BELL) { d = damping / a; m1 = (k / a) * (a * a - 1) }
      else if (mode === FILTER_LOW_SHELF) { warp = 1 / Math.sqrt(a); m1 = k * (a - 1); m2 = a * a - 1 }
      else { warp = Math.sqrt(a); m0 = a * a; m1 = k * (1 - a) * a; m2 = 1 - a * a }
      const g = Math.tan((Math.PI * fc) / sr) * warp
      const r2g = d * 2 + g
      const norm = 1 / (1 + r2g * g)
      let s1 = 0, s2 = 0, sum = 0
      for (let n = 0; n < 8000; n++) {
        const x = Math.sin((2 * Math.PI * hz * n) / sr)
        const hp = (x - r2g * s1 - s2) * norm
        const bp = g * hp + s1
        s1 = g * hp + bp
        const lp = g * bp + s2
        s2 = g * bp + lp
        if (n >= 4000) sum += (m0 * x + m1 * bp + m2 * lp) ** 2
      }
      return db(Math.sqrt((2 * sum) / 4000))
    }
    for (const mode of [FILTER_BELL, FILTER_LOW_SHELF, FILTER_HIGH_SHELF]) {
      for (const [fc, d, gain, hz] of [[1000, R, 12, 700], [3000, 0.2, -15, 4000], [200, 1.2, 20, 90], [10000, 0.5, 6, 15000]]) {
        expect(filterResponseDb({ mode, cutoff: fc, damping: d, gain }, hz, sr)).toBeCloseTo(measure(mode, fc, d, gain, hz), 1)
      }
    }
  })
  it('matches the engine filter (zero-delay trapezoidal SVF) near Nyquist too', () => {
    const sr = 48000
    const measure = (fc: number, damping: number, hz: number) => {
      const g = Math.tan((Math.PI * fc) / sr)
      const r2g = damping * 2 + g
      const norm = 1 / (1 + r2g * g)
      let s1 = 0, s2 = 0, sum = 0
      for (let n = 0; n < 8000; n++) {
        const x = Math.sin((2 * Math.PI * hz * n) / sr)
        const hp = (x - r2g * s1 - s2) * norm
        const bp = g * hp + s1
        s1 = g * hp + bp
        const lp = g * bp + s2
        s2 = g * bp + lp
        if (n >= 4000) sum += lp * lp // RMS: sampled peaks undershoot when there are few samples per cycle
      }
      return db(Math.sqrt((2 * sum) / 4000))
    }
    for (const [fc, d, hz] of [[1000, R, 3000], [8000, 0.2, 6000], [16000, 0.5, 20000], [300, 1.5, 100]]) {
      expect(filterResponseDb({ mode: FILTER_LOWPASS, cutoff: fc, damping: d }, hz, sr)).toBeCloseTo(measure(fc, d, hz), 1)
    }
  })
})
