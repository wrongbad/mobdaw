export const MIN_PPS = 10
export const MAX_PPS = 800
/** The span a short or empty project is shown at: 8 bars of 4/4 at 120 bpm. */
export const MIN_FIT_SEC = 16

/**
 * Pixels per second that fit `endSec` of music (plus `margin` of it on the right) into `viewWidth` css px, the track
 * header excluded. A project shorter than MIN_FIT_SEC (or empty) is fitted as if it were that long. Clamped to the zoom limits.
 */
export function fitPps(endSec: number, viewWidth: number, margin = 0.05): number {
  const span = Math.max(endSec, MIN_FIT_SEC) * (1 + margin)
  const pps = viewWidth / span
  return Math.min(MAX_PPS, Math.max(MIN_PPS, Number.isFinite(pps) ? pps : MIN_PPS))
}
