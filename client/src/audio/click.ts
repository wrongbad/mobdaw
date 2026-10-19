// The metronome's events, generated from the project's time map (docs/engine.md §10). Pure: a function of (map, window).
// The click track keeps its two drums (`addClickTrack`: "accent" on key 37, "tick" on key 36); what it plays is not a stored clip.
import type { TimeMap } from '@mobdaw/shared'

/** The click track's drum keys (`addClickTrack` puts the accent and tick lofi drums on these single notes). */
export const CLICK_ACCENT_KEY = 37
export const CLICK_TICK_KEY = 36
/** Velocity of the accent drum on a bar's first beat, and (softer) on the first beat of a later beat group (2+2+3). */
export const CLICK_BAR_VELOCITY = 1
export const CLICK_GROUP_VELOCITY = 0.5

export type ClickEvent = {
  /** Where the hit starts (`TimeMap.bars` rounds it once from the exact tick). */
  sample: number
  /** Project tick of the beat, a stable identity for the event across edits that do not move it. */
  tick: number
  pitch: number
  velocity: number
  /** Note length in samples (a sixteenth of a quarter note at the tempo there); drums ignore it, but the engine wants one. */
  dur: number
}

/**
 * Click hits with `fromSample <= sample < toSample`:
 * - every beat of a metered region has the "tick" drum at velocity 1;
 * - the bar's first beat adds the accent drum at velocity 1 (muting the accent synth leaves a plain click);
 * - the first beat of every later beat group (`groups`, e.g. 3 and 5 of 2+2+3) adds the accent drum at velocity 0.5;
 * - a free region is silent (no beats), and a ramp's beats come from the map, so the click speeds up and slows down with it.
 */
export function clickEvents(map: TimeMap, fromSample: number, toSample: number): ClickEvent[] {
  const out: ClickEvent[] = []
  const len = map.ppq / 4
  const dur = (tick: number, sample: number) => Math.max(1, map.tickToSample(tick + len) - sample)
  for (const line of map.bars(fromSample, toSample, 1e7).lines) {
    if (line.free) continue
    const d = dur(line.tick, line.sample)
    out.push({ sample: line.sample, tick: line.tick, pitch: CLICK_TICK_KEY, velocity: 1, dur: d })
    if (line.isBar) out.push({ sample: line.sample, tick: line.tick, pitch: CLICK_ACCENT_KEY, velocity: CLICK_BAR_VELOCITY, dur: d })
    else if (line.isGroup) out.push({ sample: line.sample, tick: line.tick, pitch: CLICK_ACCENT_KEY, velocity: CLICK_GROUP_VELOCITY, dur: d })
  }
  return out
}
