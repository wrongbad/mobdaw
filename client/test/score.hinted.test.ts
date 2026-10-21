import ABCJS from 'abcjs'
import { expect, test } from 'vitest'
import { buildScore, type BuiltScore, type ScoreInput } from '../src/score'
import type { Note } from '@mobdaw/shared'
import { flattenTrack } from '../src/score/flatten'
import { fixture, hinted, metered, Q, type FixTrack, type HN } from './scoreFixture'

const build = (inp: ScoreInput, width = 1400) => buildScore(inp, { show: new Set(inp.tracks.map((t) => t.id)), width })
const voice = (r: BuiltScore, n: number) => r.abc.split('\n').find((l) => l.startsWith(`[V:V${n}]`))!

/** No abcjs warnings; returns the tune. */
function parse(r: BuiltScore) {
  const tune = ABCJS.parseOnly(r.abc)[0]
  expect(tune.warnings).toBeUndefined()
  return tune
}

/** Bar 57 of badmidi's woven chaconne (3/4, E minor), hand-built from agent/examples/woven_chaconne.py's MusicXML: violin 1 quintuplet sixteenths (5:4),
 * violin 2 plain sixteenths, viola triplet eighths, cello two dotted quarters an octave apart; accents on the group starts. */
const bar57 = (): FixTrack[] => {
  const grp = (k: number, n: number) => ({ n, of: n === 5 ? 4 : 2, start: Math.floor(k / n), span: 1 })
  const P1 = [83, 88, 91, 95, 100, 95, 91, 88, 91, 95, 83, 88, 91, 95, 100]
  const P2 = [76, 79, 83, 79, 71, 76, 79, 76, 76, 79, 83, 79]
  const P3 = [59, 64, 67, 64, 59, 55, 59, 64, 67]
  return [
    { name: 'violin 1', ...hinted(P1.map((pitch, k): HN => ({ on: [k, 5], len: [1, 5], pitch, tup: grp(k, 5), ...(k % 5 === 0 ? { art: '>' } : {}) }))) },
    { name: 'violin 2', ...hinted(P2.map((pitch, k): HN => ({ on: k / 4, len: 0.25, pitch, ...(k % 4 === 0 ? { art: '>' } : {}) }))) },
    { name: 'viola', clefs: ['alto'], ...hinted(P3.map((pitch, k): HN => ({ on: [k, 3], len: [1, 3], pitch, tup: grp(k, 3), ...(k % 3 === 0 ? { art: '>' } : {}) }))) },
    { name: 'cello', clefs: ['bass'], ...hinted([{ on: 0, len: 1.5, pitch: 52, art: '>' }, { on: 1.5, len: 1.5, pitch: 64, segs: [1.5] }]) },
  ]
}

/** Hinted track with one clip at `start`, in `regions`. */
const one = (t: FixTrack, o: { regions?: Parameters<typeof fixture>[1] extends infer X ? (X extends { regions?: infer R } ? R : never) : never; key?: string } = {}) => build(fixture([t], { regions: o.regions ?? [metered(1, 3, 4)], key: o.key ?? 'C' }))

test('staleness: a hint is fresh only while tick, length and pitch are what it recorded', () => {
  const t: FixTrack = { ...hinted([{ on: 0, len: 1, pitch: 60 }, { on: 1, len: 2, pitch: 62 }]) }
  const f = (inp: ScoreInput) => flattenTrack(inp.tracks[0], false, inp).uncut.map((n) => !!n.fresh)
  expect(f(fixture([t]))).toEqual([true, true])
  for (const edit of [(n: Note) => (n.tick += 10), (n: Note) => (n.durTicks -= 1), (n: Note) => (n.pitch += 1)]) {
    const inp = fixture([t])
    edit(inp.notes[1])
    expect(f(inp)).toEqual([true, false])
  }
  // loop repeats never use hints
  const looped = fixture([{ ...hinted([{ on: 0, len: 1, pitch: 60 }, { on: 1, len: 2, pitch: 62 }]), loop: 3 * Q, length: 6 * Q }])
  expect(flattenTrack(looped.tracks[0], false, looped).uncut.map((n) => [n.repeat, !!n.fresh])).toEqual([[0, true], [0, true], [1, false], [1, false]])
})

