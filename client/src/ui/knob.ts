// A small rotary knob (after the redesign fork's theme/controls.ts): drag up / down (shift = fine), double-click or
// double-tap to reset, wheel, arrow keys. `onInput` fires while it moves, `onChange` once when the gesture ends.
const NS = 'http://www.w3.org/2000/svg'
const ARC = 135 // degrees either side of 12 o'clock
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const polar = (r: number, deg: number) => [20 + r * Math.sin((deg * Math.PI) / 180), 20 - r * Math.cos((deg * Math.PI) / 180)]
const arc = (r: number, a0: number, a1: number) => {
  if (Math.abs(a1 - a0) < 0.01) a1 = a0 + 0.01
  const [x0, y0] = polar(r, Math.min(a0, a1)), [x1, y1] = polar(r, Math.max(a0, a1))
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

export type KnobOpts = {
  min: number; max: number; value: number; def: number
  size?: number; title?: (v: number) => string; disabled?: boolean
  onStart?(): void; onInput?(v: number): void; onChange?(v: number): void
}

export function knob(o: KnobOpts) {
  let value = o.value
  let disabled = !!o.disabled
  let active = false
  const pos = (v: number) => (v - o.min) / (o.max - o.min)
  const mid = pos(o.def) * 2 * ARC - ARC
  const fill = svg('path', { class: 'knob-fill' })
  const pointer = svg('line', { class: 'knob-pointer', x1: 20, y1: 20, x2: 20, y2: 9 })
  const s = svg('svg', { viewBox: '0 0 40 40', width: o.size ?? 22, height: o.size ?? 22, 'aria-hidden': 'true' })
  s.append(svg('path', { class: 'knob-track', d: arc(15, -ARC, ARC) }), fill, svg('circle', { class: 'knob-cap', cx: 20, cy: 20, r: 10 }), pointer)
  const el = document.createElement('div')
  el.className = 'knob'
  el.tabIndex = 0
  el.setAttribute('role', 'slider')
  el.append(s)
  const draw = () => {
    const a = pos(value) * 2 * ARC - ARC
    fill.setAttribute('d', arc(15, mid, a))
    pointer.setAttribute('transform', `rotate(${a.toFixed(1)} 20 20)`)
    el.title = o.title?.(value) ?? String(value)
    el.classList.toggle('disabled', disabled)
    el.setAttribute('aria-valuenow', String(value))
  }
  const move = (v: number) => {
    v = clamp(v, o.min, o.max)
    if (v === value) return
    value = v
    draw()
    o.onInput?.(v)
  }
  const reset = () => {
    o.onStart?.()
    move(o.def)
    o.onChange?.(value)
  }
  let lastDown = 0
  el.addEventListener('pointerdown', (e) => {
    if (disabled || e.button !== 0) return
    e.preventDefault() // no text selection, no focus theatrics, no touch scroll
    if (e.timeStamp - lastDown < 320) { lastDown = 0; return reset() } // double-click / double-tap
    lastDown = e.timeStamp
    const y0 = e.clientY, v0 = pos(value), before = value
    active = true
    el.classList.add('active')
    o.onStart?.()
    el.setPointerCapture(e.pointerId)
    const onMove = (m: PointerEvent) => move(o.min + clamp(v0 + ((y0 - m.clientY) / (m.shiftKey ? 640 : 160)), 0, 1) * (o.max - o.min))
    const end = () => {
      active = false
      el.classList.remove('active')
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      if (value !== before) o.onChange?.(value)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
  })
  el.addEventListener('wheel', (e) => {
    if (disabled) return
    e.preventDefault()
    o.onStart?.()
    move(value - Math.sign(e.deltaY || -e.deltaX) * (e.shiftKey ? 0.004 : 0.02) * (o.max - o.min))
  }, { passive: false })
  el.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -1 : 0
    if (disabled || !d) return
    e.preventDefault()
    e.stopPropagation()
    o.onStart?.()
    move(value + d * (e.shiftKey ? 0.1 : 0.01) * (o.max - o.min))
  })
  draw()
  return {
    el,
    set(v: number) { if (active) return void 0; value = clamp(v, o.min, o.max); draw() },
    setDisabled(d: boolean) { disabled = d; draw() },
  }
}
