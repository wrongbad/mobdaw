import { timeMap } from '@mobdaw/shared'
import { expect, test } from 'vitest'
import { buildBars } from '../src/score/measures'
import { quantizeNotes } from '../src/score/quantize'
import { metered, PPQ, Q } from './scoreFixture'

const barsOf = (n: number, num = 4, den = 4) => buildBars(timeMap([metered(1, num, den)], 48000, PPQ), n * ((num * 4 * Q) / den) - 1, [])
const q = (notes: [number, number][], bars = barsOf(1), opts = {}) => quantizeNotes(notes.map(([tick, dur]) => ({ tick, dur })), bars, PPQ, opts)

test('times already on a coarse grid stay; windows take the coarsest division', () => {
  const r = q([[0, Q], [Q, Q / 2], [1.5 * Q, Q / 2], [2 * Q, 2 * Q]])
  expect(r.on).toEqual([0, Q, 1.5 * Q, 2 * Q])
  expect(r.end).toEqual([Q, 1.5 * Q, 2 * Q, 4 * Q])
  expect(r.windows[0].map((w) => w.div)).toEqual([1, 2, 1, 1])
})

test('eighth triplets and sixteenth sextuplets are recognised', () => {
  expect(q([[0, Q / 3], [Q / 3, Q / 3], [(2 * Q) / 3, Q / 3]]).windows[0][0].div).toBe(3)
  expect(q([[0, Q / 6], [Q / 6, Q / 6], [Q / 3, Q / 6]]).windows[0][0].div).toBe(6)
})

test('a humanized performance (+-20 ticks) snaps to clean sixteenths', () => {
  const jitter = [12, -18, 20, -5, 17, -20, 3, 9, -14, 19, -2, 8, -16, 11, -9, 15]
  const notes: [number, number][] = jitter.map((j, i) => [Math.max(0, (i * Q) / 4 + j), Q / 4 - 6])
  const r = q(notes)
  expect(r.on).toEqual(jitter.map((_, i) => (i * Q) / 4))
  expect(r.windows[0].map((w) => w.div)).toEqual([4, 4, 4, 4])
  expect(r.end.every((e, i) => e === ((i + 1) * Q) / 4)).toBe(true)
})

test('a humanized triplet beat picks 3 over 4 by total error', () => {
  const r = q([[5, Q / 3], [Q / 3 - 12, Q / 3], [(2 * Q) / 3 + 9, Q / 3 - 4]])
  expect(r.windows[0][0].div).toBe(3)
  expect(r.on).toEqual([0, Q / 3, (2 * Q) / 3])
})

test('an end that snaps onto its onset becomes one step long', () => {
  const r = q([[0, 20]])
  expect(r.on[0]).toBe(0)
  expect(r.end[0]).toBe(Q) // the onset alone picks the grid (a quarter): the end rounds up to it, and the note is staccato
  expect(r.stac).toEqual([true])
  expect(q([[0, 20], [Q / 4 + 7, 20], [Q / 2, 20], [(3 * Q) / 4, 20]]).end[0]).toBe(Q / 4) // on a 16th grid it is one step
  expect(q([[Q / 4 + 3, 10], [Q / 2, 5]]).end[0]).toBe(Q / 2) // onset and end both snap to the same sixteenth: one step
})

test('eighth-note meters never use tuplets; the last window of 7/8 is short', () => {
  const b = barsOf(1, 7, 8)
  const r = q([[0, Q / 3], [Q / 3, Q / 3], [(2 * Q) / 3, Q / 3]], b)
  expect(r.windows[0].map((w) => w.div)).not.toContain(3)
  expect(r.windows[0].map((w) => [w.start / Q, w.end / Q])).toEqual([[0, 1], [1, 2], [2, 3], [3, 3.5]])
})

test('tuplets can be switched off (drums)', () => {
  expect(q([[0, Q / 3], [Q / 3, Q / 3], [(2 * Q) / 3, Q / 3]], barsOf(1), { tuplets: false }).windows[0][0].div).toBe(4)
  const r = q([[0, 123]], barsOf(1), { ends: false })
  expect(r.windows[0][0].div).toBe(1)
})

test('free bars use coarse halves', () => {
  const b = buildBars(timeMap([{ id: 'f', bar: 1, kind: 'free', length: 96000 }], 48000, PPQ), 1000, [])
  const r = quantizeNotes([{ tick: 100, dur: 300 }, { tick: 700, dur: 500 }], b, PPQ)
  expect(r.windows[0].every((w) => w.div <= 2)).toBe(true)
})

test('ends never vote: 120-tick notes on a 16th grid stay a 16th grid and end one step after the onset', () => {
  const r = q([[0, 120], [720, 120], [1440, 120], [2160, 120]], barsOf(1, 3, 4))
  expect(r.windows[0][0].div).toBe(4) // onsets 0 and 720 fall on a 16th grid
  expect(r.end).toEqual([240, 960, 1680, 2400])
  expect(r.stac).toEqual([true, true, true, true])
})

test('staccato: performed <= 0.6 of written and a quarter or shorter; not when the quantizer merely rests it', () => {
  // a quarter performed as an eighth is staccato; performed 3/4 is not; a half note performed short is too long to mark
  expect(q([[0, Q / 2], [Q, (3 * Q) / 4], [2 * Q, Q / 3]], barsOf(1)).stac).toEqual([true, false, true])
  expect(q([[0, Q], [2 * Q, Q]], barsOf(1)).stac).toEqual([false, false]) // followed by a rest: written as performed
  expect(q([[0, Q], [2 * Q, Q]], barsOf(1)).end).toEqual([Q, 3 * Q])
  expect(q([[0, Q], [2 * Q, 2 * Q - 400]], barsOf(1)).stac).toEqual([false, false]) // a half performed at 0.8: not staccato
  expect(q([[0, 2 * Q]], barsOf(1)).stac).toEqual([false])
})

test('legato: an end just before the next onset goes to it; ends never pass the next onset', () => {
  const r = q([[0, Q - 100], [Q, Q]])
  expect(r.end[0]).toBe(Q)
  expect(q([[0, 3 * Q], [Q, Q]]).end[0]).toBe(Q)
})
