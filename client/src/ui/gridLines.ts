// The piano roll's and drum grid's time axis, drawn from the project's time map (docs/engine.md §2): bar lines, beats, beat-group
// starts (7/8 as 2+2+3) and sub-beat steps, with free (unmetered) stretches left blank and shaded. The layout is pure (testable);
// `gridSvg` turns it into one SVG so a long clip costs a handful of paths, not a CSS gradient per grid.
import type { TimeMap } from '@mobdaw/shared'

/** Where a clip's local ticks fall on the editor's x axis: it follows the timeline's scale (px per second), so it matches the ruler even under a ramp. */
export type ClipGeom = {
  /** css px of a tick counted from the clip's start. */
  x(localTick: number): number
  /** The local tick under an x (px from the clip's left edge); may be negative or past the clip. */
  tick(x: number): number
}
export function clipGeom(map: TimeMap, startTick: number, pps: number): ClipGeom {
  const s0 = map.tickToSampleExact(startTick)
  const k = pps / map.sampleRate
  return {
    x: (t) => (map.tickToSampleExact(startTick + t) - s0) * k,
    tick: (x) => map.sampleToTick(s0 + x / k) - startTick,
  }
}

export type GridLayout = {
  /** x (px) of each kind of line; a bar line is not repeated in `beat`, and a group start not in `bar`. */
  bar: number[]
  group: number[]
  beat: number[]
  sub: number[]
  /** Unmetered stretches [x0, x1] (no lines inside). */
  free: [number, number][]
}

/**
 * The lines of a clip from `startTick` out to `extentTicks`. `subTicks` (0: none) adds a line every `subTicks` inside each beat when
 * they are at least `minSubPx` apart. Under a ramp the spacing is that of the beat's start.
 */
export function gridLayout(map: TimeMap, startTick: number, extentTicks: number, pps: number, subTicks = 0, minSubPx = 6, limit = 6000): GridLayout {
  const g = clipGeom(map, startTick, pps)
  const out: GridLayout = { bar: [], group: [], beat: [], sub: [], free: [] }
  const s0 = map.tickToSampleExact(startTick)
  const s1 = map.tickToSampleExact(startTick + extentTicks)
  const { lines, free } = map.bars(s0, s1 + 1, limit)
  const xs = (tick: number) => g.x(tick - startTick)
  const end = g.x(extentTicks)
  for (const f of free) {
    const a = Math.max(0, ((f.fromSample - s0) * pps) / map.sampleRate), b = Math.min(end, ((f.toSample - s0) * pps) / map.sampleRate)
    if (b > a) out.free.push([a, b])
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const x = xs(l.tick)
    if (x > end + 0.5) break
    if (l.isBar) out.bar.push(x)
    else if (l.isGroup) out.group.push(x)
    else out.beat.push(x)
    if (subTicks > 0 && !l.free) {
      const m = map.meterAt(l.bar)
      const nextTick = Math.min(lines[i + 1]?.tick ?? l.tick + m.beatTicks, l.tick + m.beatTicks)
      const px = xs(l.tick + subTicks) - x
      if (px >= minSubPx) for (let t = l.tick + subTicks; t < nextTick - 1e-6; t += subTicks) { const sx = xs(t); if (sx <= end) out.sub.push(sx) }
    }
  }
  return out
}

const NS = 'http://www.w3.org/2000/svg'
const path = (xs: number[], style: string) => {
  const p = document.createElementNS(NS, 'path')
  p.setAttribute('d', xs.map((x) => `M${Math.round(x) + 0.5} 0v100000`).join(''))
  p.setAttribute('style', `fill:none;${style}`)
  p.setAttribute('stroke-width', '1')
  return p
}

/**
 * One absolutely positioned SVG for a layout, `width` px wide and as tall as its parent. Colours are the stylesheet's grid variables, so
 * it themes like the old CSS grid; bar lines are brightest, beat-group starts next, then beats, then sub-steps.
 * `sub: false` leaves out the sub-beat lines (the velocity lane).
 */
export function gridSvg(l: GridLayout, width: number, o: { sub?: boolean } = {}): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'ne-lines')
  svg.setAttribute('style', `position:absolute;left:0;top:0;width:${width}px;height:100%;pointer-events:none;overflow:hidden`)
  for (const [a, b] of l.free) {
    const r = document.createElementNS(NS, 'rect')
    r.setAttribute('x', String(a)); r.setAttribute('y', '0'); r.setAttribute('width', String(b - a)); r.setAttribute('height', '100000')
    r.setAttribute('style', 'fill:rgba(0,0,0,.28)')
    svg.append(r)
  }
  if (o.sub !== false && l.sub.length) svg.append(path(l.sub, 'stroke:var(--grid-beat)'))
  svg.append(path(l.beat, 'stroke:var(--grid-bar)'))
  svg.append(path(l.group, 'stroke:var(--grid-bar);opacity:1;stroke-width:1.5'))
  svg.append(path(l.bar, 'stroke:rgba(235,230,220,.32)'))
  return svg
}
