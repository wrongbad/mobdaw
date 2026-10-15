// Second ticks with labels along a ruler (the timeline's, and a soundscape source lane's own).
import { For, createMemo, type Accessor } from 'solid-js'
import { render } from 'solid-js/web'
import { fmt } from './transport'

/** The tick step in seconds at `pps` pixels per second, and how many ticks there are in `totalSec`. */
export function tickGrid(totalSec: number, pps: number) {
  const step = pps >= 40 ? 1 : pps >= 15 ? 5 : 10
  return { step, count: Math.floor(totalSec / step) + 1 }
}

function Ticks(p: { totalSec: Accessor<number>; pps: Accessor<number>; after?: Node }) {
  const grid = createMemo(() => tickGrid(p.totalSec(), p.pps()), undefined, { equals: (a, b) => a.step === b.step && a.count === b.count })
  const marks = createMemo(() => Array.from({ length: grid().count }, (_, i) => i))
  return (
    <>
      <For each={marks()}>{(i) => <span class="tick" style={{ left: `${i * grid().step * p.pps()}px` }}>{fmt(i * grid().step).replace(/\.0$/, '')}</span>}</For>
      {p.after}
    </>
  )
}

type Props = Parameters<typeof Ticks>[0]
/** Draw the ticks into `box` (`after`: a node that stays last, like the ruler's playhead lines). */
export const mountTicks = (box: HTMLElement, p: Props) => render(() => <Ticks {...p} />, box)
