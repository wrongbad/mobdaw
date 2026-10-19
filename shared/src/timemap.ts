// The project timeline: one map from musical time (bars, beats, ticks) to samples that every track agrees on
// (docs/engine.md §2). Pure, deterministic functions of (regions, sampleRate, ppq); no Yjs here.
//
// Units: a *tick* is 1/ppq of a quarter note, counted from bar 1 beat 1 (tick 0 = sample 0). `bpm` is quarter
// notes per minute whatever the meter's denominator. Everything is f64; nothing is rounded except `tickToSample`
// (once, where an event becomes a sample) and the `sample` field of `bars()` lines.
//
// Regions partition the bars: region i owns bars [bar_i, bar_{i+1}); the last one runs forever. A *free* region is
// exactly one bar of `length` samples with no beats; its ticks are nominal (its length at the previous region's
// tempo, 120 if first) so ticks <-> samples stays a bijection. Whatever follows a free region's single bar and has
// no region of its own is filled with the previous metered meter at the free region's nominal tempo.
import type { Region } from './schema.ts'

export const DEFAULT_REGION_BPM = 120

/** The region every timeline starts with. Its id is fixed so clients synthesizing it at once write the same entry. */
export const DEFAULT_REGION_ID = 'default'
export const defaultRegion = (): Region => ({ id: DEFAULT_REGION_ID, bar: 1, kind: 'metered', bpm: DEFAULT_REGION_BPM, num: 4, den: 4 })

/** Beat groups when a region gives none: threes for compound meters (6/8, 9/8, 12/8 ...), else the whole bar is one group. */
export function defaultGroups(num: number, den: number): number[] {
  if (den >= 8 && num >= 6 && num % 3 === 0) return Array.from({ length: num / 3 }, () => 3)
  return [num]
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Clamp one region's fields to something the map can use (a collaborator or an old client may have written anything). */
function sanitize(r: Region): Region {
  const bar = Math.max(1, Math.round(finite(r.bar) ? r.bar : 1))
  if (r.kind === 'free') return { id: r.id, bar, kind: 'free', length: Math.max(1, Math.round(finite(r.length) ? r.length : 1)) }
  const bpm = finite(r.bpm) && r.bpm > 0 ? r.bpm : DEFAULT_REGION_BPM
  const num = Math.max(1, Math.round(finite(r.num) ? r.num : 4))
  const den = Math.max(1, Math.round(finite(r.den) ? r.den : 4))
  const out: Region = { id: r.id, bar, kind: 'metered', bpm, num, den }
  if (Array.isArray(r.groups) && r.groups.length && r.groups.every((g) => finite(g) && g >= 1) && r.groups.reduce((a, b) => a + b, 0) === num) out.groups = [...r.groups]
  if (finite(r.rampTo) && r.rampTo > 0) out.rampTo = r.rampTo
  return out
}

/**
 * The collaboration rules, applied to any list of regions (a view, never mutating the input): fields clamped to usable values;
 * regions sharing a bar resolve to the one with the smallest id (`<` on strings, the same on every client); a default 120 4/4
 * region is synthesized at bar 1 when none starts there (a region starting later is kept); sorted by bar.
 */
export function normalizeRegions(list: readonly Region[]): Region[] {
  const byBar = new Map<number, Region>()
  for (const raw of list) {
    const r = sanitize(raw)
    const have = byBar.get(r.bar)
    if (!have || r.id < have.id) byBar.set(r.bar, r)
  }
  if (!byBar.has(1)) byBar.set(1, defaultRegion())
  return [...byBar.values()].sort((a, b) => a.bar - b.bar)
}

/** The region in effect at `bar` within an already-normalized list. */
export function regionForBar(regions: readonly Region[], bar: number): Region {
  let lo = 0, hi = regions.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (regions[mid].bar <= bar) lo = mid
    else hi = mid - 1
  }
  return regions[lo]
}

