import { h } from '../dom'
import { icon, type IconName } from '../theme/icons'

let closer: Event | null = null
/** The gap kept between a popover and the window's edges. */
const EDGE = 8
/** True if this event is what just closed a popover (so its click shouldn't open another). */
export const closedBy = (e: Event) => closer === e

/**
 * Show `menu` next to `anchor` (or at viewport point `at`); it closes on an outside press or Escape. A press on the
 * anchor itself that closes it also swallows the click that follows, so clicking a button again hides its menu
 * instead of re-opening it. Returns the function that closes it.
 */
function showMenu(anchor: HTMLElement, menu: HTMLElement, at?: [x: number, y: number]) {
  const close = () => {
    menu.remove()
    removeEventListener('pointerdown', away, true)
    removeEventListener('keydown', esc, true)
  }
  const away = (e: Event) => {
    if (menu.contains(e.target as Node)) return
    closer = e
    close()
    if (at || (e as PointerEvent).button !== 0 || !anchor.contains(e.target as Node)) return
    const swallow = (c: Event) => (c.stopPropagation(), c.preventDefault(), done())
    const done = () => (removeEventListener('click', swallow, true), clearTimeout(timer))
    const timer = setTimeout(done, 1000) // (the press may never become a click)
    addEventListener('click', swallow, true)
  }
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
  const r = anchor.getBoundingClientRect()
  // measured at the left edge first (so its width is not squeezed by the window's right edge), then placed
  menu.style.left = '0px'
  menu.style.top = '0px'
  menu.style.maxWidth = `${innerWidth - 2 * EDGE}px`
  document.body.append(menu)
  const m = menu.getBoundingClientRect()
  // anchored in the right half: line the menu up with the anchor's right edge instead
  let x = at ? at[0] : r.left + r.width / 2 > innerWidth / 2 ? r.right - m.width : r.left
  let y = at ? at[1] : r.bottom + 4
  // keep it on screen, a little in from the edges (the chat sits at the right edge)
  x = Math.max(EDGE, Math.min(x, innerWidth - m.width - EDGE))
  if (y + m.height > innerHeight - EDGE) y = Math.max(EDGE, innerHeight - m.height - EDGE)
  menu.style.left = `${x}px`
  menu.style.top = `${y}px`
  addEventListener('pointerdown', away, true)
  addEventListener('keydown', esc, true)
  return close
}

/** A menu entry: a `[label, run]` pair, a richer item, or `'sep'` for a divider. */
export type MenuItem =
  | [label: string, run: () => void]
  | { label: string; run: () => void; icon?: IconName; danger?: boolean; disabled?: boolean; title?: string; hint?: string }
  | 'sep'

/** A small menu next to `anchor` (or at viewport point `at`); closes on pick, outside click or Escape. Arrow keys move. */
export function popover(anchor: HTMLElement, items: MenuItem[], at?: [x: number, y: number]) {
  const menu = h('div', { className: 'popover', role: 'menu' },
    ...items.map((it) => {
      if (it === 'sep') return h('div', { className: 'sep', role: 'separator' })
      const o = Array.isArray(it) ? { label: it[0], run: it[1] } as Exclude<MenuItem, 'sep' | unknown[]> : it
      const b = h('button', { className: o.danger ? 'danger' : undefined, role: 'menuitem', disabled: o.disabled, title: o.title, onclick: () => (close(), o.run()) })
      if (o.icon) b.append(icon(o.icon))
      b.append(h('span', {}, o.label))
      if (o.hint) b.append(h('span', { className: 'kbd-hint' }, o.hint))
      return b
    }))
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const i = btns.indexOf(document.activeElement as HTMLButtonElement)
    const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!d || !btns.length) return
    e.preventDefault()
    btns[(i + d + btns.length) % btns.length].focus()
  })
  const close = showMenu(anchor, menu, at)
  // keyboard users land on the first entry
  if (anchor.matches(':focus-visible')) menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  return close
}

/** Like `popover`, but with arbitrary content. Returns the function that closes it again. */
export function popoverPanel(anchor: HTMLElement, content: HTMLElement) {
  return showMenu(anchor, h('div', { className: 'popover panel' }, content))
}

/** Right-click on `el` offers a delete entry (after any `extra` ones). `run` is skipped (no menu) when `enabled` says no. */
export function deleteMenu(el: HTMLElement, label: string, run: () => void, enabled: () => boolean = () => true, extra: MenuItem[] = []) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation() // not the lane's background menu underneath
    if (enabled()) popover(el, [...extra, [label, run]], [e.clientX, e.clientY])
  })
}
