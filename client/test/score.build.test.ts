import ABCJS from 'abcjs'
import { expect, test } from 'vitest'
import { buildScore, scoreTracks, type BuiltScore, type ScoreInput } from '../src/score'
import { fixture, metered, PPQ, Q, type FixTrack } from './scoreFixture'

const all = (inp: ScoreInput) => new Set(inp.tracks.map((t) => t.id))
const build = (inp: ScoreInput, width = 800) => buildScore(inp, { show: all(inp), width })

/** Parse with abcjs: no warnings, and per system the number of measures of the first staff. */
function parse(r: BuiltScore) {
  const tune = ABCJS.parseOnly(r.abc)[0]
  expect(tune.warnings).toBeUndefined()
  const systems = tune.lines.filter((l: { staff?: unknown }) => l.staff) as { staff: { voices: { el_type: string }[][] }[] }[]
  return { tune, systems, measures: systems.map((s) => s.staff[0].voices[0].filter((e) => e.el_type === 'bar').length), staves: systems[0].staff.length }
}

const run = (i: number, ...q: [number, number][]) => q.map(([t, d]) => [t * Q, d * Q, 60 + i] as [number, number, number])

const flute: FixTrack = { name: 'Flute', notes: [[0, Q, 62], [Q, Q / 2, 64], [1.5 * Q, Q / 2, 66], [2 * Q, 2 * Q, 69], [4 * Q, Q, 62], [5.5 * Q, Q, 61], [7 * Q, Q, 57]] }
const bass: FixTrack = { name: 'Bass', notes: [[0, 2 * Q, 40], [2 * Q, 2 * Q, 45], [4 * Q, 4 * Q, 38]] }
const drums: FixTrack = { name: 'Drums', notes: [[0, 100, 36], [0, 100, 42], [Q, 100, 38], [2 * Q, 100, 36], [2.5 * Q, 100, 42], [3 * Q, 100, 38]], drumNames: { 36: 'kick', 38: 'snare', 42: 'hat' } }

test('scoreTracks: midi tracks with notes, in order, never the click track', () => {
  const inp = fixture([bass, { name: 'Empty', notes: [] }, { name: 'Click', notes: [[0, 100, 60]], role: 'click' }, drums, flute])
  inp.tracks.forEach((t, k) => (t.order = [3, 1, 2, 0, 4][k]))
  expect(scoreTracks(inp)).toEqual([{ id: 't3', name: 'Drums', drums: true }, { id: 't0', name: 'Bass', drums: false }, { id: 't4', name: 'Flute', drums: false }])
})

test('golden: flute, bass and drums over two bars in D major', () => {
  const r = build(fixture([flute, bass, drums], { key: 'D major' }))
  expect(r.abc).toBe(`X:1
L:1/8
M:4/4
Q:1/4=120
%%score [ V1 V2 (V3 V4) ]
V:V1 clef=treble name="Flute"
V:V2 clef=bass name="Bass"
V:V3 clef=perc name="Drums" stem=up
V:V4 clef=perc stem=down
K:C
[V:V1] [K:D clef=treble] D2 EF A4 | D2 zC- Cz A,2 |]
[V:V2] [K:D clef=bass] E,,4 A,,4 | D,,8 |]
[V:V3] !style=x!g2 c2 z!style=x!g c2 | Z |]
[V:V4] F2 x2 F2 x2 | X |]
`)
  expect(r.bars.map((b) => b.bar)).toEqual([1, 2])
  expect(r.lines).toEqual([{ first: 0, last: 1 }])
  expect(r.empty).toBe(false)
  expect(r.staffWidth).toBe(780)
  const p = parse(r)
  expect(p.measures).toEqual([2])
  expect(p.staves).toBe(3) // the drums' two voices share one staff
})

test('ids: each emitted note/chord piece maps back to its doc note ids', () => {
  const r = build(fixture([{ notes: [[0, Q, 60], [0, Q, 64], [Q, 2 * Q, 67]] }]))
  const at = (i: number) => r.abc.slice(r.ids[i].start, r.ids[i].end)
  expect(r.ids.map((x) => x.noteIds)).toEqual([['n0_0', 'n0_1'], ['n0_2'], ['n0_2']])
  expect(at(0)).toBe('[CE]2')
  expect(at(1)).toBe('G2-') // a half note on beat 2 is cut at the middle of the 4/4 bar
  expect(at(2)).toBe('G2')
})

test('empty: nothing chosen, no notes, hidden tracks', () => {
  const inp = fixture([flute, { name: 'Empty', notes: [] }])
  expect(buildScore(inp, { show: new Set(), width: 800 })).toMatchObject({ empty: true, abc: '', bars: [], lines: [], ids: [] })
  expect(buildScore(inp, { show: new Set(['t1']), width: 800 }).empty).toBe(true)
  expect(buildScore(fixture([]), { show: new Set(), width: 800 }).empty).toBe(true)
})

