// The main ruler: bar lines and numbers and beats in metered regions, seconds in free ones, a badge where the tempo or meter
// changes (a ramp as a sloped line to the next region), and the markers in a thin row above. Only what is near the visible part is
// drawn. Clicks on a badge or marker open the ruler menu (timeline.ts wires it); everything else seeks.
import { For, Show, createMemo, type Accessor } from 'solid-js'
import { render } from 'solid-js/web'
import type { Marker, TimeMap } from '@mobdaw/shared'
import { nearestBar, rulerBadges, rulerGrid, rulerMarkers, type Badge, type MarkerItem } from './rulerModel'
import type { RulerTarget } from './rulerMenu'

export type RulerProps = {
  map: Accessor<TimeMap>
  markers: Accessor<Marker[]>
  /** The project key ("D minor"), shown with the first badge. */
  keyText: Accessor<string | undefined>
  pps: Accessor<number>
  /** The scroller's scroll and visible width (px). */
  scrollX: Accessor<number>
  viewW: Accessor<number>
  /** A badge or marker was pressed (a click, not a drag). */
  onMenu(target: RulerTarget, at: [number, number], el: HTMLElement): void
  /** Node that stays last in the ruler body (the playhead lines). */
  after?: Node
}

/** The drawn window in ruler px: the visible part and a screen to each side, in steps so a scroll doesn't redraw every frame. */
export function drawnWindow(scrollX: number, viewW: number): [number, number] {
  const w = Math.max(viewW, 600)
  const q = w / 2
  return [Math.floor((scrollX - w) / q) * q, Math.ceil((scrollX + 2 * w) / q) * q]
}

const SLOPE_H = 10

function Ruler(p: RulerProps) {
  const rate = () => p.map().sampleRate
  const x = (sample: number) => (sample / rate()) * p.pps()
  const win = createMemo(() => drawnWindow(p.scrollX(), p.viewW()), undefined, { equals: (a, b) => a[0] === b[0] && a[1] === b[1] })
  const grid = createMemo(() => {
    const [lo, hi] = win()
    return rulerGrid(p.map(), (Math.max(0, lo) / p.pps()) * rate(), (hi / p.pps()) * rate(), p.pps())
  })
  const badges = createMemo(() => rulerBadges(p.map()))
  const markers = createMemo(() => rulerMarkers(p.map(), p.markers()))
  // a press on a badge or marker must not seek; the click that follows opens the menu
  const menuOn = (t: RulerTarget) => (e: MouseEvent) => (e.stopPropagation(), p.onMenu(t, [e.clientX, e.clientY], e.currentTarget as HTMLElement))
  const stop = (e: Event) => e.stopPropagation()
  return (
    <>
      <For each={grid().free}>{(f) => (
        <div class="rl-free" style={{ left: `${x(f.fromSample)}px`, width: `${x(f.toSample - f.fromSample)}px` }}>
          <For each={f.ticks}>{(t) => <span class="rl-s" style={{ left: `${x(t.sample - f.fromSample)}px` }}>{t.label}</span>}</For>
        </div>
      )}</For>
      <For each={grid().lines}>{(l) => (
        <span class={`rl ${l.kind}`} classList={{ free: l.free }} style={{ left: `${x(l.sample)}px` }}>{l.label}</span>
      )}</For>
      <For each={badges()}>{(b: Badge) => (
        <>
          <Show when={b.ramp}>{(r) => (
            <svg class="rl-ramp" style={{ left: `${x(b.sample)}px`, width: `${Math.max(1, x(r().toSample - b.sample))}px` }} height={SLOPE_H} preserveAspectRatio="none"
              viewBox={`0 0 100 ${SLOPE_H}`}>
              <polyline points={`0,${r().bpm0 > r().bpm1 ? 1 : SLOPE_H - 1} 100,${r().bpm0 > r().bpm1 ? SLOPE_H - 1 : 1}`} vector-effect="non-scaling-stroke" />
            </svg>
          )}</Show>
          <button class="rl-badge" style={{ left: `${x(b.sample)}px` }} title={`bar ${b.bar}: click to edit`} on:pointerdown={stop} on:click={menuOn({ bar: b.bar, regionId: b.id })}>
            {b.label}{b.bar === 1 && p.keyText() ? ` · ${p.keyText()}` : ''}
          </button>
        </>
      )}</For>
      <For each={markers()}>{(m: MarkerItem) => (
        <button class="rl-marker" style={{ left: `${x(m.sample)}px` }} title={m.title} on:pointerdown={stop} on:click={menuOn({ bar: m.bar, markerId: m.id })}>{m.label}</button>
      )}</For>
      {p.after}
    </>
  )
}

/** Draw the ruler into `box`; returns the function that takes it down. */
export const mountRuler = (box: HTMLElement, p: RulerProps) => render(() => <Ruler {...p} />, box)

/** The bar a click at ruler px `px` means, for the menu. */
export const barAtPx = (map: TimeMap, px: number, pps: number) => nearestBar(map, (Math.max(0, px) / pps) * map.sampleRate)
