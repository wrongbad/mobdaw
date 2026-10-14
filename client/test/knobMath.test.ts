import { describe, expect, it } from 'vitest'
import { DEVICES, paramToPos, paramToValue } from '@mobdaw/shared'
import { angleToPos, formatParam, isBipolar, posToAngle } from '../src/ui/knobMath'

describe('knob maths', () => {
  it('maps position to angle and back', () => {
    expect(posToAngle(0)).toBe(-135)
    expect(posToAngle(0.5)).toBe(0)
    expect(posToAngle(1)).toBe(135)
    expect(posToAngle(2)).toBe(135)
    for (const t of [0, 0.2, 0.77, 1]) expect(angleToPos(posToAngle(t))).toBeCloseTo(t)
  })
  it('log params round-trip through the knob position', () => {
    const cutoff = DEVICES[1].params[1]
    expect(paramToPos(cutoff, paramToValue(cutoff, 0.5))).toBeCloseTo(0.5)
    expect(posToAngle(paramToPos(cutoff, 20))).toBe(-135)
    expect(paramToValue(cutoff, 0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 3)
  })
  it('knows bipolar params', () => {
    expect(isBipolar({ min: -24, max: 24, scale: 'lin' })).toBe(true)
    expect(isBipolar({ min: 0, max: 1, scale: 'lin' })).toBe(false)
  })
  it('formats by unit', () => {
    expect(formatParam({ min: -24, max: 24, unit: 'db' }, 3)).toBe('+3.0 dB')
    expect(formatParam({ min: -60, max: 0, unit: 'db' }, -18)).toBe('-18.0 dB')
    expect(formatParam({ min: 20, max: 20000, unit: 'hz' }, 1000)).toBe('1.00 kHz')
    expect(formatParam({ min: 20, max: 20000, unit: 'hz' }, 440)).toBe('440 Hz')
    expect(formatParam({ min: 0, max: 5000, unit: 'ms' }, 300)).toBe('300 ms')
    expect(formatParam({ min: 0, max: 5000, unit: 'ms' }, 2500)).toBe('2.50 s')
    expect(formatParam({ min: 1, max: 20, unit: ':1' }, 4)).toBe('4.00:1')
    expect(formatParam({ min: 0, max: 1 }, 0.3)).toBe('30%')
    expect(formatParam({ min: -1, max: 1 }, 0)).toBe('C')
  })
})
