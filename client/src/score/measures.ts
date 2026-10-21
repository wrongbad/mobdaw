// Layer 2a: the project's bars as notation needs them (meter, beat groups, tempo changes, markers), read off the TimeMap.
// Pure.
import type { Marker, TimeMap } from '@mobdaw/shared'

export type Bar = {
  /** 1-based project bar number. */
  bar: number
  startTick: number
  endTick: number
  num: number
  den: number
  /** Beats per group (2+2+3). */
  groups: number[]
  beatTicks: number
  barTicks: number
  /** Unmetered bar: no beats, nominal length. */
  free: boolean
  /** Tempo at the start of the bar's region, quarter notes/min. */
  bpm: number
  /** The meter (or free-ness) differs from the previous bar's; never set on the first bar. */
  meterChanged: boolean
  /** A new tempo starts here; never set on the first bar. */
  tempoChanged: boolean
  /** Tempo moves from this bar on (a ramp region's first bar). */
  ramp?: 'accel.' | 'rit.'
  /** Marker label at this bar. */
  marker?: string
}

export const MAX_BARS = 1000

const meterKey = (m: { free: boolean; num: number; den: number; groups: number[] }) => `${m.free ? 'free' : `${m.num}/${m.den}`}|${m.groups.join('+')}`

/** Bars 1..the one holding `endTick` (at least one, at most `MAX_BARS`). */
export function buildBars(map: TimeMap, endTick: number, markers: readonly Marker[]): Bar[] {
  const last = Math.min(MAX_BARS, Math.max(1, map.position(Math.max(0, endTick - 1)).bar))
  const label = new Map<number, string>()
  for (const m of markers) if (!label.has(m.bar) && m.label) label.set(m.bar, m.label)
  const out: Bar[] = []
  let prevKey = ''
  for (let bar = 1; bar <= last; bar++) {
    const m = map.meterAt(bar)
    const sp = map.spanAtBar(bar)
    const first = bar === sp.startBar
    const key = meterKey(m)
    const tempoChanged = bar > 1 && first && !m.free && Math.abs(sp.bpm0 - map.spanAtBar(bar - 1).bpm1) > 1e-9
    const b: Bar = {
      bar,
      startTick: map.barStart(bar),
      endTick: map.barStart(bar + 1),
      num: m.num,
      den: m.den,
      groups: m.groups,
      beatTicks: m.beatTicks,
      barTicks: m.barTicks,
      free: m.free,
      bpm: m.bpm,
      meterChanged: bar > 1 && key !== prevKey,
      tempoChanged,
    }
    if (first && !m.free && sp.bpm0 !== sp.bpm1) b.ramp = sp.bpm1 > sp.bpm0 ? 'accel.' : 'rit.'
    const mk = label.get(bar)
    if (mk) b.marker = mk
    out.push(b)
    prevKey = key
  }
  return out
}

/** Group boundaries inside a bar as absolute ticks, ascending, including the bar's start and end. */
export function groupBounds(b: Bar): number[] {
  let sizes: number[]
  if (b.free) sizes = [b.barTicks]
  else if (b.den >= 8 || b.groups.length > 1) sizes = b.groups.map((g) => g * b.beatTicks)
  else if (b.num === 4) sizes = [2 * b.beatTicks, 2 * b.beatTicks]
  else if (b.num >= 6 && b.num % 3 === 0) sizes = Array.from({ length: b.num / 3 }, () => 3 * b.beatTicks)
  else sizes = [b.barTicks]
  const out = [b.startTick]
  for (const s of sizes) out.push(Math.min(b.endTick, out[out.length - 1] + s))
  out[out.length - 1] = b.endTick
  return out
}

/** Where a new beam (and, for drums, a new beat) starts: every quarter for den <= 4 and free bars, every group for den >= 8. */
export function beatLines(b: Bar, ppq: number): number[] {
  if (!b.free && b.den >= 8) return groupBounds(b)
  const out: number[] = []
  for (let t = b.startTick; t < b.endTick - 1e-6; t += ppq) out.push(t)
  out.push(b.endTick)
  return out
}
