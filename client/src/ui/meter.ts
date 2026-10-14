// Level meter maths for the track gain sliders: a linear peak from the engine -> a 0..1 fill on a dB scale, and the
// ballistics (instant attack, slow release) that smooth the ~30 Hz reports into the frames drawn.
export const MIN_DB = -60 // an empty meter
export const MAX_DB = 6 // a full one (a gain of 2)
export const RELEASE = 0.7 // fill per second the bar falls by: from full scale to silence in about 1.4 s

/** A linear peak (1 = full scale) as the bar's fill, 0..1. */
export function peakToFill(peak: number): number {
  if (!(peak > 0)) return 0
  const db = 20 * Math.log10(peak)
  return Math.min(1, Math.max(0, (db - MIN_DB) / (MAX_DB - MIN_DB)))
}

/** The fill shown after `dtMs` more time, heading for `target`: it jumps up, and falls at `RELEASE`. */
export function follow(shown: number, target: number, dtMs: number): number {
  return target >= shown ? target : Math.max(target, shown - (RELEASE * dtMs) / 1000)
}
