// Long-press to pick something up. A mouse (or pen) starts a drag the moment it is pressed. A finger can't: a touch that
// moves is the page scrolling, so a drag only begins after the finger has rested on the thing for HOLD_MS. Moving
// before that leaves the touch to the browser (scroll); lifting before that is a tap.
const HOLD_MS = 350
const SLOP = 8 // px a resting finger may wander and still be a long press
const lifted = new WeakSet<Event>()

/** Whether a long press has already picked this press up (so a drag started from it needn't wait again). */
export const isLifted = (e: Event) => lifted.has(e)

/**
 * Call `run` when `e` (a pointerdown, handled synchronously) should start its drag: at once for a mouse, after a long
 * press for touch. `abort` is called instead for a touch that never became one: `'tap'` (released first) or `'moved'`
 * (the finger travelled, i.e. a scroll or swipe).
 */
export function lift(e: PointerEvent, run: () => void, abort?: (why: 'tap' | 'moved') => void) {
  if (e.pointerType !== 'touch' || lifted.has(e)) return run()
  const el = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
  const { clientX: x0, clientY: y0, pointerId } = e
  const stop = () => {
    clearTimeout(timer)
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', up)
    removeEventListener('pointercancel', up)
  }
  const move = (m: PointerEvent) => {
    if (m.pointerId !== pointerId || Math.hypot(m.clientX - x0, m.clientY - y0) <= SLOP) return
    stop()
    abort?.('moved')
  }
  const up = (m: PointerEvent) => {
    if (m.pointerId !== pointerId) return
    stop()
    abort?.(m.type === 'pointerup' ? 'tap' : 'moved')
  }
  const timer = window.setTimeout(() => {
    stop()
    lifted.add(e)
    el?.classList.add('lifted')
    navigator.vibrate?.(12) // (not on iOS)
    // From here the finger drags the thing: keep the browser from turning the move into a scroll.
    const block = (t: TouchEvent) => t.cancelable && t.preventDefault()
    const done = (u: PointerEvent) => {
      if (u.pointerId !== pointerId) return
      removeEventListener('touchmove', block)
      removeEventListener('pointerup', done)
      removeEventListener('pointercancel', done)
      el?.classList.remove('lifted')
    }
    addEventListener('touchmove', block, { passive: false })
    addEventListener('pointerup', done)
    addEventListener('pointercancel', done)
    run()
  }, HOLD_MS)
  addEventListener('pointermove', move)
  addEventListener('pointerup', up)
  addEventListener('pointercancel', up)
}
