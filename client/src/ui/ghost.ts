// A tempo edit moves MIDI with the bars and leaves audio where it was recorded. To show that plainly, the audio clips that sat on
// a bar or beat line before the edit and no longer do are drawn as ghosts for a moment.
import type { Clip, TimeMap } from '@mobdaw/shared'

/** How long (ms) the ghosts show. */
export const GHOST_MS = 1500
/** A clip start within this many samples of a beat line counts as on it. */
export const ON_LINE = 1

const onBeat = (map: TimeMap, sample: number, tol: number) => {
  const s = map.snapSample(sample, 'beat') // (null inside a free region: no lines there)
  return s != null && Math.abs(s - sample) <= tol
}

/** The ids of the audio clips whose start was on a beat (or bar) line of `before` and is not on one of `after`. */
export function offGrid(before: TimeMap, after: TimeMap, clips: readonly Clip[], tol = ON_LINE): string[] {
  const out: string[] = []
  for (const c of clips) {
    if (c.kind !== 'audio') continue
    if (onBeat(before, c.start, tol) && !onBeat(after, c.start, tol)) out.push(c.id)
  }
  return out
}