test('hiding a track drops its staff but not the key', () => {
  const inp = fixture([flute, bass, drums])
  const both = build(inp)
  const one = buildScore(inp, { show: new Set(['t0']), width: 800 })
  expect(parse(one).staves).toBe(1)
  const key = (a: string) => /\[K:(\w+#?)/.exec(a)?.[1]
  expect(key(one.abc)).toBe(key(both.abc))
  expect(key(one.abc)).toBeDefined()
})

test('lines pack to the width; every line has the same bars in every voice', () => {
  const notes: [number, number, number][] = Array.from({ length: 64 }, (_, i) => [(i * Q) / 2, Q / 2, 60 + (i % 5)])
  const inp = fixture([{ notes }, { notes: notes.map(([t, d, p]) => [t, d, p - 24] as [number, number, number]) }])
  const narrow = build(inp, 420)
  const wide = build(inp, 1400)
  expect(narrow.lines.length).toBeGreaterThan(wide.lines.length)
  for (const r of [narrow, wide]) {
    expect(r.lines[0].first).toBe(0)
    expect(r.lines.at(-1)!.last).toBe(r.bars.length - 1)
    r.lines.forEach((l, i) => i && expect(l.first).toBe(r.lines[i - 1].last + 1))
    const p = parse(r)
    expect(p.measures).toEqual(r.lines.map((l) => l.last - l.first + 1))
    expect(p.systems.length).toBe(r.lines.length)
  }
})

test('meters: 7/8 (2+2+3), 6/8, a change to 3/4 and back, all parse and show the meter', () => {
  const eighths = (n: number, from = 0): [number, number, number][] => Array.from({ length: n }, (_, i) => [from + (i * Q) / 2, Q / 2, 60])
  const r7 = build(fixture([{ notes: eighths(14) }], { regions: [metered(1, 7, 8, { groups: [2, 2, 3] })] }))
  expect(r7.abc).toContain('M:2+2+3/8')
  expect(r7.abc).toContain('[V:V1] CC CC CCC | CC CC CCC |]') // beamed by group: 2+2+3
  expect(parse(r7).measures).toEqual([2])
  const r6 = build(fixture([{ notes: eighths(12) }], { regions: [metered(1, 6, 8)] }))
  expect(r6.abc).toContain('M:6/8')
  expect(r6.abc).toContain('CCC CCC')
  expect(parse(r6).measures).toEqual([2])
  const quarters = Array.from({ length: 10 }, (_, i) => [i * Q, Q, 60] as [number, number, number])
  const rc = build(fixture([{ notes: quarters }], { regions: [metered(1, 4, 4), metered(2, 3, 4), metered(3, 4, 4)] }))
  expect(rc.abc).toContain('[M:3/4]')
  expect(rc.abc).toContain('[M:4/4]')
  expect(rc.bars.map((b) => b.endTick - b.startTick)).toEqual([4 * Q, 3 * Q, 4 * Q])
  expect(parse(rc).measures.reduce((a, b) => a + b)).toBe(3)
})

test('a free region is unmetered: [M:none] and back', () => {
  const r = build(fixture([{ notes: run(0, ...Array.from({ length: 12 }, (_, i) => [i, 1] as [number, number])), length: 12 * Q }], { regions: [{ id: 'f', bar: 2, kind: 'free', length: 96000 }, metered(1, 4, 4)] }))
  expect(r.abc).toContain('[M:none]')
  expect(r.abc).toContain('[M:4/4]')
  parse(r)
})

test('tempo and ramps: Q on change, accel./rit. and markers as text above the first voice only', () => {
  const quarters = Array.from({ length: 12 }, (_, i) => [i * Q, Q, 60] as [number, number, number])
  const r = build(fixture([{ notes: quarters }, { notes: quarters }], { regions: [metered(1, 4, 4), metered(2, 4, 4, { bpm: 100, rampTo: 140 }), metered(3, 4, 4, { bpm: 140 })], markers: [{ id: 'm', bar: 2, label: 'B' }] }))
  expect(r.abc).toContain('[Q:1/4=100]"^B""^accel."')
  expect(r.abc.match(/\[Q:/g)!.length).toBe(1)
  expect(r.abc.match(/"\^B"/g)!.length).toBe(1)
  parse(r)
})

test('triplet eighths are written (3:2:3 and parse', () => {
  const r = build(fixture([{ notes: [[0, Q / 3, 60], [Q / 3, Q / 3, 62], [(2 * Q) / 3, Q / 3, 64], [Q, Q, 65], [2 * Q, 2 * Q, 67]] }], { key: 'C' }))
  expect(r.abc).toContain('(3:2:3CDE F2 G4')
  parse(r)
})

test('a looped clip is written out; repeats share the doc note ids', () => {
  const r = build(fixture([{ notes: [[0, Q, 60], [Q, Q, 62]], loop: 2 * Q, length: 8 * Q }]))
  expect(r.bars.length).toBe(2)
  expect(r.abc).toContain('[V:V1] C2 D2 C2 D2 | C2 D2 C2 D2 |]')
  expect(r.ids.map((x) => x.noteIds[0])).toEqual(['n0_0', 'n0_1', 'n0_0', 'n0_1', 'n0_0', 'n0_1', 'n0_0', 'n0_1'])
})

test('a grand staff: a wide part with both hands splits at middle C', () => {
  const notes: [number, number, number][] = [36, 40, 43, 48, 55, 64, 67, 72, 76, 79].map((p, i) => [i * Q, Q, p])
  notes.push([0, Q, 72])
  const r = build(fixture([{ name: 'Piano', notes }]), 1200)
  expect(r.abc).toContain('%%score {V1 V2}')
  expect(r.abc).toContain('V:V1 clef=treble name="Piano"')
  expect(r.abc).toContain('V:V2 clef=bass')
  expect(parse(r).staves).toBe(2)
})

test('a performed (humanized, sloppy) track still parses cleanly', () => {
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  const notes: [number, number, number][] = Array.from({ length: 60 }, (_, i) => [Math.max(0, Math.round((i * Q) / 2 + rnd() * 40)), Math.round(Q / 2 + rnd() * 150), 55 + ((i * 7) % 18)])
  const r = build(fixture([{ notes }, drums]))
  const p = parse(r)
  expect(p.measures).toEqual(r.lines.map((l) => l.last - l.first + 1))
})
