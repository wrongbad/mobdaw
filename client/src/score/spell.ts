// Layer 2d: key and pitch spelling. The key comes from the project's text ("D minor", "Bb dorian", "Eb") or, failing that, a
// Krumhansl-Schmuckler estimate (port of agent/badmidi/ingest.py `estimate_key`). Pitches are spelled on the line of fifths
// (... Bb F C G D A E B F# ...) at the spot nearest the key. Pure.

export type KeyInfo = { /** Sharps (+) or flats (-) in the signature, -7..7. */ fifths: number; /** Minor-like mode (only breaks spelling ties). */ minor: boolean }

/** Line-of-fifths position of each natural letter. */
const LETTER_FIFTHS: Record<string, number> = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 }
/** Letters in line-of-fifths order starting at F (position -1). */
const FIFTHS_LETTERS = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
const MODES: Record<string, number> = { lydian: 1, major: 0, maj: 0, ionian: 0, mixolydian: -1, dorian: -2, minor: -3, min: -3, m: -3, aeolian: -3, phrygian: -4, locrian: -5 }

/** Key from free text: a tonic (A-G, optional #/b) and an optional mode; null when it is not one. */
export function parseKey(text: string | undefined): KeyInfo | null {
  const m = /^\s*([A-Ga-g])\s*([#b♯♭]?)\s*([A-Za-z]*)\s*$/.exec(text ?? '')
  if (!m) return null
  const mode = m[3].toLowerCase()
  if (mode && !(mode in MODES)) return null
  const off = mode ? MODES[mode] : 0
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0
  const fifths = LETTER_FIFTHS[m[1].toUpperCase()] + 7 * acc + off
  return { fifths: Math.max(-7, Math.min(7, fifths)), minor: off <= -2 }
}

const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']

function correlation(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length
  let num = 0, da = 0, db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  const den = Math.sqrt(da * db)
  return den ? num / den : 0
}

/** The major or minor key whose profile best correlates with a 12-entry (duration-weighted) pitch-class histogram; C major when empty. */
export function estimateKey(weights: readonly number[]): KeyInfo {
  if (!weights.some((w) => w > 0)) return { fifths: 0, minor: false }
  let best = { r: -Infinity, tonic: 0, minor: false }
  for (const minor of [false, true]) {
    for (let tonic = 0; tonic < 12; tonic++) {
      const r = correlation(Array.from({ length: 12 }, (_, i) => weights[(tonic + i) % 12]), minor ? KS_MINOR : KS_MAJOR)
      if (r > best.r) best = { r, tonic, minor }
    }
  }
  return parseKey(`${(best.minor ? MINOR_NAMES : MAJOR_NAMES)[best.tonic]} ${best.minor ? 'minor' : 'major'}`)!
}

export type Spelled = { letter: string; /** -2..2 */ acc: number; /** Scientific octave of the letter (middle C is C4). */ octave: number }

/** The accidental a letter carries in a key signature. */
export function keyAcc(letter: string, fifths: number): number {
  const f = LETTER_FIFTHS[letter]
  // letter at line position f is sharpened when f is within the first `fifths` sharps (F C G D A E B = -1..5), flattened mirrored
  if (fifths > 0 && f <= fifths - 2) return 1
  if (fifths < 0 && f >= fifths + 6) return -1
  return 0
}

/** Spell a MIDI pitch: the line-of-fifths position nearest the key's centre (fifths + 2); ties go sharp in minor, flat in major. */
export function spellPitch(pitch: number, key: KeyInfo): Spelled {
  const pc = ((pitch % 12) + 12) % 12
  const base = (7 * pc) % 12 // position mod 12 on the line of fifths
  const centre = key.fifths + 2
  let f = base + 12 * Math.round((centre - base) / 12)
  if (!key.minor && f - centre === 6) f -= 12 // a tie: Math.round went sharp
  const idx = (((f + 1) % 7) + 7) % 7
  const acc = Math.floor((f + 1) / 7)
  const octave = Math.floor((pitch - acc) / 12) - 1
  return { letter: FIFTHS_LETTERS[idx], acc, octave }
}

const ACC_TEXT: Record<number, string> = { [-2]: '__', [-1]: '_', 0: '=', 1: '^', 2: '^^' }

/**
 * The ABC accidental to print before a note, given what is in force at that letter and octave in this bar (`state`, starting empty
 * each bar; the key signature fills in the rest). A tied-over continuation prints none and leaves the state alone.
 */
export function accidentalFor(s: Spelled, fifths: number, state: Map<string, number>, cont: boolean): string {
  if (cont) return ''
  const k = s.letter + s.octave
  const now = state.get(k) ?? keyAcc(s.letter, fifths)
  if (now === s.acc) return ''
  state.set(k, s.acc)
  return ACC_TEXT[s.acc]
}

/** ABC pitch letters for a spelled note: C4 is `C`, C5 `c`, C6 `c'`, C3 `C,`. */
export function abcLetter(s: Spelled): string {
  if (s.octave >= 5) return s.letter.toLowerCase() + "'".repeat(s.octave - 5)
  return s.letter + ','.repeat(4 - s.octave)
}

const KEY_NAMES = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']
/** The major key name for a signature of `fifths` sharps (+) or flats (-). */
export const keyName = (fifths: number) => KEY_NAMES[Math.max(-7, Math.min(7, fifths)) + 7]

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const ACC_VALUE: Record<string, number> = { '': 0, '#': 1, b: -1, '##': 2, x: 2, bb: -2 }

/**
 * A written spelling ('F#4', 'Bb3', 'E#5', 'Cbb4'; the octave is the letter's, so 'B#3' is middle C) as a `Spelled`, or undefined when
 * it is not one or does not name `pitch` (a hint that disagrees with its note is not trusted).
 */
export function parseSpell(text: string | undefined, pitch: number): Spelled | undefined {
  const m = /^([A-G])(bb|##|b|#|x)?(-?\d+)$/.exec(text ?? '')
  if (!m) return undefined
  const acc = ACC_VALUE[m[2] ?? '']
  const octave = Number(m[3])
  if (12 * (octave + 1) + LETTER_PC[m[1]] + acc !== pitch) return undefined
  return { letter: m[1], acc, octave }
}
