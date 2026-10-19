// Snapping to the project's bar grid (the shared timeline, docs/engine.md §2): which subdivision to snap to at a zoom, and the
// helpers the gestures use. In a free region there is no grid: every helper says so (null / the position unchanged), and the
// callers keep today's behaviour there (clip edges).
import type { SnapDivision, TimeMap } from '@mobdaw/shared'

/** Beats narrower than this many css px snap to whole bars; narrower than `BEAT_PX`, to beats; and so on up to quarter-beats. */
export const BAR_PX = 8
export const BEAT_PX = 28
export const HALF_PX = 56

/**
 * The finest subdivision worth snapping to when one beat is `pxPerBeat` wide: bars when the beats are tiny, beats, then half beats
 * (8ths in 4/4), then quarter beats (16ths in 4/4). A coarser grid keeps a drag from jittering between lines a few pixels apart.
 */
export function snapDivision(pxPerBeat: number): SnapDivision {
  if (!(pxPerBeat >= BAR_PX)) return 'bar'
  if (pxPerBeat < BEAT_PX) return 'beat'
  return pxPerBeat < HALF_PX ? 2 : 4
}

/** Width of one beat in css px where `sample` is (Infinity in a free region, which has no beats). */
export function pxPerBeatAt(map: TimeMap, sample: number, pps: number): number {
  const sp = map.spanAtSample(sample)
  if (sp.region.kind === 'free') return Infinity
  const bt = map.meterAt(sp.startBar).beatTicks
  const t = Math.min(Math.max(map.sampleToTick(sample), sp.startTick), sp.endTick - bt)
  return ((map.tickToSampleExact(t + bt) - map.tickToSampleExact(t)) / map.sampleRate) * pps
}

/** The division to snap to at `sample` at zoom `pps` (null in a free region). */
export function divisionAt(map: TimeMap, sample: number, pps: number): SnapDivision | null {
  const px = pxPerBeatAt(map, sample, pps)
  return px === Infinity ? null : snapDivision(px)
}

/** `sample` moved to the nearest grid line of the zoom, or null when it is inside a free region. */
export function gridSnap(map: TimeMap, sample: number, pps: number): number | null {
  const d = divisionAt(map, sample, pps)
  return d == null ? null : map.snapSample(sample, d)
}

/** The same in ticks. */
export function gridSnapTick(map: TimeMap, tick: number, pps: number): number | null {
  const d = divisionAt(map, map.tickToSampleExact(tick), pps)
  return d == null ? null : map.snapTick(tick, d)
}

/**
 * Soft grid snap for a block being dragged: whichever of `edges` (samples, e.g. a clip's start and end) lies closest to a grid
 * line within `tol` samples jumps onto it. Returns the shift to apply and the line it landed on, or null (none close, or in a
 * free region).
 */
export function softGrid(map: TimeMap, edges: number[], pps: number, tol: number): { shift: number; at: number } | null {
  let best: { shift: number; at: number } | null = null
  for (const e of edges) {
    const g = gridSnap(map, e, pps)
    if (g == null) continue
    const gap = Math.abs(g - e)
    if (gap <= tol && (!best || gap < Math.abs(best.shift))) best = { shift: g - e, at: g }
  }
  return best
}
