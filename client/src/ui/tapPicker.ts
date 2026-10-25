// The tap picker: a card's button that names the tap it reads and opens the list of taps (docs/routing.md). The label follows the doc
// (a rename shows at once; a deleted tap turns the button into a "missing" warning).
import type { Device, Tap } from '@mobdaw/shared'
import { createRenderEffect } from 'solid-js'
import { h } from '../dom'
import type { ProjectStore } from '../project/store'
import { popover, type MenuItem } from './popover'

const HEADINGS: Record<Exclude<Tap['kind'], 'master'>, string> = { track: 'tracks', bus: 'buses', send: 'sends' }

/**
 * The popover's entries for a device on `scope` (its track, a bus or the master) reading `current`: `noneLabel`, then the taps grouped by
 * kind. The chain's own implicit tap is left out (reading it back is pure one-block feedback) unless it is the current one; the chain's
 * own sends are marked "this chain". Cycles stay legal, they just are not what a beginner is offered first.
 */
export function tapItems(taps: readonly Tap[], scope: string, current: string | undefined, noneLabel: string, pick: (id: string | undefined) => void): MenuItem[] {
  const items: MenuItem[] = [{ label: noneLabel, hint: current == null ? '✓' : undefined, run: () => pick(undefined) }]
  for (const kind of ['track', 'bus', 'send', 'master'] as const) {
    const rows = taps.filter((t) => t.kind === kind && (t.id !== scope || t.id === current))
    if (!rows.length) continue
    items.push('sep')
    if (kind !== 'master') items.push({ label: HEADINGS[kind as keyof typeof HEADINGS], run: () => {}, disabled: true }) // (the master is its own heading)
    for (const t of rows) {
      const hint = t.id === current ? '✓' : t.id === scope || (t.kind === 'send' && t.owner === scope) ? 'this chain' : undefined
      items.push({ label: t.label, hint, run: () => pick(t.id) })
    }
  }
  return items
}

/**
 * The picker button for a device (call it inside the card, so it follows the store). `none` is the text for "no tap" ("none" for a
 * recv, "self" for a compressor's key). Picking calls `set` with a tap id, or undefined for none.
 */
export function tapPicker(o: { store: ProjectStore; dev: () => Device; none: string; title: string; set: (tapId: string | undefined) => void }) {
  const text = h('span', { className: 'tp-label' })
  const btn = h('button', { className: 'tap-pick', type: 'button', 'aria-haspopup': 'menu' }, text, h('span', { className: 'tp-caret', 'aria-hidden': 'true' }, '▾'))
  createRenderEffect(() => {
    const cur = o.dev().input
    const tap = cur == null ? undefined : o.store.taps().find((t) => t.id === cur)
    const missing = cur != null && !tap
    text.textContent = cur == null ? o.none : (tap?.label ?? 'missing')
    btn.classList.toggle('none', cur == null)
    btn.classList.toggle('missing', missing)
    btn.title = missing ? `${o.title}: the tap this read was deleted (pick another)` : `${o.title}: ${text.textContent}`
  })
  btn.addEventListener('click', () => {
    const d = o.dev()
    popover(btn, tapItems(o.store.taps(), d.trackId, d.input, o.none, o.set))
  })
  return btn
}
