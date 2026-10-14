import { MAX_PPS, MIN_PPS } from './zoomFit'

/** Beats narrower than this (css px) are too small to edit notes in. */
export const MIN_EDIT_BEAT_PX = 20
/** How much of the visible width an auto-zoomed clip fills. */
export const EDIT_FILL = 0.85

/**
 * The timeline zoom (pixels per second) to edit a clip at, or null when the current one is already comfortable. Only ever
 * zooms in: the clip (`clipSec` long, beats `beatSec` apart) is made to fill most of `viewWidth` (the timeline minus its
 * track headers), but never so wide that a beat falls under MIN_EDIT_BEAT_PX (a long clip then runs past the edge).
 */
export function editZoomPps(pps: number, clipSec: number, beatSec: number, viewWidth: number): number | null {
  if (!(clipSec > 0) || !(beatSec > 0) || !(viewWidth > 0)) return null
  if (pps * beatSec >= MIN_EDIT_BEAT_PX) return null
  const fill = (viewWidth * EDIT_FILL) / clipSec
  const target = Math.min(MAX_PPS, Math.max(MIN_PPS, fill, MIN_EDIT_BEAT_PX / beatSec))
  return target > pps ? target : null
}
