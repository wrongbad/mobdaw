// Title-bar parts shared by the fx, synth and looper cards: the on/off switch and the delete menu.
import { h } from '../dom'
import { closedBy, deleteMenu, popover } from './popover'

/** A square on/off switch; drive it, and the dimming of its card while off, with `setSwitch`. */
export const onOffSwitch = (title: string, toggle: () => void) =>
  h('button', { title, className: 'sw', role: 'switch', onclick: toggle })

export function setSwitch(sw: HTMLElement, card: HTMLElement, on: boolean) {
  sw.setAttribute('aria-checked', String(on))
  card.classList.toggle('bypassed', !on)
}

/**
 * Right-click anywhere on `card`, or a plain click on its `title` (not a drag, not on a shut chain, where a click opens
 * the chain), offers a delete entry (after any `extra` ones).
 */
export function cardMenu(card: HTMLElement, head: HTMLElement, title: HTMLElement, label: string, run: () => void, extra: [string, () => void][] = []) {
  deleteMenu(card, label, run, extra)
  let down: { x: number; y: number; onTitle: boolean; closing: boolean } | null = null
  head.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, onTitle: e.button === 0 && e.target === title, closing: closedBy(e) }
  })
  head.addEventListener('click', (e) => {
    if (!down?.onTitle || down.closing || card.closest('.collapsed')) return
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
    popover(title, [...extra, [label, run]], [e.clientX, e.clientY])
  })
}
