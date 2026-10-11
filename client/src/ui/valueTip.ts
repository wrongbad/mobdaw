// A floating value readout for a slider: shown above the thumb while hovering or dragging, fed by the `out` element's text.
import { h } from '../dom'

let tip: HTMLElement | null = null

/** `out`: an element whose text is the readout (watched for changes), or a function giving it from the slider's current value. */
export function valueTip(input: HTMLInputElement, out: HTMLElement | (() => string)) {
  let hover = false
  let drag = false
  const place = () => {
    if (!tip) return
    const r = input.getBoundingClientRect()
    const frac = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min) || 1)
    tip.textContent = typeof out === 'function' ? out() : out.textContent
    tip.style.left = `${r.left + 2 + frac * (r.width - 4)}px`
    tip.style.top = `${r.top}px`
  }
  const sync = () => {
    const on = hover || drag
    if (on && !tip) tip = document.body.appendChild(h('div', { className: 'value-tip' }))
    if (!on) { tip?.remove(); tip = null }
    else place()
  }
  input.addEventListener('pointerenter', () => { hover = true; sync() })
  input.addEventListener('pointerleave', () => { hover = false; sync() })
  input.addEventListener('pointerdown', () => {
    drag = true
    sync()
    const up = () => { drag = false; removeEventListener('pointerup', up); removeEventListener('pointercancel', up); sync() }
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  })
  input.addEventListener('input', () => hover || drag ? place() : undefined)
  // lane-driven values and remote drags change the text without any input event
  if (typeof out !== 'function') new MutationObserver(() => (hover || drag) && place()).observe(out, { childList: true, characterData: true, subtree: true })
}
