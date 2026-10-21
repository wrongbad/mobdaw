// Layer 2e: which staff (or staves) a pitched track is written on. Pure.

export type ClefChoice = 'treble' | 'bass' | 'grand'
/** A grand staff's fixed split: this pitch and up go to the upper staff. */
export const GRAND_SPLIT = 60

/** Grand staff for a part that spans more than two octaves (5th-95th percentile) with notes well into both hands; else by median. */
export function chooseClef(pitches: readonly number[]): ClefChoice {
  if (!pitches.length) return 'treble'
  const s = [...pitches].sort((a, b) => a - b)
  const at = (p: number) => s[Math.floor(p * (s.length - 1))]
  if (at(0.95) - at(0.05) > 24 && s[s.length - 1] >= 64 && s[0] <= 55) return 'grand'
  return s[Math.floor(s.length / 2)] >= 60 ? 'treble' : 'bass'
}
