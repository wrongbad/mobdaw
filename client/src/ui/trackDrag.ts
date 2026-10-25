// Drag a track (or a bus, with everything in it) by its header to a new place in the list: between two tracks, into a bus (among its
// tracks, or onto its own row at the bottom of its box) or out of one (below its row). The lane follows the pointer vertically (a
// transform; the DOM order is left alone), a line shows where it would land, and nothing is written until the drop.
// Touch: a long press on the header lifts it first (see lift.ts), as with the device cards; everything here is also in the header's menu.
import { MASTER_TRACK } from '@mobdaw/shared'
import { lift } from './lift'
import type { Anchor } from '../project/buses'

const THRESHOLD = 4 // px before a press becomes a drag
const NEAR_TOP = 20 // px of a lane's top edge that mean "in front of it"
const HEADER_H = 72 // a lane's header row: pointing at a bus's own row (below its top edge) means "into it"

/**
 * A listed lane as the pointer sees it: its box, and what dropping on it can mean. A bus is a box around its tracks with its own row at
 * the bottom: `head` is where its first track starts (its row's top, `foot`, when it shows none).
 */
export type DropItem = { id: string; top: number; bottom: number; bus: false } | { id: string; top: number; bottom: number; bus: true; head: number; foot: number }

/**
 * What a pointer at height `y` means among the listed lanes, in list order (a bus before its tracks; the dragged lane and what is
 * under it left out). The top edge of a lane is "in front of it" (for a bus showing its tracks, the frame above the first one); the rest
 * of a track's box splits at its middle; the space in a bus below its last track, and the top of the bus's own row, is "into it, last";
 * the rest of that row is "behind it"; below everything is the end of the master's list. Null: no lanes.
 */
export function anchorAt(items: DropItem[], y: number): Anchor | null {
  if (!items.length) return null
  const inside: string[] = [] // the buses whose box holds y, outermost first, with their feet
  const feet = new Map<string, number>()
  for (const it of items) {
    const box = inside.at(-1)
    if (box && it.top >= feet.get(box)!) return { id: box, at: 'end' } // past the last track of the bus y is in
    if (y >= it.bottom) continue
    const d = y - it.top
    if (!it.bus) return d < NEAR_TOP || d < (it.bottom - it.top) / 2 ? { id: it.id, at: 'before' } : { id: it.id, at: 'after' }
    if (y < (it.head < it.foot ? it.head : it.top + NEAR_TOP)) return { id: it.id, at: 'before' }
    if (y < it.foot) {
      inside.push(it.id)
      feet.set(it.id, it.foot)
      continue
    }
    return y - it.foot < HEADER_H - NEAR_TOP ? { id: it.id, at: 'end' } : { id: it.id, at: 'after' }
  }
  const box = inside.at(-1)
  return box ? { id: box, at: 'end' } : { id: MASTER_TRACK, at: 'end' }
}

export type TrackDragDeps = {
  /** The lanes in list order, shown ones only, with the boxes to hit-test against. Called on every move. */
  items(id: string): DropItem[]
  /** The elements that travel with the pointer: the dragged lane (a bus's box holds its tracks). */
  moving(id: string): HTMLElement[]
  /** What dropping on `anchor` would do: the line to draw, or null when it is not a place for this track (or changes nothing). */
  preview(id: string, anchor: Anchor): { y: number; depth: number } | null
  /** Dropped on `anchor`. */
  drop(id: string, anchor: Anchor): void
  /** The scroller, which follows a pointer at its top or bottom edge. */
  scroller?: HTMLElement
  /** The element the line is drawn in (positioned, scrolling with the lanes). */
  line: HTMLElement
  /** The drag began / is over, dropped or not. */
  start?(): void
  end?(): void
}

/** Make `handle` (a track's header) drag the track `id`. Presses on its buttons and fields are left alone. */
export function dragTrack(handle: HTMLElement, id: string, deps: TrackDragDeps) {
  let from: { y: number; scroll: number; pointer: number } | null = null
  let dragging = false
  let anchor: Anchor | null = null
  let traveling: HTMLElement[] = []
  let last = 0

  const show = (a: Anchor | null) => {
    anchor = a
    const p = a && deps.preview(id, a)
    deps.line.hidden = !p
    if (!p) return
    deps.line.style.top = `${p.y}px`
    deps.line.style.setProperty('--depth', String(p.depth))
  }
  const move = (clientY: number) => {
    last = clientY
    const dy = clientY - from!.y + ((deps.scroller?.scrollTop ?? 0) - from!.scroll)
    for (const l of traveling) l.style.transform = `translateY(${dy}px)`
    show(anchorAt(deps.items(id), clientY))
  }
  const edge = (clientY: number) => {
    const s = deps.scroller
    if (!s) return
    const r = s.getBoundingClientRect()
    const by = clientY < r.top + 40 ? -14 : clientY > r.bottom - 40 ? 14 : 0
    if (by) s.scrollTop += by
  }
  function finish(drop: boolean) {
    if (!from) return
    const was = dragging
    from = null
    dragging = false
    for (const l of traveling) (l.classList.remove('reordering'), (l.style.transform = ''))
    traveling = []
    deps.line.hidden = true
    removeEventListener('keydown', onKey)
    if (!was) return
    const a = anchor
    anchor = null
    // the click that ends the press would open the header's menu
    const swallow = (e: Event) => (e.stopImmediatePropagation(), e.preventDefault())
    handle.addEventListener('click', swallow, { capture: true, once: true })
    setTimeout(() => handle.removeEventListener('click', swallow, true), 400)
    if (drop && a) deps.drop(id, a)
    deps.end?.()
  }
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish(false)

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, select, .knob')) return
    lift(e, () => {
      from = { y: e.clientY, scroll: deps.scroller?.scrollTop ?? 0, pointer: e.pointerId }
      handle.setPointerCapture(e.pointerId)
    })
  })
  handle.addEventListener('pointermove', (e) => {
    if (!from || e.pointerId !== from.pointer) return
    if (!dragging) {
      if (Math.abs(e.clientY - from.y) < THRESHOLD) return
      dragging = true
      traveling = deps.moving(id)
      for (const l of traveling) l.classList.add('reordering')
      addEventListener('keydown', onKey)
      deps.start?.()
    }
    edge(e.clientY)
    move(e.clientY)
  })
  handle.addEventListener('pointerup', () => finish(true))
  handle.addEventListener('pointercancel', () => finish(false))
  handle.addEventListener('lostpointercapture', () => dragging && finish(false))
  // the list scrolled under a held pointer (edge scrolling): keep the line and the travelling lanes where they belong
  deps.scroller?.addEventListener('scroll', () => dragging && move(last), { passive: true })
}
