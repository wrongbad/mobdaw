import { timeMap } from '@mobdaw/shared'
import { expect, test } from 'vitest'
import { beatLines, buildBars, groupBounds } from '../src/score/measures'
import { metered, PPQ, Q } from './scoreFixture'

const bars = (regions: Parameters<typeof timeMap>[0], endTick: number, markers = [] as { id: string; bar: number; label: string }[]) => buildBars(timeMap(regions, 48000, PPQ), endTick, markers)

test('bars run from 1 to the one holding the last tick; at least one', () => {
  const b = bars([], 9 * Q)
  expect(b.map((x) => x.bar)).toEqual([1, 2, 3])
  expect(b[1]).toMatchObject({ startTick: 4 * Q, endTick: 8 * Q, num: 4, den: 4, beatTicks: Q, barTicks: 4 * Q })
  expect(bars([], 8 * Q).length).toBe(2) // ends exactly on a bar line: no empty bar
  expect(bars([], 0).length).toBe(1)
})

test('meter and tempo changes, ramp text and markers', () => {
  const b = bars([metered(1, 4, 4), metered(3, 7, 8, { groups: [2, 2, 3], bpm: 100, rampTo: 140 }), metered(5, 3, 4, { bpm: 140 })], 20 * Q, [{ id: 'm', bar: 3, label: 'A' }])
  expect(b.map((x) => x.meterChanged)).toEqual([false, false, true, false, true, false])
  expect(b.map((x) => x.tempoChanged)).toEqual([false, false, true, false, false, false]) // bar 5 continues the ramp's end tempo
  expect(b[2]).toMatchObject({ den: 8, groups: [2, 2, 3], ramp: 'accel.', marker: 'A', barTicks: 3.5 * Q })
  expect(b[3].ramp).toBeUndefined()
  expect(b[2].marker).toBe('A')
  expect(bars([metered(1, 4, 4, { bpm: 140 }), metered(2, 4, 4, { bpm: 100, rampTo: 70 }), metered(3, 4, 4)], 12 * Q)[1].ramp).toBe('rit.')
})

test('a free region is one bar of nominal length and flags the meter change both ways', () => {
  const b = bars([{ id: 'f', bar: 2, kind: 'free', length: 48000 }, metered(1, 4, 4)], 9 * Q)
  expect(b.map((x) => x.free)).toEqual([false, true, false])
  expect(b[1].barTicks).toBeCloseTo(2 * Q) // 1 s at 120 bpm
  expect(b.map((x) => x.meterChanged)).toEqual([false, true, true])
  expect(b[2].tempoChanged).toBe(false)
})

test('beat groups: halves in 4/4, threes in 6/4, the region\'s groups in 7/8, one in 3/4; beams per quarter or per group', () => {
  const g = (num: number, den: number, groups?: number[]) => {
    const b = bars([metered(1, num, den, groups ? { groups } : {})], 1)[0]
    return [groupBounds(b).map((t) => t / Q), beatLines(b, PPQ).map((t) => t / Q)]
  }
  expect(g(4, 4)).toEqual([[0, 2, 4], [0, 1, 2, 3, 4]])
  expect(g(6, 4)).toEqual([[0, 3, 6], [0, 1, 2, 3, 4, 5, 6]])
  expect(g(3, 4)).toEqual([[0, 3], [0, 1, 2, 3]])
  expect(g(7, 8, [2, 2, 3])).toEqual([[0, 1, 2, 3.5], [0, 1, 2, 3.5]])
  expect(g(6, 8)).toEqual([[0, 1.5, 3], [0, 1.5, 3]])
  expect(g(5, 4, [3, 2])).toEqual([[0, 3, 5], [0, 1, 2, 3, 4, 5]])
})