test('a hinted bar is written as notated, not as guessed', () => {
  // a dotted quarter, an eighth and a quarter in 3/4 performed all over the place: the hint wins
  const t: FixTrack = { ...hinted([{ on: 0, len: 1.5, pitch: 60, perf: [5, 1300] }, { on: 1.5, len: 0.5, pitch: 62, perf: [1500, 200] }, { on: 2, len: 1, pitch: 64, perf: [1900, 700] }]) }
  expect(voice(one(t), 1)).toBe('[V:V1] C3D E2 |]')
})

test('two voices on one staff: ( V V ) with stems up and down, voice 2 rests visible only between its notes', () => {
  const t: FixTrack = {
    ...hinted([
      { on: 0, len: 1, pitch: 72 }, { on: 1, len: 1, pitch: 74 }, { on: 2, len: 1, pitch: 76 }, { on: 3, len: 1, pitch: 77 },
      { on: 0, len: 2, pitch: 67, voice: 2 }, { on: 3, len: 1, pitch: 65, voice: 2 },
      { on: 4, len: 4, pitch: 72 }, // bar 2: voice 2 has nothing
    ]),
    name: 'Piano', clefs: ['treble', 'bass'],
  }
  const r = one(t, { regions: [metered(1, 4, 4)] })
  expect(r.abc).toContain('%%score {(V1 V2) V3}')
  expect(r.abc).toContain('V:V1 clef=treble name="Piano" stem=up')
  expect(r.abc).toContain('V:V2 clef=treble stem=down')
  expect(r.abc).toContain('V:V3 clef=bass')
  expect(voice(r, 1)).toBe('[V:V1] c2 d2 e2 f2 | c8 |]')
  expect(voice(r, 2)).toBe('[V:V2] G4 z2 F2 | x8 |]')
  expect(voice(r, 3)).toBe('[V:V3] z8 | z8 |]') // staff 2 has no notes: a visible whole rest
  const tune = parse(r)
  const sys = tune.lines.find((l: { staff?: unknown }) => l.staff) as { staff: unknown[] }
  expect(sys.staff).toHaveLength(2)
})

test('a 5:4 quintuplet of sixteenths in 3/4 is (5:4:5 over five written sixteenths', () => {
  const t: FixTrack = {
    ...hinted([
      ...[60, 62, 64, 65, 67].map((pitch, k): HN => ({ on: [k, 5], len: [1, 5], pitch, tup: { n: 5, of: 4, start: 0, span: 1 } })),
      { on: 1, len: 2, pitch: 72 },
    ]),
  }
  const r = one(t)
  expect(voice(r, 1)).toBe('[V:V1] (5:4:5C/2D/2E/2F/2G/2 c4 |]')
  const tune = parse(r)
  const notes = (tune.lines[0] as any).staff[0].voices[0].filter((e: any) => e.el_type === 'note')
  expect(notes[0].startTriplet).toBe(5)
  expect(notes.slice(0, 5).map((n: any) => n.duration)).toEqual(Array(5).fill(1 / 16)) // written as sixteenths
})

test('a 3:2 triplet with a rest inside writes the rest at the group ratio', () => {
  const tr = { n: 3, of: 2, start: 0, span: 1 }
  const t: FixTrack = {
    ...hinted([{ on: 0, len: [1, 3], pitch: 60, tup: tr }, { on: [2, 3], len: [1, 3], pitch: 64, tup: tr }, { on: 1, len: 2, pitch: 67 }]),
  }
  const r = one(t)
  expect(voice(r, 1)).toBe('[V:V1] (3:2:3CzE G4 |]')
  parse(r)
  // a rest at the end of the group, and the first note of the group tied over its middle (a quarter in triplet time)
  const t2: FixTrack = { ...hinted([{ on: 0, len: [2, 3], pitch: 60, tup: tr, segs: [[2, 3]] }, { on: 1, len: 2, pitch: 67 }]) }
  expect(voice(one(t2), 1)).toBe('[V:V1] (3:2:2C2z G4 |]')
})

