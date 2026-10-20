// MIDI pitch <-> note name, the piano roll's way: 60 is c4, so 36 is c2 and 0 is c-1.
const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
const SEMITONE: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

export const noteName = (pitch: number) => `${NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`

/** A pitch from a note name (`c2`, `F#3`, `db1`) or a plain number, or null when it isn't one or is outside 0..127. */
export function parseNote(text: string): number | null {
  const t = text.trim().toLowerCase()
  const m = /^([a-g])([#b]?)(-?\d+)$/.exec(t)
  let p: number
  if (m) p = (Number(m[3]) + 1) * 12 + SEMITONE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)
  else if (/^\d+$/.test(t)) p = Number(t)
  else return null
  return p >= 0 && p <= 127 ? p : null
}
