import { h } from '../dom'

let closer: Event | null = null
/** True if this event is what just closed a popover (so its click shouldn't open another). */
export const closedBy = (e: Event) => closer === e

/** A small menu next to `anchor` (or at viewport point `at`); closes on pick, outside click or Escape. */
export function popover(anchor: HTMLElement, items: [label: string, run: () => void][], at?: [x: number, y: number]) {
  const close = () => {
    menu.remove()
    removeEventListener('pointerdown', away, true)
    removeEventListener('keydown', esc, true)
  }
  const away = (e: Event) => menu.contains(e.target as Node) || ((closer = e), close())
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
  const menu = h('div', { className: 'popover' },
    ...items.map(([label, run]) => h('button', { onclick: () => (close(), run()) }, label)))
  const r = anchor.getBoundingClientRect()
  menu.style.left = `${at ? at[0] : r.left}px`
  menu.style.top = `${at ? at[1] : r.bottom + 2}px`
  document.body.append(menu)
  const m = menu.getBoundingClientRect() // keep it on screen (the chat sits at the right edge)
  if (m.right > innerWidth) menu.style.left = `${Math.max(0, innerWidth - m.width)}px`
  if (m.bottom > innerHeight) menu.style.top = `${Math.max(0, innerHeight - m.height)}px`
  addEventListener('pointerdown', away, true)
  addEventListener('keydown', esc, true)
}

/** Right-click on `el` offers a single delete entry. `run` is skipped (no menu) when `enabled` says no. */
export function deleteMenu(el: HTMLElement, label: string, run: () => void, enabled: () => boolean = () => true) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation() // not the lane's background menu underneath
    if (enabled()) popover(el, [[label, run]], [e.clientX, e.clientY])
  })
}