test('a dotted quarter at beat 1.5 of a 3/4 hemiola is one dotted quarter, with or without segs', () => {
  const notes = (segs: boolean): HN[] => [{ on: 0, len: 1.5, pitch: 60, ...(segs ? { segs: [1.5] } : {}) }, { on: 1.5, len: 1.5, pitch: 62, ...(segs ? { segs: [1.5] } : {}) }]
  expect(voice(one({ ...hinted(notes(true)) }), 1)).toBe('[V:V1] C3D3 |]')
  expect(voice(one({ ...hinted(notes(false)) }), 1)).toBe('[V:V1] C3D3 |]') // no tie: one notatable value inside the bar
  // not notatable as one value (5/4 of a quarter), or across a bar line: the splitting rules
  expect(voice(one({ ...hinted([{ on: 0, len: 1.25, pitch: 60 }, { on: 1.25, len: 1.75, pitch: 62 }]) }), 1)).toBe('[V:V1] C2- C/2D7/2 |]') // (a double-dotted quarter is one value)
})

test('segs written verbatim and tied; a seg that crosses a bar line falls back to the splitting rules', () => {
  // a quarter + a half tied (notated as such) in 3/4
  const t: FixTrack = { ...hinted([{ on: 0, len: 3, pitch: 60, segs: [1, 2] }]) }
  expect(voice(one(t), 1)).toBe('[V:V1] C2- C4 |]')
  // 7 quarters over two bars, segs [3, 3, 1] stay; segs [4, 3] cross the bar line and are cut
  const ok: FixTrack = { ...hinted([{ on: 0, len: 6, pitch: 60, segs: [3, 3] }]) }
  expect(voice(one(ok), 1)).toBe('[V:V1] C6- | C6 |]')
  const bad: FixTrack = { ...hinted([{ on: 0, len: 6, pitch: 60, segs: [4, 2] }]) }
  expect(voice(one(bad), 1)).toBe('[V:V1] C6- | C6 |]')
})

test('spelling: the hint decides (Db not C#), accidentals follow the per-bar state, B#3 is middle C written on B', () => {
  const t: FixTrack = {
    ...hinted([
      { on: 0, len: 0.5, pitch: 61, spell: 'Db4' }, { on: 0.5, len: 0.5, pitch: 61, spell: 'Db4' }, { on: 1, len: 0.5, pitch: 61, spell: 'C#4' },
      { on: 1.5, len: 0.5, pitch: 60, spell: 'B#3' }, { on: 2, len: 0.5, pitch: 66, spell: 'F#4' }, { on: 2.5, len: 0.5, pitch: 66, spell: 'Gb4' },
      { on: 3, len: 1, pitch: 63, spell: 'Fb4' }, // not what 63 is: ignored, the key decides
    ]),
  }
  const r = one(t, { regions: [metered(1, 4, 4)] })
  expect(voice(r, 1)).toBe('[V:V1] _DD ^C^B, ^F_G _E2 |]')
})

test('articulations: staccato, accent, marcato and tenuto go before the note or chord', () => {
  const t: FixTrack = {
    ...hinted([
      { on: 0, len: 1, pitch: 60, art: "'" }, { on: 1, len: 1, pitch: 62, art: '>' }, { on: 2, len: 1, pitch: 64, art: '^' },
      { on: 3, len: 1, pitch: 60, art: '_' }, { on: 3, len: 1, pitch: 67, art: '_' }, { on: 4, len: 2, pitch: 65, art: ">'", segs: [1, 1] }, { on: 6, len: 2, pitch: 67 },
    ]),
  }
  const r = one(t, { regions: [metered(1, 4, 4)] })
  expect(voice(r, 1)).toBe('[V:V1] .C2 !>!D2 !marcato!E2 !tenuto![CG]2 | .!>!F2- F2 G4 |]')
  parse(r)
})

test('a viola with clefs [alto] is written on an alto clef whether or not its bars are hinted', () => {
  const guessed: FixTrack = { name: 'Viola', clefs: ['alto'], notes: [[0, Q, 60], [Q, Q, 62], [2 * Q, 2 * Q, 64]] }
  const r = one(guessed, { regions: [metered(1, 4, 4)] })
  expect(r.abc).toContain('V:V1 clef=alto name="Viola"')
  expect(voice(r, 1)).toBe('[V:V1] C2 D2 E4 |]')
  const h: FixTrack = { name: 'Viola', clefs: ['alto'], ...hinted([{ on: 0, len: 1, pitch: 60 }, { on: 1, len: 1, pitch: 62 }, { on: 2, len: 2, pitch: 64 }]) }
  const r2 = one(h, { regions: [metered(1, 4, 4)] })
  expect(r2.abc).toContain('V:V1 clef=alto')
  const staff = (parse(r2).lines[0] as any).staff[0]
  expect(staff.clef.type).toBe('alto')
})

