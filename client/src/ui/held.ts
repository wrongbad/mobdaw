// Whether the user is working a control right now, so a repaint from the document doesn't snap it back mid-drag.
// `document.activeElement` is not enough: iOS Safari never focuses a range input, so a slider under a finger is not "active".
let touched: EventTarget | null = null
const down = (e: Event) => (touched = e.target)
const up = () => (touched = null)
document.addEventListener('pointerdown', down, true)
document.addEventListener('touchstart', down, { capture: true, passive: true })
for (const t of ['pointerup', 'pointercancel', 'touchend', 'touchcancel']) document.addEventListener(t, up, true)

/** The element has focus, or a finger / pointer is down on it. */
export const inUse = (el: Element) => document.activeElement === el || touched === el
