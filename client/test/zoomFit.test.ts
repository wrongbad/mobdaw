import { describe, expect, it } from 'vitest'
import { MAX_PPS, MIN_PPS, fitPps } from '../src/ui/zoomFit'

describe('fitPps', () => {
  it('fits the end plus a 5% margin into the width', () => {
    expect(fitPps(100, 1050)).toBeCloseTo(10) // 1050 / 105 = 10
    expect(fitPps(40, 840)).toBeCloseTo(20)
  })
  it('treats an empty or very short project as 8 bars at 120 bpm', () => {
    expect(fitPps(0, 1680)).toBeCloseTo(100)
    expect(fitPps(3, 1680)).toBe(fitPps(0, 1680))
  })
  it('clamps to the zoom limits', () => {
    expect(fitPps(10000, 500)).toBe(MIN_PPS)
    expect(fitPps(0, 1e9)).toBe(MAX_PPS)
    expect(fitPps(10, NaN)).toBe(MIN_PPS)
  })
})