const POS = { treble: ['treble', 0], bass: ['bass', -12], alto: ['alto', -6], tenor: ['alto', -8], treble_8: ['treble-8', 0], bass_8: ['bass-8', -12] } // (abcjs reads the tenor clef as a C clef on the fourth line)

test('every clef is spelled the way abcjs reads it', () => {
  for (const [clef, abcjs] of [['treble', 'treble'], ['bass', 'bass'], ['alto', 'alto'], ['tenor', 'tenor'], ['treble_8', 'treble-8'], ['bass_8', 'bass-8']] as const) {
    const r = one({ clefs: [clef], notes: [[0, 3 * Q, 60]] })
    expect(r.abc).toContain(`clef=${abcjs}`)
    const c = (parse(r).lines[0] as any).staff[0].clef
    expect([c.type, c.verticalPos]).toEqual(POS[clef])
  }
})

test('one bar hinted, the next has an edited note: the first is drawn from hints, the second guessed', () => {
  const inp = fixture([{ ...hinted([{ on: 0, len: 1.5, pitch: 60 }, { on: 1.5, len: 1.5, pitch: 62, segs: [1.5] }, { on: 3, len: 1.5, pitch: 64 }, { on: 4.5, len: 1.5, pitch: 65, segs: [1.5] }]) }], { regions: [metered(1, 3, 4)] })
  expect(voice(build(inp), 1)).toBe('[V:V1] C3D3 | E3F3 |]') // all fresh
  inp.notes[3].pitch = 69 // edited in the piano roll: bar 2 sounds a stale note
  // (bar 1 keeps its dotted quarters at 1.5, which the guesser would split at the beat)
  expect(voice(build(inp), 1)).toBe('[V:V1] C3D3 | E3A- A2 |]') // bar 1 as written, bar 2 guessed (split at the beat)
})

test('a clip that starts off the quarter grid still places hinted notes at clip start + on', () => {
  const t: FixTrack = { start: Q / 2, ...hinted([{ on: 0, len: 1, pitch: 60 }, { on: 1, len: [3, 2], pitch: 62 }, { on: [5, 2], len: 0.5, pitch: 64 }]), length: 3 * Q }
  expect(voice(one(t, { regions: [metered(1, 4, 4)] }), 1)).toBe('[V:V1] zC2D3 Ez |]')
  // the written pieces are used as they are
  const w: FixTrack = { ...t, ...hinted([{ on: 0, len: 1, pitch: 60, segs: [1] }, { on: 1, len: [3, 2], pitch: 62, segs: [[3, 2]] }, { on: [5, 2], len: 0.5, pitch: 64 }]) }
  expect(voice(one({ ...w, start: Q / 2, length: 3 * Q }, { regions: [metered(1, 4, 4)] }), 1)).toBe('[V:V1] zC2D3 Ez |]')
})

test('woven chaconne bar 57: quintuplets, sixteenths, triplets and dotted quarters, as written', () => {
  const inp = fixture(bar57(), { regions: [metered(1, 3, 4)], key: 'E minor' })
  const r = build(inp)
  expect(r.abc.split('\n').slice(4).join('\n')).toBe(`%%score [ V1 V2 V3 V4 ]
V:V1 clef=treble name="violin 1"
K:G
V:V2 clef=treble name="violin 2"
K:G
V:V3 clef=alto name="viola"
K:G
V:V4 clef=bass name="cello"
K:G
[V:V1] (5:4:5!>!b/2e'/2g'/2b'/2e''/2 (5:4:5!>!b'/2g'/2e'/2g'/2b'/2 (5:4:5!>!b/2e'/2g'/2b'/2e''/2 |]
[V:V2] !>!e/2g/2b/2g/2 !>!B/2e/2g/2e/2 !>!e/2g/2b/2g/2 |]
[V:V3] (3:2:3!>!B,EG (3:2:3!>!EB,G, (3:2:3!>!B,EG |]
[V:V4] !>!E,3E3 |]
`)
  expect(r.ids.slice(0, 2).map((x) => [r.abc.slice(x.start, x.end), x.noteIds])).toEqual([['!>!b/2', ['n0_0']], ['e\'/2', ['n0_1']]])
  parse(r)
})

