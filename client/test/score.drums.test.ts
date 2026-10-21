import { timeMap } from '@mobdaw/shared'
import { expect, test } from 'vitest'
import { drumEvents, drumHeads } from '../src/score/drums'
import { buildBars } from '../src/score/measures'
import { metered, PPQ, Q } from './scoreFixture'

test('heads by drum name; the kick is the only down-stemmed one', () => {
  const names = new Map([[36, 'kick'], [37, 'rim'], [38, 'snare'], [39, 'clap'], [40, 'tom'], [41, 'floor tom'], [42, 'hat'], [43, 'open hat'], [44, 'crash'], [45, 'perc']])
  const h = drumHeads(names.keys(), names)
  expect([...h].map(([k, v]) => [k, v.pos + (v.x ? 'x' : '') + (v.open ? 'o' : '') + (v.kick ? 'K' : '')])).toEqual([
    [36, 'FK'], [37, 'cx'], [38, 'c'], [39, 'ex'], [40, 'e'], [41, 'A'], [42, 'gx'], [43, 'gxo'], [44, 'ax'], [45, 'B'],
  ])
})

test('unnamed key 36 is the kick; unknown drums take free positions in key order', () => {
  const h = drumHeads([36, 50, 51, 52, 53], new Map([[50, 'accent'], [51, 'tick'], [52, 'x'], [53, 'y']]))
  expect(h.get(36)).toMatchObject({ pos: 'F', kick: true })
  expect([50, 51, 52, 53].map((k) => h.get(k)!.pos)).toEqual(['B', 'd', 'A', 'E'])
  // a known perc already holds B, so an unknown one skips it
  expect(drumHeads([45, 50], new Map([[45, 'perc'], [50, 'zap']])).get(50)!.pos).toBe('d')
})

test('a drum note lasts to the next hit in its voice, at most to the next beat line', () => {
  const heads = drumHeads([36, 38, 42], new Map([[36, 'kick'], [38, 'snare'], [42, 'hat']]))
  const bars = buildBars(timeMap([metered(1, 4, 4)], 48000, PPQ), 4 * Q - 1, [])
  const n = (on: number, pitch: number) => ({ on: on * Q, end: on * Q + 10, pitch, noteId: `${pitch}@${on}` })
  const [up, down] = drumEvents([n(0, 42), n(0, 36), n(0.5, 42), n(2, 38), n(2.5, 42), n(3, 36)], heads, bars, PPQ)
  expect(up.map((e) => [e.start / Q, e.end / Q, e.heads.map((x) => x.pitch)])).toEqual([[0, 0.5, [42]], [0.5, 1, [42]], [2, 2.5, [38]], [2.5, 3, [42]]])
  expect(down.map((e) => [e.start / Q, e.end / Q])).toEqual([[0, 1], [3, 4]]) // capped at the beat line
})
