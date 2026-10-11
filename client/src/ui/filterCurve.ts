// The simple filter's response curve, and an XY pad on it: a node at the cutoff, dragged sideways for cutoff and
// up/down for resonance (damping), or for gain on a bell and shelves. The wheel sets damping (Q) on those.
import { dampingAtNodeDb, filterHasGain, filterNodeDb, filterResponseDb, type FilterSettings } from '@mobdaw/shared'

const W = 184
const H = 56
const HZ_MIN = 20
const HZ_MAX = 20000
const DB_MIN = -24
const DB_MAX = 24
const STEPS = 96
const NS = 'http://www.w3.org/2000/svg'

const xOf = (hz: number) => (Math.log(hz / HZ_MIN) / Math.log(HZ_MAX / HZ_MIN)) * W
const yOf = (db: number) => ((DB_MAX - Math.min(DB_MAX, Math.max(DB_MIN, db))) / (DB_MAX - DB_MIN)) * H
const hzOf = (x: number) => HZ_MIN * (HZ_MAX / HZ_MIN) ** Math.min(1, Math.max(0, x / W))

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

export type FilterChange = { cutoff?: number; damping?: number; gain?: number }
/** Params that automation drives: the curve can't move them. */
export type FilterLocks = { cutoff: boolean; damping: boolean; gain: boolean }

export type CurveOpts = {
  /** The pointer or wheel is changing these (only params that are free) live. */
  move(change: FilterChange): void
  /** Pointer released (or the wheel went quiet) after at least one move. */
  end(): void
}

export function filterCurve(opts: CurveOpts) {
  const grid = svg('path', { class: 'grid' })
  grid.setAttribute('d', [100, 1000, 10000].map((f) => `M${xOf(f).toFixed(1)} 0V${H}`).join('') + `M0 ${yOf(0)}H${W}`)
  const resp = svg('path', { class: 'resp' })
  const node = svg('circle', { class: 'node', r: 4 })
  const read = svg('text', { class: 'read', x: W - 4, y: 10, 'text-anchor': 'end' })
  const el = svg('svg', { class: 'fcurve', viewBox: `0 0 ${W} ${H}` })
  el.append(grid, resp, node, read)

  let f: FilterSettings = { mode: 0, cutoff: 1000, damping: 0.7071, gain: 0 }
  let locks: FilterLocks = { cutoff: false, damping: false, gain: false }
  let dragging = false
  /** The param the node's height sets. */
  const yLocked = () => (filterHasGain(f.mode) ? locks.gain : locks.damping)

  function draw(settings: FilterSettings, lock: FilterLocks) {
    f = settings
    locks = lock
    let d = ''
    for (let i = 0; i <= STEPS; i++) {
      const hz = HZ_MIN * (HZ_MAX / HZ_MIN) ** (i / STEPS)
      d += `${i ? 'L' : 'M'}${((i / STEPS) * W).toFixed(1)} ${yOf(filterResponseDb(f, hz)).toFixed(1)}`
    }
    resp.setAttribute('d', d)
    node.setAttribute('cx', xOf(f.cutoff).toFixed(1))
    node.setAttribute('cy', yOf(filterNodeDb(f)).toFixed(1))
    el.classList.toggle('locked', locks.cutoff && yLocked())
  }

  let moved = false
  function point(e: PointerEvent) {
    const r = el.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    const y = ((e.clientY - r.top) / r.height) * H
    const db = DB_MAX - (y / H) * (DB_MAX - DB_MIN)
    const change: FilterChange = {}
    if (!locks.cutoff) change.cutoff = hzOf(x)
    if (!yLocked()) {
      if (filterHasGain(f.mode)) change.gain = Math.min(DB_MAX, Math.max(DB_MIN, db))
      else change.damping = Math.min(2, Math.max(0.05, dampingAtNodeDb(f.mode, db)))
    }
    opts.move(change)
    moved = true
  }
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (locks.cutoff && yLocked())) return
    dragging = true
    el.setPointerCapture(e.pointerId)
    point(e)
  })
  el.addEventListener('pointermove', (e) => dragging && point(e))
  function finish() {
    dragging = false
    read.textContent = ''
    if (moved) opts.end()
    moved = false
  }
  el.addEventListener('pointerup', finish)
  el.addEventListener('pointercancel', finish)

  // Wheel: damping (Q), which the node's own height doesn't set on a bell or shelf. A burst of ticks is one change.
  let wheelEnd = 0
  el.addEventListener('wheel', (e) => {
    if (locks.damping || dragging) return
    e.preventDefault()
    opts.move({ damping: Math.min(2, Math.max(0.05, f.damping * Math.exp(e.deltaY * 0.002))) }) // (the card redraws, updating `f`)
    moved = true
    clearTimeout(wheelEnd)
    wheelEnd = window.setTimeout(finish, 300)
  }, { passive: false })

  return {
    el,
    draw,
    /** While true the card must not overwrite what the pointer is setting. */
    get dragging() { return dragging },
    /** A short readout in the corner of the plot while dragging. */
    readout(text: string) { read.textContent = text },
  }
}