test('the guesser would draw bar 57 differently: quintuplets are not guessed, hints are what make them (5:4:5', () => {
  const plain = fixture(bar57().map((t) => ({ name: t.name, notes: t.notes })), { regions: [metered(1, 3, 4)], key: 'E minor' })
  expect(voice(build(plain), 1)).not.toContain('(5:4:5')
})

test('a guessed bar of a multi-staff track: each note on the staff its fresh hint names, else split at middle C', () => {
  const t: FixTrack = {
    name: 'Piano', clefs: ['treble', 'bass'],
    ...hinted([{ on: 0, len: 1, pitch: 72, staff: 2 }, { on: 1, len: 1, pitch: 48, staff: 1 }, { on: 2, len: 1, pitch: 72 }, { on: 3, len: 1, pitch: 48 }]),
  }
  const inp = fixture([t], { regions: [metered(1, 4, 4)] })
  inp.notes[3].pitch = 50 // stale: the bar is guessed
  const r = build(inp)
  expect(voice(r, 1)).toBe('[V:V1] z2 C,2 c2 z2 |]')
  expect(voice(r, 2)).toBe('[V:V2] c2 z2 z2 D,2 |]')
  parse(r)
})

test('a looped clip: the first pass is hinted, the repeats are guessed', () => {
  const inp = fixture([{ ...hinted([{ on: 0, len: 1.5, pitch: 60, segs: [1.5] }, { on: 1.5, len: 1.5, pitch: 62, segs: [1.5] }]), loop: 3 * Q, length: 6 * Q }], { regions: [metered(1, 3, 4)] })
  expect(voice(build(inp), 1)).toBe('[V:V1] C3D3 | C3D- D2 |]')
})

test('a long hinted passage with voices, tuplets, ties, rests and clefs parses without warnings and fills every bar', () => {
  const tr = { n: 3, of: 2, start: 4, span: 1 }
  const t: FixTrack = {
    name: 'Organ', clefs: ['treble', 'bass', 'bass'],
    ...hinted([
      { on: 0, len: 1, pitch: 72 }, { on: 1, len: 1, pitch: 71, spell: 'Cb5' }, { on: 2, len: 2, pitch: 72, art: '_' },
      { on: 0, len: 2, pitch: 64, voice: 2 }, { on: 2, len: 2, pitch: 60, voice: 2 },
      { on: 4, len: [1, 3], pitch: 72, tup: tr }, { on: [13, 3], len: [1, 3], pitch: 74, tup: tr }, { on: [14, 3], len: [1, 3], pitch: 76, tup: tr, art: "'" },
      { on: 5, len: 3, pitch: 77, segs: [1, 2] },
      { on: 0, len: 4, pitch: 48, staff: 2 }, { on: 4, len: 4, pitch: 43, staff: 2 },
      { on: 0, len: 8, pitch: 36, staff: 3 },
    ]),
  }
  const r = one(t, { regions: [metered(1, 4, 4)] })
  const tune = parse(r)
  expect(r.bars).toHaveLength(2)
  const sys = tune.lines.find((l: { staff?: unknown }) => l.staff) as { staff: { voices: { el_type: string }[][] }[] }
  expect(sys.staff).toHaveLength(3)
  expect(sys.staff.map((s) => s.voices.length)).toEqual([2, 1, 1])
  expect(r.abc).toContain('%%score {(V1 V2) V3 V4}')
})


test('a voice that exists only in hinted bars is an invisible whole-bar rest in a guessed bar', () => {
  const t: FixTrack = { ...hinted([{ on: 0, len: 4, pitch: 72 }, { on: 0, len: 4, pitch: 64, voice: 2 }, { on: 4, len: 4, pitch: 72 }]) }
  const inp = fixture([t], { regions: [metered(1, 4, 4)] })
  inp.notes[2].durTicks -= 10 // bar 2 is stale
  const r = build(inp)
  expect(voice(r, 1)).toBe('[V:V1] c8 | c8 |]')
  expect(voice(r, 2)).toBe('[V:V2] E8 | x8 |]')
  parse(r)
})
