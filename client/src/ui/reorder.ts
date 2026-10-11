// Drag a card by its title bar to move it within its row of sibling cards. The card follows the pointer (a transform; the
// DOM order is left alone, so redraws don't fight it) and the card it would land before shows a bar on that edge.
// Nothing is written until the drop.
const THRESHOLD = 4 // px before a press becomes a drag

export type ReorderDeps = {
  /** The drag began: let the rest of the UI simplify itself (e.g. split merged views). */
  start(): void
  /** Dropped before the card `beforeId`, or last when null. Only called when that changes the order. */
  drop(beforeId: string | null): void
  /** The drag is over, dropped or not. */
  end(): void
}

/** `card` and its siblings are marked with `data-device`. */
export function dragToReorder(handle: HTMLElement, card: HTMLElement, deps: ReorderDeps) {
  handle.style.cursor = 'grab'
  let from: { x: number; y: number; id: number } | null = null
  let dragging = false
  let before: HTMLElement | null = null
  let marked: HTMLElement | null = null

  const siblings = () => [...(card.parentElement?.children ?? [])].filter((c): c is HTMLElement => c !== card && c instanceof HTMLElement && !!c.dataset.device)
  const mark = (el: HTMLElement | null, cls: string) => {
    marked?.classList.remove('drop-before', 'drop-after')
    marked = el
    el?.classList.add(cls)
  }

  /** The sibling the card would go in front of (null: at the end) for a pointer at (x, y). */
  function target(x: number, y: number) {
    const sibs = siblings()
    let best = -1
    let bestD = Infinity
    sibs.forEach((s, i) => {
      const r = s.getBoundingClientRect()
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0
      const d = dx * dx + dy * dy * 4 // rows wrap, so being on the right row matters most
      if (d < bestD) [best, bestD] = [i, d]
    })
    if (best < 0) return null
    const r = sibs[best].getBoundingClientRect()
    return x < r.left + r.width / 2 ? sibs[best] : (sibs[best + 1] ?? null)
  }

  function finish(drop: boolean) {
    if (!from) return
    const was = dragging
    from = null
    dragging = false
    card.classList.remove('reordering')
    card.style.transform = ''
    mark(null, '')
    removeEventListener('keydown', onKey)
    if (!was) return
    // dropping where it already is changes nothing
    const noop = before === card.nextElementSibling
    if (drop && !noop) deps.drop(before?.dataset.device ?? null)
    before = null
    deps.end()
  }
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && finish(false)

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, select')) return
    from = { x: e.clientX, y: e.clientY, id: e.pointerId }
    handle.setPointerCapture(e.pointerId)
  })
  handle.addEventListener('pointermove', (e) => {
    if (!from) return
    const dx = e.clientX - from.x
    const dy = e.clientY - from.y
    if (!dragging) {
      if (Math.hypot(dx, dy) < THRESHOLD) return
      dragging = true
      card.classList.add('reordering')
      addEventListener('keydown', onKey)
      deps.start()
    }
    card.style.transform = `translate(${dx}px, ${dy}px)`
    before = target(e.clientX, e.clientY)
    const sibs = siblings()
    if (before) mark(before, 'drop-before')
    else mark(sibs.at(-1) ?? null, 'drop-after')
  })
  handle.addEventListener('pointerup', () => finish(true))
  handle.addEventListener('pointercancel', () => finish(false))
}
