import { h } from '../dom'

/** A small menu next to `anchor`; closes on pick, outside click or Escape. */
export function popover(anchor: HTMLElement, items: [label: string, run: () => void][]) {
  const close = () => {
    menu.remove()
    removeEventListener('pointerdown', away, true)
    removeEventListener('keydown', esc, true)
  }
  const away = (e: Event) => menu.contains(e.target as Node) || close()
  const esc = (e: KeyboardEvent) => e.key === 'Escape' && close()
  const menu = h('div', { className: 'popover' },
    ...items.map(([label, run]) => h('button', { onclick: () => (close(), run()) }, label)))
  const r = anchor.getBoundingClientRect()
  menu.style.left = `${r.left}px`
  menu.style.top = `${r.bottom + 2}px`
  document.body.append(menu)
  addEventListener('pointerdown', away, true)
  addEventListener('keydown', esc, true)
}
