import { timeMap, type Region } from '@mobdaw/shared'
import { expect, test } from 'vitest'
import { buildBars } from '../src/score/measures'
import { chordEvents, notateStaff } from '../src/score/notate'
import { quantizeNotes } from '../src/score/quantize'
import { metered, PPQ, Q } from './scoreFixture'

/** Notes [tick, dur, pitch] (in quarters) -> per bar a compact description: length in quarters, "r" rest, "~" tied on, "^" tied from, "(n" tuplet start. */
function run(notes: [number, number, number][], regions: Region[] = [], nBars = 1) {
  const map = timeMap(regions, 48000, PPQ)
  const bs = buildBars(map, map.barStart(nBars + 1) - 1, [])
  const qn = notes.map(([t, d]) => ({ tick: t * Q, dur: d * Q }))
  const q = quantizeNotes(qn, bs, PPQ)
  const evs = chordEvents(notes.map(([, , p], i) => ({ on: q.on[i], end: q.end[i], pitch: p, noteId: `n${i}` })))
  return notateStaff(evs, bs, q.windows, PPQ).map((bar) =>
    bar.map((p) => `${p.tuplet ? `(${p.tuplet}:` : ''}${p.whole ? 'W' : +(p.len / Q).toFixed(3)}${p.heads.length ? '' : 'r'}${p.cont ? '^' : ''}${p.tie ? '~' : ''}`),
  )
}

test('4/4 quarters and eighths', () => {
  expect(run([[0, 1, 60], [1, 1, 62], [2, 1, 64], [3, 1, 65]])).toEqual([['1', '1', '1', '1']])
  expect(run(Array.from({ length: 8 }, (_, i) => [i / 2, 0.5, 60 + i] as [number, number, number]))).toEqual([Array(8).fill('0.5')])
})

test('gaps become rests; an empty bar is one whole-bar rest', () => {
  expect(run([[1, 1, 60]], [], 2)).toEqual([['1r', '1', '2r'], ['Wr']])
})

test('a dotted rhythm', () => {
  expect(run([[0, 1.5, 60], [1.5, 0.5, 62], [2, 2, 64]])).toEqual([['1.5', '0.5', '2']])
})

test('a syncopation across beat 3 is tied at the beat', () => {
  expect(run([[0, 2, 60], [2.5, 1, 62], [3.5, 0.5, 64]])).toEqual([['2', '0.5r', '0.5~', '0.5^', '0.5']])
})

test('half-bar groups: a dotted half from beat 1 is cut at the middle of 4/4', () => {
  expect(run([[0, 3, 60], [3, 1, 62]])).toEqual([['2~', '1^', '1']])
  expect(run([[0, 4, 60]])).toEqual([['4']]) // starts and ends on group lines: allowed over the middle
})

test('a note across a bar line is tied; the rest of the second bar fills with rests', () => {
  expect(run([[3, 2, 60]], [], 2)).toEqual([['2r', '1r', '1~'], ['1^', '1r', '2r']])
})

test('chords: same onset, ends at the earliest of latest end and next onset; overlaps are trimmed', () => {
  const evs = chordEvents([
    { on: 0, end: 960, pitch: 60, noteId: 'a' }, { on: 0, end: 1920, pitch: 64, noteId: 'b' }, { on: 960, end: 1920, pitch: 67, noteId: 'c' },
  ])
  expect(evs.map((e) => [e.start, e.end, e.heads.map((h) => h.pitch)])).toEqual([[0, 960, [60, 64]], [960, 1920, [67]]])
})

test('triplet eighths are a 3:2 tuplet of three written eighths', () => {
  expect(run([[0, 1 / 3, 60], [1 / 3, 1 / 3, 62], [2 / 3, 1 / 3, 64], [1, 1, 65]])).toEqual([['(3:0.5', '0.5', '0.5', '1', '2r']])
})

test('a humanized sixteenth run notates as clean sixteenths', () => {
  const jitter = [12, -18, 20, -5, 17, -20, 3, 9]
  const notes = jitter.map((j, i) => [Math.max(0, (i + j / 960 * 4) / 4), 0.2, 60] as [number, number, number])
  const got = run(notes)[0]
  expect(got.slice(0, 8)).toEqual(Array(8).fill('0.25'))
})

test('7/8 with groups 2+2+3: a held note splits at the group lines', () => {
  const r = [metered(1, 7, 8, { groups: [2, 2, 3] })]
  expect(run(Array.from({ length: 7 }, (_, i) => [i / 2, 0.5, 60] as [number, number, number]), r)).toEqual([Array(7).fill('0.5')])
  expect(run([[0, 3.5, 60]], r)).toEqual([['2~', '1.5^']])
  expect(run([[1, 1.5, 60]], r)).toEqual([['1r', '1~', '0.5^', '1r']])
})

test('6/8: sixes and dotted quarters; a whole bar is one dotted half', () => {
  const r = [metered(1, 6, 8)]
  expect(run(Array.from({ length: 6 }, (_, i) => [i / 2, 0.5, 60] as [number, number, number]), r)).toEqual([Array(6).fill('0.5')])
  expect(run([[0, 1.5, 60], [1.5, 1.5, 62]], r)).toEqual([['1.5', '1.5']])
  expect(run([[0, 3, 60]], r)).toEqual([['3']])
})

test('a meter change: each bar splits by its own meter', () => {
  const r = [metered(1, 4, 4), metered(2, 3, 4)]
  expect(run([[0, 4, 60], [4, 3, 62]], r, 2)).toEqual([['4'], ['3']])
})

test('a free bar is notated proportionally with no meter lines', () => {
  const r: Region[] = [{ id: 'f', bar: 1, kind: 'free', length: 96000 }]
  expect(run([[0, 1, 60], [1, 1, 62]], r)).toEqual([['1', '1', '2r']])
})
