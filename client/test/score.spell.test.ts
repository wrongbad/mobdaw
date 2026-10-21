import { expect, test } from 'vitest'
import { abcLetter, accidentalFor, estimateKey, keyName, parseKey, parseSpell, spellPitch } from '../src/score/spell'
import { chooseClef } from '../src/score/staves'

const sp = (pitch: number, key: string) => {
  const s = spellPitch(pitch, parseKey(key)!)
  return `${s.letter}${['bb', 'b', '', '#', '##'][s.acc + 2]}${s.octave}`
}

test('keys from text', () => {
  const f = (t: string) => parseKey(t)?.fifths
  expect([f('D minor'), f('F# major'), f('Bb dorian'), f('Eb'), f('C'), f('A minor'), f('E lydian'), f('Am'), f('G mixolydian'), f('B locrian')]).toEqual([-1, 6, -4, -3, 0, 0, 5, 0, 0, 0])
  expect(parseKey('nonsense')).toBeNull()
  expect(parseKey('')).toBeNull()
  expect(parseKey(undefined)).toBeNull()
  expect(parseKey('G# major')!.fifths).toBe(7) // clamped
  expect(keyName(-3)).toBe('Eb')
  expect(keyName(7)).toBe('C#')
})

test('pitches are spelled for the key', () => {
  expect(sp(70, 'D minor')).toBe('Bb4') // Bb in D minor
  expect(sp(61, 'D minor')).toBe('C#4') // C# (raised leading tone) beats Db
  expect(sp(63, 'Eb')).toBe('Eb4')
  expect(sp(61, 'Eb')).toBe('Db4')
  expect(sp(66, 'D major')).toBe('F#4')
  expect(sp(60, 'C')).toBe('C4')
  expect(sp(59, 'C')).toBe('B3')
})

test('a spelling tie goes flat in major and sharp in minor', () => {
  expect(sp(68, 'C major')).toBe('Ab4') // G# and Ab are equally far from C major's centre
  expect(sp(68, 'A minor')).toBe('G#4')
  expect(sp(66, 'C major')).toBe('F#4') // no tie: the sharp side is nearer
  expect(sp(61, 'G major')).toBe('C#4')
})

test('accidentals follow the bar: once per letter+octave, natural to cancel, none on a tied continuation', () => {
  const st = new Map<string, number>()
  const fs = (pitch: number, cont = false) => accidentalFor(spellPitch(pitch, parseKey('C')!), 0, st, cont)
  expect([fs(66), fs(66), fs(78), fs(65), fs(66, true), fs(66)]).toEqual(['^', '', '^', '=', '', '^'])
  // key signature: F# in D major needs none, F natural does
  const st2 = new Map<string, number>()
  const d = parseKey('D')!
  expect(accidentalFor(spellPitch(66, d), d.fifths, st2, false)).toBe('')
  expect(accidentalFor(spellPitch(65, d), d.fifths, st2, false)).toBe('=')
})

test('ABC letters by octave', () => {
  const l = (p: number) => abcLetter(spellPitch(p, parseKey('C')!))
  expect([l(60), l(72), l(84), l(48), l(36)]).toEqual(['C', 'c', "c'", 'C,', 'C,,'])
})

test('key estimate: a D minor line, a major scale, nothing', () => {
  const w = new Array(12).fill(0)
  for (const pc of [2, 4, 5, 7, 9, 10, 1]) w[pc] += 1
  w[2] += 3
  w[9] += 2
  expect(estimateKey(w).fifths).toBe(-1)
  const maj = new Array(12).fill(0)
  for (const pc of [7, 9, 11, 0, 2, 4, 6]) maj[pc] += 1
  maj[7] += 3
  maj[2] += 2
  expect(estimateKey(maj)).toEqual({ fifths: 1, minor: false })
  expect(estimateKey(new Array(12).fill(0))).toEqual({ fifths: 0, minor: false })
})

test('clef: treble or bass by median, grand staff for a wide part with both hands', () => {
  expect(chooseClef([60, 64, 67, 72])).toBe('treble')
  expect(chooseClef([40, 45, 50, 52])).toBe('bass')
  expect(chooseClef([])).toBe('treble')
  expect(chooseClef([36, 40, 43, 48, 55, 64, 67, 72, 76, 79])).toBe('grand')
  expect(chooseClef([36, 40, 43, 48, 52, 55])).toBe('bass') // wide, but nothing above 63
  expect(chooseClef([58, 60, 62, 65, 70, 76, 81, 86])).toBe('treble') // wide but nothing at or below 55
})

test('parseSpell: written spellings, trusted only when they name the pitch', () => {
  expect(parseSpell('F#4', 66)).toEqual({ letter: 'F', acc: 1, octave: 4 })
  expect(parseSpell('Bb3', 58)).toEqual({ letter: 'B', acc: -1, octave: 3 })
  expect(parseSpell('B#3', 60)).toEqual({ letter: 'B', acc: 1, octave: 3 })
  expect(parseSpell('Cbb4', 58)).toEqual({ letter: 'C', acc: -2, octave: 4 })
  expect(parseSpell('Fx4', 67)).toEqual({ letter: 'F', acc: 2, octave: 4 })
  expect(parseSpell('F#4', 67)).toBeUndefined() // not that pitch
  expect(parseSpell('H4', 60)).toBeUndefined()
  expect(parseSpell(undefined, 60)).toBeUndefined()
})