/** First bar after `regions[i]`, or Infinity for the last region. (Free regions are one bar, so see `TimeMap.span` for the filled partition.) */
export const regionEndBar = (regions: readonly Region[], i: number) => (i + 1 < regions.length ? regions[i + 1].bar : Infinity)

/** The meter at a bar. For a free region `free` is true and `num/den/groups` are placeholders (1/4): there are no beats. */
export type Meter = {
  region: Region
  free: boolean
  num: number
  den: number
  /** Beats per group, resolved (`region.groups ?? defaultGroups`). Group starts are where a count starts afresh (2+2+3). */
  groups: number[]
  /** Ticks per beat (a `1/den` note), and per bar. In a free region barTicks is its nominal length and beatTicks = ppq. */
  beatTicks: number
  barTicks: number
  /** Tempo at the start of the bar's region, quarter notes/min. */
  bpm: number
}

/** A bar line or beat in a window. */
export type GridLine = {
  tick: number
  /** Rounded once, from the exact tick. */
  sample: number
  bar: number
  /** 1-based beat within the bar (1 = the bar line). A free region's line is beat 1. */
  beat: number
  isBar: boolean
  /** A bar line, or the first beat of a beat group (always true for bar lines). Always false in free regions beyond the bar line. */
  isGroup: boolean
  /** The bar line of a free region (ruler shows seconds from here). */
  free: boolean
}
/** A run of unmetered time, in samples. */
export type FreeSpan = { bar: number; fromSample: number; toSample: number; region: Region }
export type BarsWindow = { lines: GridLine[]; free: FreeSpan[] }

/** Where a tick is. `beat` is 1-based and fractional (the `12:3.5` of badmidi). In a free region it is 1 and `free` is true. */
export type Position = { bar: number; beat: number; free: boolean; tickInBar: number }

/** A subdivision to snap to: bar lines, beats, or `n` equal steps per beat (2 = half beats, 4 = quarter beats...). */
export type SnapDivision = 'bar' | 'beat' | number

/** One region (or a filler after a free region) laid out on the tick and sample axes. */
export type Span = {
  region: Region
  /** True for a metered filler synthesized after a free region (the meter before the free region; never stored). */
  synthetic: boolean
  startBar: number
  /** First bar after this span (Infinity for the last). */
  endBar: number
  startTick: number
  endTick: number
  /** Exact (unrounded) sample positions. */
  startSample: number
  endSample: number
  /** Tempo at the span's start and end (equal unless ramping; for a free span, the nominal tempo). */
  bpm0: number
  bpm1: number
}

export type TimeMap = {
  readonly sampleRate: number
  readonly ppq: number
  /** The normalized regions the map was built from (stored ones; no synthetic fillers). */
  readonly regions: readonly Region[]
  /** The layout including fillers, in order. */
  readonly spans: readonly Span[]
  /** Ticks -> sample, rounded once. Before tick 0 the first span's tempo extrapolates. */
  tickToSample(tick: number): number
  /** Ticks -> exact fractional sample (for drawing, or when summing before one rounding). */
  tickToSampleExact(tick: number): number
  sampleToTick(sample: number): number
  /** Tick / sample of the start of `bar` (1-based; fractional bars interpolate within metered regions). */
  barStart(bar: number): number
  barStartSample(bar: number): number
  position(tick: number): Position
  /** The (stored or synthetic filler) region in effect at a tick / sample. */
  regionAt(tick: number): Region
  regionAtSample(sample: number): Region
  /** Layout of the region at a tick / sample / bar. */
  spanAt(tick: number): Span
  spanAtSample(sample: number): Span
  spanAtBar(bar: number): Span
  /** The span of a stored region by id, or undefined. */
  spanOf(regionId: string): Span | undefined
  meterAt(bar: number): Meter
  /**
   * Bar lines and beats with `fromSample <= sample < toSample` (by exact position), in order, and the unmetered spans overlapping
   * the window. Free regions contribute one bar line at their start. `limit` (default 20000) caps the lines; the ruler zooms
   * further than that never need more.
   */
  bars(fromSample: number, toSample: number, limit?: number): BarsWindow
  /** Nearest bar / beat / subdivision to a sample, or null inside a free region (no grid there). */
  snapSample(sample: number, division: SnapDivision): number | null
  /** The same in ticks. */
  snapTick(tick: number, division: SnapDivision): number | null
}

