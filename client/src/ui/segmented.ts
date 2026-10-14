// A small segmented "slide switch": a pill with one equal-width option per value and a highlight that slides under the
// active one. Arrow keys move the choice (radiogroup semantics); the highlight is pure CSS (--n options, --i active index).
export type Seg = { el: HTMLElement; set(v: string): void; get(): string }

export function segmented(options: { value: string; label: string }[], value: string, onChange?: (v: string) => void, title = ''): Seg {
  const el = document.createElement('div')
  el.className = 'seg'
  el.setAttribute('role', 'radiogroup')
  if (title) el.title = title
  el.style.setProperty('--n', String(options.length))
  const thumb = document.createElement('i')
  thumb.className = 'seg-thumb'
  el.append(thumb)
  let cur = value
  const btns = options.map((o) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.setAttribute('role', 'radio')
    b.textContent = o.label
    b.onclick = () => pick(o.value)
    el.append(b)
    return [o.value, b] as const
  })
  function draw() {
    el.style.setProperty('--i', String(Math.max(0, btns.findIndex(([v]) => v === cur))))
    for (const [v, b] of btns) {
      b.classList.toggle('on', v === cur)
      b.setAttribute('aria-checked', String(v === cur))
      b.tabIndex = v === cur ? 0 : -1
    }
  }
  function pick(v: string) {
    if (v === cur) return
    cur = v
    draw()
    onChange?.(v)
  }
  el.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!d) return
    e.preventDefault()
    e.stopPropagation() // (not the editor's own arrow keys: nudge / transpose)
    const i = btns.findIndex(([v]) => v === cur)
    const [v, b] = btns[(i + d + btns.length) % btns.length]
    pick(v)
    b.focus()
  })
  draw()
  return { el, set: (v) => { cur = v; draw() }, get: () => cur }
}
