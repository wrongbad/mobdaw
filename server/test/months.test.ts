import { describe, expect, it } from 'vitest'
import { addMonths, monthsLeft } from '@mobdaw/shared'

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 12)

describe('months', () => {
  it('adds calendar months, clamping to the end of shorter months', () => {
    expect(addMonths(utc(2026, 1, 15), 1)).toBe(utc(2026, 2, 15))
    expect(addMonths(utc(2026, 1, 31), 1)).toBe(utc(2026, 2, 28))
    expect(addMonths(utc(2028, 1, 31), 1)).toBe(utc(2028, 2, 29)) // leap year
    expect(addMonths(utc(2026, 11, 30), 3)).toBe(utc(2027, 2, 28))
    expect(addMonths(utc(2026, 10, 10), 12)).toBe(utc(2027, 10, 10))
    expect(addMonths(utc(2026, 10, 10), 0)).toBe(utc(2026, 10, 10))
    expect(new Date(addMonths(utc(2026, 10, 10), 999)).getUTCFullYear()).toBe(2110) // 83 years and 3 months
  })

  it('counts months left, rounding up', () => {
    const now = utc(2026, 10, 10)
    expect(monthsLeft(addMonths(now, 3), now)).toBe(3)
    expect(monthsLeft(addMonths(now, 3) - 1000, now)).toBe(3) // a moment short of 3 months still reads 3
    expect(monthsLeft(addMonths(now, 3) + 1000, now)).toBe(4)
    expect(monthsLeft(now, now)).toBe(0)
    expect(monthsLeft(now - 1000, now)).toBe(0)
    expect(monthsLeft(addMonths(now, 999), now)).toBe(999)
  })
})
