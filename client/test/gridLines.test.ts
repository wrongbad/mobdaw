import { describe, expect, it } from 'vitest'
import { timeMap, type Region } from '@mobdaw/shared'
import { clipGeom, gridLayout } from '../src/ui/gridLines'
import { stepCell } from '../src/ui/drumGrid'

const PPQ = 960
const RATE = 48000
// bars 1: 4/4 at 120 (2 s); bars 2-3: 7/8 (2+2+3) at 120; bar 4: a free bar of 1 s; then 4/4 again
const regions: Region[] = [
  { id: 'a', bar: 1, kind: 'metered', bpm: 120, num: 4, den: 4 },
  { id: 'b', bar: 2, kind: 'metered', bpm: 120, num: 7, den: 8, groups: [2, 2, 3] },
  { id: 'c', bar: 4, kind: 'free', length: 48000 },
  { id: 'd', bar: 5, kind: 'metered', bpm: 120, num: 4, den: 4 },
]
const map = timeMap(regions, RATE, PPQ)
const PPS = 100 // px per second

describe('grid from the time map', () => {
  it('maps clip ticks to the timeline scale', () => {
    const g = clipGeom(map, 3840, PPS)
    expect(g.x(0)).toBe(0)
    expect(g.x(960)).toBeCloseTo(50, 6) // a beat at 120 bpm is 0.5 s
    expect(g.tick(50)).toBeCloseTo(960, 6)
  })
  it('draws bars, beats and 2+2+3 group starts of a 7/8 clip, with sub-steps between', () => {
    // a clip from bar 2 (tick 3840), two 7/8 bars long
    const l = gridLayout(map, 3840, 2 * 3360, PPS, 0)
    const eighth = 25 // 0.25 s at 120 bpm
    expect(l.bar).toEqual([0, 7 * eighth, 14 * eighth].map((x) => expect.closeTo(x, 4)))
    // group starts (beat 3 and 5 of the bar, in eighths: 2+2+3): at 2 and 4 eighths into each bar
    expect(l.group).toEqual([2, 4, 9, 11].map((e) => expect.closeTo(e * eighth, 4)))
    expect(l.beat).toHaveLength(2 * 7 - 2 - 4) // the other eighths (the clip's end line is a bar line too)
    const sub = gridLayout(map, 3840, 3360, PPS, 240, 1) // sixteenths
    expect(sub.sub.length).toBe(7)
  })
  it('leaves free regions blank and shaded', () => {
    const l = gridLayout(map, 3840 + 2 * 3360 - 960, 960 * 3, PPS, 0)
    expect(l.free).toHaveLength(1)
    expect(l.free[0][1] - l.free[0][0]).toBeCloseTo(100, 4) // one second
    expect(l.bar.length).toBe(2) // the free bar's start, then bar 5
  })
  it('follows a ramp: beats get closer as the tempo rises', () => {
    const ramp = timeMap([{ id: 'r', bar: 1, kind: 'metered', bpm: 60, num: 4, den: 4, rampTo: 120 }, { id: 'z', bar: 3, kind: 'metered', bpm: 120, num: 4, den: 4 }], RATE, PPQ)
    const l = gridLayout(ramp, 0, 7680, PPS, 0)
    const xs = [...l.bar, ...l.group, ...l.beat].sort((a, b) => a - b)
    const gaps = xs.slice(1).map((x, i) => x - xs[i])
    expect(gaps[0]).toBeGreaterThan(gaps[gaps.length - 1])
  })
})

describe('drum grid steps', () => {
  it('has 16 sixteenth steps in a 4/4 bar and 14 in a 7/8 bar', () => {
    expect(stepCell(map, 0, 250)).toEqual({ tick: 240, len: 240 })
    expect(stepCell(map, 0, 3839)).toEqual({ tick: 3600, len: 240 })
    expect(stepCell(map, 3840, 3359)).toEqual({ tick: 3120, len: 240 })
    expect(stepCell(map, 3840, 3360)).toEqual({ tick: 3360, len: 240 }) // bar 3's first step
  })
  it('re-grids a clip crossing a meter change, and cuts a short last step', () => {
    // a clip starting at bar 1: local tick 3840 is the 7/8 bar's first step
    expect(stepCell(map, 0, 3840 + 250)).toEqual({ tick: 3840 + 240, len: 240 })
    const odd = timeMap([{ id: 'a', bar: 1, kind: 'metered', bpm: 120, num: 5, den: 16 }], RATE, PPQ) // 1200 ticks a bar: 5 steps
    expect(stepCell(odd, 0, 1199)).toEqual({ tick: 960, len: 240 })
    const three = timeMap([{ id: 'a', bar: 1, kind: 'metered', bpm: 120, num: 3, den: 32 }], RATE, PPQ) // 360 ticks a bar
    expect(stepCell(three, 0, 300)).toEqual({ tick: 240, len: 120 })
  })
  it('has no cells in a free region', () => {
    expect(stepCell(map, 0, 3840 + 2 * 3360 + 100)).toBeNull()
  })
})
