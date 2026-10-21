import { expect, test } from 'vitest'
import { cutOverlaps, flattenTrack } from '../src/score/flatten'
import { fixture, Q } from './scoreFixture'

const flat = (inp: ReturnType<typeof fixture>, i = 0, drums = false) => flattenTrack(inp.tracks[i], drums, inp)

test('notes land in absolute ticks, sorted', () => {
  const f = flat(fixture([{ notes: [[Q, Q, 64], [0, Q, 60]] }]))
  expect(f.notes.map((n) => [n.tick, n.dur, n.pitch, n.repeat])).toEqual([[0, Q, 60, 0], [Q, Q, 64, 0]])
  expect(f.notes[0].noteId).toBe('n0_1')
})

test('a looped clip is written out; later passes carry repeat, notes past the pattern are dropped, ends cut at the pass end', () => {
  const inp = fixture([{ notes: [[0, Q, 60], [3 * Q, 2 * Q, 62], [5 * Q, Q, 64]], loop: 4 * Q, length: 10 * Q }])
  const f = flat(inp)
  expect(f.notes.map((n) => [n.tick, n.dur, n.pitch, n.repeat])).toEqual([
    [0, Q, 60, 0], [3 * Q, Q, 62, 0], // 62 cut at the pass end
    [4 * Q, Q, 60, 1], [7 * Q, Q, 62, 1],
    [8 * Q, Q, 60, 2], // the clip ends at 10Q: the third pass holds only the first two beats
  ])
})

test('the last pass is cut at the clip end', () => {
  const inp = fixture([{ notes: [[0, 3 * Q, 60]], loop: 4 * Q, length: 6 * Q }])
  expect(flat(inp).notes.map((n) => [n.tick, n.dur, n.repeat])).toEqual([[0, 3 * Q, 0], [4 * Q, 2 * Q, 1]])
})

test('same-pitch overlaps are cut at the later onset; other pitches keep their length', () => {
  const notes = [
    { noteId: 'a', tick: 0, dur: 2 * Q, pitch: 60, velocity: 1, repeat: 0 },
    { noteId: 'b', tick: Q, dur: Q, pitch: 60, velocity: 1, repeat: 0 },
    { noteId: 'c', tick: 0, dur: 2 * Q, pitch: 64, velocity: 1, repeat: 0 },
  ]
  expect(cutOverlaps(notes).map((n) => [n.noteId, n.dur])).toEqual([['a', Q], ['c', 2 * Q], ['b', Q]])
})

test('drum names come from the track\'s drum devices', () => {
  const inp = fixture([{ notes: [[0, 100, 36]], drumNames: { 36: 'kick', 38: 'snare' } }])
  expect([...flat(inp, 0, true).drumNames]).toEqual([[36, 'kick'], [38, 'snare']])
  expect(flat(inp, 0, false).drumNames.size).toBe(0)
})
