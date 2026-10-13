// Finger dragging for range inputs. The sliders are `touch-action: none` so a touch on one can never become a scroll, and
// iOS's native slider drag does not run under that, so the drag is done here: the value follows the finger and the input's
// own `input` / `change` events fire as if it were native, so every slider's handlers work unchanged.
const GRAB = 18 // px: a touch this close to the thumb picks it up in place; elsewhere on the track the thumb jumps to the finger

let active: { el: HTMLInputElement; id: number; offset: number } | null = null

const frac = (el: HTMLInputElement) => {
  const range = Number(el.max) - Number(el.min) || 1
  return (Number(el.value) - Number(el.min)) / range
}
const fracAt = (el: HTMLInputElement, x: number) => {
  const r = el.getBoundingClientRect()
  return (x - r.left) / (r.width || 1)
}

function setFrac(el: HTMLInputElement, f: number) {
  const min = Number(el.min) || 0
  const max = el.max === '' ? 100 : Number(el.max)
  let v = min + Math.min(1, Math.max(0, f)) * (max - min)
  const step = Number(el.step)
  if (el.step !== 'any' && step > 0) v = min + Math.round((v - min) / step) * step
  if (String(v) === el.value) return
  el.value = String(v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

addEventListener('touchstart', (e) => {
  const el = e.target
  if (active || !(el instanceof HTMLInputElement) || el.type !== 'range' || el.disabled || e.touches.length !== 1) return
  const t = e.touches[0]
  e.preventDefault() // no native slider handling, focus or text selection: this module drives it
  const x = t.clientX
  const r = el.getBoundingClientRect()
  const thumb = r.left + frac(el) * r.width
  const offset = Math.abs(x - thumb) <= GRAB ? frac(el) - fracAt(el, x) : 0
  active = { el, id: t.identifier, offset }
  if (offset === 0) setFrac(el, fracAt(el, x))
}, { capture: true, passive: false })

addEventListener('touchmove', (e) => {
  if (!active) return
  const t = [...e.touches].find((c) => c.identifier === active!.id)
  if (!t) return
  e.preventDefault()
  setFrac(active.el, fracAt(active.el, t.clientX) + active.offset)
}, { capture: true, passive: false })

function end(e: TouchEvent) {
  if (!active || ![...e.changedTouches].some((c) => c.identifier === active!.id)) return
  const { el } = active
  active = null
  el.dispatchEvent(new Event('change', { bubbles: true }))
}
addEventListener('touchend', end, { capture: true })
addEventListener('touchcancel', end, { capture: true })