/**
 * Build the map. `regions` may be any list (it is normalized). Cheap: O(regions); build once and cache (see `getTimeMap`).
 * Constant tempo: samples = ticks * 60 * rate / (bpm * ppq). A ramp (`rampTo`, only when another region follows) moves the tempo
 * linearly in ticks from `bpm` to `rampTo`; time is the closed-form integral of 60/(ppq*bpm(t)) and its inverse an exp, no iteration.
 */
export function timeMap(regionList: readonly Region[], sampleRate: number, ppq: number): TimeMap {
  const regions = normalizeRegions(regionList)
  const spans = layout(regions, sampleRate, ppq)

  const spanIdxTick = (tick: number) => {
    let lo = 0, hi = spans.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (spans[mid].startTick <= tick) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const spanIdxSample = (s: number) => {
    let lo = 0, hi = spans.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (spans[mid].startSample <= s) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  const spanIdxBar = (bar: number) => {
    let lo = 0, hi = spans.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (spans[mid].startBar <= bar) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  const tickToSampleExact = (tick: number) => {
    const sp = spans[spanIdxTick(tick)]
    return ticksToSampleIn(sp, tick - sp.startTick, sampleRate, ppq)
  }
  const sampleToTick = (sample: number) => {
    const sp = spans[spanIdxSample(sample)]
    return sp.startTick + sampleToTicksIn(sp, sample - sp.startSample, sampleRate, ppq)
  }
  const barTicksOf = (sp: Span) => (sp.region.kind === 'free' ? sp.endTick - sp.startTick : (sp.region.num * 4 * ppq) / sp.region.den)
  const beatTicksOf = (sp: Span) => (sp.region.kind === 'free' ? ppq : (4 * ppq) / sp.region.den)

  const barStart = (bar: number) => {
    const sp = spans[spanIdxBar(bar)]
    return sp.startTick + (bar - sp.startBar) * barTicksOf(sp)
  }
  const meterOfSpan = (sp: Span): Meter => {
    const r = sp.region
    if (r.kind === 'free') return { region: r, free: true, num: 1, den: 4, groups: [1], beatTicks: ppq, barTicks: sp.endTick - sp.startTick, bpm: sp.bpm0 }
    return { region: r, free: false, num: r.num, den: r.den, groups: r.groups ?? defaultGroups(r.num, r.den), beatTicks: beatTicksOf(sp), barTicks: barTicksOf(sp), bpm: r.bpm }
  }

  const snapTick = (tick: number, division: SnapDivision): number | null => {
    const sp = spans[spanIdxTick(tick)]
    if (sp.region.kind === 'free') return null
    const step = division === 'bar' ? barTicksOf(sp) : beatTicksOf(sp) / (division === 'beat' ? 1 : Math.max(1, division))
    const k = (tick - sp.startTick) / step
    const lo = sp.startTick + Math.floor(k) * step
    const hi = Math.min(sp.startTick + Math.ceil(k) * step, sp.endTick)
    // nearest in *samples* (the ear's measure; under a ramp the tick midpoint is not the time midpoint)
    const sT = tickToSampleExact(tick)
    return Math.abs(tickToSampleExact(lo) - sT) <= Math.abs(tickToSampleExact(hi) - sT) ? lo : hi
  }

  return {
    sampleRate,
    ppq,
    regions,
    spans,
    tickToSample: (tick) => Math.round(tickToSampleExact(tick)),
    tickToSampleExact,
    sampleToTick,
    barStart,
    barStartSample: (bar) => Math.round(tickToSampleExact(barStart(bar))),
    position(tick) {
      const sp = spans[spanIdxTick(tick)]
      if (sp.region.kind === 'free') return { bar: sp.startBar, beat: 1, free: true, tickInBar: tick - sp.startTick }
      const bt = barTicksOf(sp)
      const n = Math.floor((tick - sp.startTick) / bt)
      const tickInBar = tick - sp.startTick - n * bt
      return { bar: sp.startBar + n, beat: 1 + tickInBar / beatTicksOf(sp), free: false, tickInBar }
    },
    regionAt: (tick) => spans[spanIdxTick(tick)].region,
    regionAtSample: (s) => spans[spanIdxSample(s)].region,
    spanAt: (tick) => spans[spanIdxTick(tick)],
    spanAtSample: (s) => spans[spanIdxSample(s)],
    spanAtBar: (bar) => spans[spanIdxBar(bar)],
    spanOf: (id) => spans.find((s) => !s.synthetic && s.region.id === id),
    meterAt: (bar) => meterOfSpan(spans[spanIdxBar(bar)]),
    bars(fromSample, toSample, limit = 20000) {
      const lines: GridLine[] = []
      const free: FreeSpan[] = []
      if (!(toSample > fromSample)) return { lines, free }
      for (let i = Math.max(0, spanIdxSample(fromSample)); i < spans.length && spans[i].startSample < toSample; i++) {
        const sp = spans[i]
        if (sp.region.kind === 'free') {
          free.push({ bar: sp.startBar, fromSample: sp.startSample, toSample: sp.endSample, region: sp.region })
          if (sp.startSample >= fromSample) lines.push({ tick: sp.startTick, sample: Math.round(sp.startSample), bar: sp.startBar, beat: 1, isBar: true, isGroup: true, free: true })
          continue
        }
        const m = meterOfSpan(sp)
        const groupStart = new Set<number>()
        for (let b = 0, g = 0; g < m.groups.length; b += m.groups[g++]) groupStart.add(b)
        // first beat at or after fromSample (and at or after this span's start)
        const t0 = Math.max(sp.startTick, sampleToTick(Math.max(fromSample, sp.startSample)))
        let n = Math.max(0, Math.ceil((t0 - sp.startTick) / m.beatTicks - 1e-9))
        for (;; n++) {
          const tick = sp.startTick + n * m.beatTicks
          if (tick >= sp.endTick) break
          const s = tickToSampleExact(tick)
          if (s >= toSample) break
          if (s >= fromSample) {
            const bar = sp.startBar + Math.floor(n / m.num)
            const beat0 = n % m.num
            lines.push({ tick, sample: Math.round(s), bar, beat: beat0 + 1, isBar: beat0 === 0, isGroup: groupStart.has(beat0), free: false })
            if (lines.length >= limit) return { lines, free }
          }
        }
      }
      return { lines, free }
    },
    snapTick,
    snapSample(sample, division) {
      const t = snapTick(sampleToTick(sample), division)
      return t == null ? null : Math.round(tickToSampleExact(t))
    },
  }
}

/** `snapSample`, but a position in a free region comes back unchanged (clip edges keep today's behaviour there). */
export const snapSampleOr = (map: TimeMap, sample: number, division: SnapDivision) => map.snapSample(sample, division) ?? sample

/** Where a region ends, for editing UI: its first bar after, the tick and sample of that, or null for the last region. */
export function regionEnd(map: TimeMap, regionId: string): { bar: number; tick: number; sample: number } | null {
  const sp = map.spanOf(regionId)
  if (!sp) return null
  // the end of the stored region is where the next *stored* region begins (fillers after a free region belong to it visually)
  const i = map.regions.findIndex((r) => r.id === regionId)
  const next = map.regions[i + 1]
  if (!next) return null
  return { bar: next.bar, tick: map.barStart(next.bar), sample: map.barStartSample(next.bar) }
}

// --- layout and per-span math

function layout(regions: readonly Region[], rate: number, ppq: number): Span[] {
  const spans: Span[] = []
  let tick = 0, sample = 0
  let bpmNow = DEFAULT_REGION_BPM // the tempo a free region borrows: the end tempo of what precedes it
  let meter: Region = defaultRegion() // the last metered region, for fillers
  const push = (region: Region, synthetic: boolean, endBar: number) => {
    const startBar = region.bar
    let endTick: number, endSample: number, bpm0: number, bpm1: number
    if (region.kind === 'free') {
      bpm0 = bpm1 = bpmNow
      endSample = sample + region.length
      endTick = tick + (region.length * bpmNow * ppq) / (60 * rate)
    } else {
      bpm0 = region.bpm
      const barTicks = (region.num * 4 * ppq) / region.den
      const finite = endBar !== Infinity
      const len = finite ? (endBar - startBar) * barTicks : Infinity
      bpm1 = finite && region.rampTo != null && region.rampTo !== region.bpm ? region.rampTo : region.bpm
      endTick = tick + len
      endSample = finite ? sample + secondsFor(bpm0, bpm1, len, ppq) * rate : Infinity
      meter = region
    }
    spans.push({ region, synthetic, startBar, endBar, startTick: tick, endTick, startSample: sample, endSample, bpm0, bpm1 })
    tick = endTick
    sample = endSample
    bpmNow = bpm1
  }
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i]
    const nextBar = regionEndBar(regions, i)
    if (r.kind === 'free') {
      const freeEnd = r.bar + 1
      push(r, false, freeEnd)
      if (nextBar > freeEnd) {
        push({ id: '', bar: freeEnd, kind: 'metered', bpm: bpmNow, num: meter.kind === 'metered' ? meter.num : 4, den: meter.kind === 'metered' ? meter.den : 4, ...(meter.kind === 'metered' && meter.groups ? { groups: meter.groups } : {}) }, true, nextBar)
      }
    } else push(r, false, nextBar)
  }
  return spans
}

/** Seconds for `ticks` ticks of a span going from tempo b0 to b1 linearly in ticks (b0 == b1: constant). */
function secondsFor(b0: number, b1: number, ticks: number, ppq: number, total = ticks): number {
  if (b0 === b1 || Math.abs(b1 - b0) < 1e-12 * b0) return (ticks * 60) / (b0 * ppq)
  const b = b0 + ((b1 - b0) * ticks) / total
  return ((60 * total) / (ppq * (b1 - b0))) * Math.log(b / b0)
}

function ticksToSampleIn(sp: Span, dt: number, rate: number, ppq: number): number {
  if (sp.region.kind === 'free') return sp.startSample + (dt * 60 * rate) / (sp.bpm0 * ppq)
  const total = sp.endTick - sp.startTick
  if (sp.bpm0 === sp.bpm1 || !Number.isFinite(total)) return sp.startSample + (dt * 60 * rate) / (sp.bpm0 * ppq)
  return sp.startSample + secondsFor(sp.bpm0, sp.bpm1, dt, ppq, total) * rate
}

function sampleToTicksIn(sp: Span, ds: number, rate: number, ppq: number): number {
  const total = sp.endTick - sp.startTick
  if (sp.region.kind === 'free' || sp.bpm0 === sp.bpm1 || !Number.isFinite(total)) return (ds * sp.bpm0 * ppq) / (60 * rate)
  const { bpm0: b0, bpm1: b1 } = sp
  if (Math.abs(b1 - b0) < 1e-12 * b0) return (ds * b0 * ppq) / (60 * rate)
  // seconds = 60 L / (ppq (b1-b0)) * ln(b/b0)  =>  b = b0 exp(seconds ppq (b1-b0) / (60 L))
  const b = b0 * Math.exp(((ds / rate) * ppq * (b1 - b0)) / (60 * total))
  return ((b - b0) * total) / (b1 - b0)
}
