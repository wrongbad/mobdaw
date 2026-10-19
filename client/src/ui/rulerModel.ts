// What the main ruler draws, as plain data computed from the time map: bar lines and beats in metered regions, seconds in free
// ones, a badge where the tempo or meter changes, and the markers. No DOM here (ruler.tsx renders it).
import type { Marker, Region, TimeMap } from '@mobdaw/shared'
import { regionEnd } from '@mobdaw/shared'

/** Beat lines closer than this (css px) to the line before are left out. */
export const MIN_BEAT_PX = 6
/** A bar number needs about this much room (css px). */
export const LABEL_PX = 40

const trimNum = (v: number, digits = 2) => String(+v.toFixed(digits))
export const fmtBpm = (bpm: number) => trimNum(bpm)

/** "7/8", or "7/8 2+2+3" when the beats are grouped other than by default. */
export function meterLabel(r: Extract<Region, { kind: 'metered' }>, defaults?: number[]): string {
  const base = `${r.num}/${r.den}`
  if (!r.groups || !r.groups.length) return base
  if (defaults && defaults.length === r.groups.length && defaults.every((g, i) => g === r.groups![i])) return base
  return `${base} ${r.groups.join('+')}`
}

/** Seconds for a free region's length: "3.5s", "1:05". */
export function fmtFree(samples: number, rate: number): string {
  const s = samples / rate
  if (s < 60) return `${trimNum(s, 1)}s`
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
}

/** The text of a region's change badge: "♩=92 7/8", "♩=120→92 4/4" for a ramp, "free 3.5s". */
export function regionLabel(r: Region, rate: number, defaults?: number[]): string {
  if (r.kind === 'free') return `free ${fmtFree(r.length, rate)}`
  const ramp = r.rampTo != null && r.rampTo !== r.bpm ? `→${fmtBpm(r.rampTo)}` : ''
  return `♩=${fmtBpm(r.bpm)}${ramp} ${meterLabel(r, defaults)}`
}

export type RulerLine = {
  sample: number
  bar: number
  /** 'bar' lines, the first beat of a group, any other beat. */
  kind: 'bar' | 'group' | 'beat'
  /** The bar number to print at a bar line (thinned out by zoom). */
  label?: string
  free: boolean
}
export type RulerTick = { sample: number; label: string }
export type RulerFree = { fromSample: number; toSample: number; ticks: RulerTick[] }

/** The bar-number step for the narrowest bar on screen: 1, 2, 4, 8, ... so that numbers don't collide. Labels sit on bars 1, 1+step, ... */
export function labelStep(minBarPx: number): number {
  let step = 1
  while (step * minBarPx < LABEL_PX && step < 1 << 20) step *= 2
  return step
}

/** Seconds between the ticks inside a free span at `pps` pixels per second. */
export const freeTickStep = (pps: number) => (pps >= 40 ? 1 : pps >= 15 ? 5 : 10)

/** Bar lines, beats and free spans with `fromSample <= sample < toSample` at `pps`, ready to draw. */
export function rulerGrid(map: TimeMap, fromSample: number, toSample: number, pps: number): { lines: RulerLine[]; free: RulerFree[] } {
  const rate = map.sampleRate
  const px = (a: number, b: number) => ((b - a) / rate) * pps
  const { lines: raw, free } = map.bars(fromSample, toSample)
  // the narrowest bar in view decides how many bar numbers are shown
  let minBar = Infinity
  let prevBar: number | null = null
  for (const l of raw) {
    if (!l.isBar) continue
    if (prevBar != null) minBar = Math.min(minBar, px(prevBar, l.sample))
    prevBar = l.sample
  }
  const step = labelStep(minBar)
  const lines: RulerLine[] = []
  let prev: number | null = null
  for (const l of raw) {
    const gap = prev == null ? Infinity : px(prev, l.sample)
    prev = l.sample
    if (l.isBar) lines.push({ sample: l.sample, bar: l.bar, kind: 'bar', free: l.free, ...((l.bar - 1) % step === 0 ? { label: String(l.bar) } : {}) })
    else if (gap >= MIN_BEAT_PX) lines.push({ sample: l.sample, bar: l.bar, kind: l.isGroup ? 'group' : 'beat', free: false })
  }
  const spans: RulerFree[] = free.map((f) => {
    const stepSec = freeTickStep(pps)
    const ticks: RulerTick[] = []
    const first = Math.max(1, Math.ceil((fromSample - f.fromSample) / rate / stepSec))
    for (let k = first; ticks.length < 400; k++) {
      const s = f.fromSample + k * stepSec * rate
      if (s >= Math.min(toSample, f.toSample)) break
      ticks.push({ sample: s, label: `${k * stepSec}s` })
    }
    return { fromSample: f.fromSample, toSample: f.toSample, ticks }
  })
  return { lines, free: spans }
}

export type Badge = {
  id: string
  bar: number
  sample: number
  label: string
  /** A ramp: drawn as a slope from here to `toSample`, from `bpm0` to `bpm1`. */
  ramp?: { toSample: number; bpm0: number; bpm1: number }
}

/** One badge per stored region (bar 1's too: it says the starting tempo and meter). */
export function rulerBadges(map: TimeMap): Badge[] {
  const rate = map.sampleRate
  return map.regions.map((r) => {
    const sp = map.spanOf(r.id)
    const sample = sp ? Math.round(sp.startSample) : map.barStartSample(r.bar)
    const end = regionEnd(map, r.id)
    const ramps = r.kind === 'metered' && r.rampTo != null && r.rampTo !== r.bpm && end
    const defaults = r.kind === 'metered' ? map.meterAt(r.bar).groups : undefined
    return { id: r.id, bar: r.bar, sample, label: regionLabel(r, rate, defaults), ...(ramps && r.kind === 'metered' ? { ramp: { toSample: end.sample, bpm0: r.bpm, bpm1: r.rampTo! } } : {}) }
  })
}

export type MarkerItem = { id: string; bar: number; sample: number; label: string; title: string }
export function rulerMarkers(map: TimeMap, markers: readonly Marker[]): MarkerItem[] {
  return markers.map((m) => ({ id: m.id, bar: m.bar, sample: map.barStartSample(m.bar), label: m.label, title: m.text ? `${m.label}: ${m.text}` : m.label }))
}

/** The bar line nearest to `sample` (the bar a click on the ruler means). Inside a free region: its bar. */
export function nearestBar(map: TimeMap, sample: number): number {
  const t = map.sampleToTick(Math.max(0, sample))
  const pos = map.position(t)
  if (pos.free) return pos.bar
  const barTicks = map.meterAt(pos.bar).barTicks
  return pos.bar + (pos.tickInBar / barTicks >= 0.5 ? 1 : 0)
}
