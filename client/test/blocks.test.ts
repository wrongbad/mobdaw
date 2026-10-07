import { describe, expect, it } from 'vitest'
import { grabAt, trimBlock, trimMidiLeft } from '../src/ui/blocks'

const box = (left: number, width: number) => ({ left, right: left + width, width }) as DOMRect

describe('grabAt', () => {
  it('finds the edges and the body, and keeps a middle on narrow blocks', () => {
    expect(grabAt(101, box(100, 200))).toBe('l')
    expect(grabAt(298, box(100, 200))).toBe('r')
    expect(grabAt(200, box(100, 200))).toBe('move')
    expect(grabAt(105, box(100, 12))).toBe('move') // each edge is at most a third: 4 px of 12
    expect(grabAt(101, box(100, 12))).toBe('l')
  })
})

describe('trimBlock', () => {
  const b = { start: 1000, length: 5000 }
  const o = { minLength: 100, slackLeft: 400 }
  it('left edge: start and length move together, bounded by the slack and the minimum length', () => {
    expect(trimBlock('l', b, 300, o)).toEqual({ start: 1300, length: 4700, d: 300 })
    expect(trimBlock('l', b, -300, o)).toEqual({ start: 700, length: 5300, d: -300 })
    expect(trimBlock('l', b, -9999, o).d).toBe(-400) // can't pass what is left of the source / timeline 0
    expect(trimBlock('l', b, 9999, o).length).toBe(100)
  })
  it('right edge: length only, bounded', () => {
    expect(trimBlock('r', b, 700, o)).toEqual({ start: 1000, length: 5700, d: 0 })
    expect(trimBlock('r', b, -9999, o).length).toBe(100)
    expect(trimBlock('r', b, 9999, { ...o, maxLength: 6000 }).length).toBe(6000)
  })
})

describe('trimMidiLeft', () => {
  // 120 bpm, ppq 960 at 48 kHz: one beat = 24000 samples, a 1/16 step = 240 ticks = 6000 samples
  const c = { start: 48000, bpm: 120, ppq: 960, lengthTicks: 16 * 960 }
  it('moves the start, shortens the clip and reports the ticks the notes must move back by', () => {
    const t = trimMidiLeft(c, 24000, 48000) // one beat to the right
    expect(t).toEqual({ start: 72000, lengthTicks: 15 * 960, d: 960 })
  })
  it('snaps to 1/16 notes, restores when dragged out, and stops at timeline 0 and the minimum length', () => {
    expect(trimMidiLeft(c, 7000, 48000).d).toBe(240) // 7000 samples ~ 280 ticks -> snaps to one step
    const out = trimMidiLeft(c, -12000, 48000) // half a beat to the left
    expect(out).toEqual({ start: 36000, lengthTicks: 16 * 960 + 480, d: -480 })
    expect(trimMidiLeft(c, -9e6, 48000).start).toBe(0)
    expect(trimMidiLeft(c, 9e6, 48000).lengthTicks).toBe(240)
  })
})
