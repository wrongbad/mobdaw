// The response curve of a run of adjacent filters, and an XY pad on it. One view serves the whole run: it is as wide as
// the run's cards, and each filter is a node at its cutoff riding the combined curve. Drag a node sideways for cutoff
// and up/down for resonance (damping), or for gain on a bell and shelves; the wheel over the plot sets the nearest
// node's damping (Q).
import { dampingAtNodeDb, filterHasGain, filterNodeDb, filterResponseDb, type FilterSettings } from '@mobdaw/shared'

/** One colour per filter of a run (in chain order), shared by the card's title and its node. A lone filter has none. */
export const FILTER_COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#b388ff', '#ff9f68']

/** Width of one card; the view is this wide per filter in the run. */
export const CARD_W = 200
const H = 56
const HZ_MIN = 20
const HZ_MAX = 20000
const DB_MIN = -24
const DB_MAX = 24
const STEPS_PER_CARD = 96
const NS = 'http://www.w3.org/2000/svg'

const yOf = (db: number) => ((DB_MAX - Math.min(DB_MAX, Math.max(DB_MIN, db))) / (DB_MAX - DB_MIN)) * H

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

/** Params that automation drives (or a read-only viewer): the curve can't move them. */
export type FilterLocks = { cutoff: boolean; damping: boolean; gain: boolean }
export type FilterChange = { cutoff?: number; damping?: number; gain?: number }
/** A filter of the run as the curve sees it; a bypassed one is drawn dim and adds nothing to the response. */
export type FilterMember = FilterSettings & {
  id: string
  bypass: boolean
  locks: FilterLocks
  /** The card's top in its (wrapping) chain: a run only shares a view across the cards on one row. */
  row: number
}

export type CurveOpts = {
  /** The pointer or wheel is changing these params (only the free ones) of filter `id`, live. */
  move(id: string, change: FilterChange): void
  /** The gesture on `id` ended (pointer released, or the wheel went quiet) after at least one move. */
  end(id: string): void
}

const hzText = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(2)} khz` : `${Math.round(hz)} hz`)

export function filterCurve(opts: CurveOpts) {
  const grid = svg('path', { class: 'grid' })
  const bands = svg('g', { class: 'bands' })
  const resp = svg('path', { class: 'resp' })
  const nodes = svg('g', { class: 'nodes' })
  const read = svg('text', { class: 'read', y: 10, 'text-anchor': 'end' })
  const el = svg('svg', { class: 'fcurve', height: H })
  el.append(grid, bands, resp, nodes, read)

  let members: FilterMember[] = []
  let colors: (string | null)[] = []
  let W = CARD_W
  const xOf = (hz: number) => (Math.log(hz / HZ_MIN) / Math.log(HZ_MAX / HZ_MIN)) * W
  const hzOf = (x: number) => HZ_MIN * (HZ_MAX / HZ_MIN) ** Math.min(1, Math.max(0, x / W))
  /** Whether the param that a node's height sets is locked. */
  const yLocked = (m: FilterMember) => (filterHasGain(m.mode) ? m.locks.gain : m.locks.damping)
  const stuck = (m: FilterMember) => m.locks.cutoff && yLocked(m)
  /** What every active filter but `skip` adds at `hz`, in dB. */
  const sumDb = (hz: number, skip = -1) => members.reduce((s, m, i) => (i === skip || m.bypass ? s : s + filterResponseDb(m, hz)), 0)
  /** A node's height: its own level on top of whatever else sounds at its frequency. */
  const nodeY = (i: number) => {
    const m = members[i]
    return yOf(m.bypass ? sumDb(m.cutoff) : sumDb(m.cutoff, i) + filterNodeDb(m))
  }

  let active = -1 // the node being dragged
  let moved = false

  /** `colors`: each filter's colour (null: the default), alongside `next`. */
  function draw(next: FilterMember[], nextColors: (string | null)[] = []) {
    members = next
    colors = nextColors
    W = CARD_W * Math.max(1, members.length)
    el.setAttribute('viewBox', `0 0 ${W} ${H}`)
    el.setAttribute('width', String(W))
    grid.setAttribute('d', [100, 1000, 10000].map((f) => `M${xOf(f).toFixed(1)} 0V${H}`).join('') + `M0 ${yOf(0)}H${W}`)
    const path = (db: (hz: number) => number) => {
      const steps = STEPS_PER_CARD * members.length
      let d = ''
      for (let i = 0; i <= steps; i++) {
        const hz = HZ_MIN * (HZ_MAX / HZ_MIN) ** (i / steps)
        d += `${i ? 'L' : 'M'}${((i / steps) * W).toFixed(1)} ${yOf(db(hz)).toFixed(1)}`
      }
      return d
    }
    resp.setAttribute('d', path((hz) => sumDb(hz)))
    // each filter alone, faint, when there is more than one to tell apart
    bands.replaceChildren(...(members.length > 1 ? members.filter((m) => !m.bypass).map((m) => svg('path', { class: 'band', d: path((hz) => filterResponseDb(m, hz)), style: colors[members.indexOf(m)] ? `--c:${colors[members.indexOf(m)]}` : '' })) : []))
    nodes.replaceChildren(...members.map((m, i) => svg('circle', {
      class: `node${m.bypass ? ' off' : ''}${i === active ? ' on' : ''}${stuck(m) ? ' stuck' : ''}`,
      r: 4, cx: xOf(m.cutoff).toFixed(1), cy: nodeY(i).toFixed(1), style: colors[i] ? `--c:${colors[i]}` : '',
    })))
    read.setAttribute('x', String(W - 4))
    const m = members[active]
    const g = m?.gain ?? 0
    read.textContent = m ? `${hzText(m.cutoff)} · ${filterHasGain(m.mode) ? `${g > 0 ? '+' : ''}${g.toFixed(1)} db` : `damping ${m.damping.toFixed(2)}`}` : ''
    el.classList.toggle('locked', members.every(stuck))
  }

  /** The node to take at (x, y): the nearest, ignoring any that can't move. */
  function pick(x: number, y: number) {
    let best = -1
    let bestD = Infinity
    members.forEach((m, i) => {
      if (stuck(m)) return
      const dx = x - xOf(m.cutoff)
      const dy = y - nodeY(i)
      const d = dx * dx + dy * dy
      if (d < bestD) [best, bestD] = [i, d]
    })
    return best
  }
  const local = (e: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }

  function point(e: PointerEvent) {
    const m = members[active]
    if (!m) return
    const { x, y } = local(e)
    const hz = m.locks.cutoff ? m.cutoff : hzOf(x)
    // the pointer's height is where the *combined* curve should be: this filter supplies what the others leave
    const db = DB_MAX - (y / H) * (DB_MAX - DB_MIN) - sumDb(hz, active)
    const change: FilterChange = {}
    if (!m.locks.cutoff) change.cutoff = hz
    if (!yLocked(m)) {
      if (filterHasGain(m.mode)) change.gain = Math.min(DB_MAX, Math.max(DB_MIN, db))
      else change.damping = Math.min(2, Math.max(0.05, dampingAtNodeDb(m.mode, db)))
    }
    moved = true
    opts.move(m.id, change)
  }
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const { x, y } = local(e)
    active = pick(x, y)
    if (active < 0) return
    el.setPointerCapture(e.pointerId)
    point(e)
  })
  el.addEventListener('pointermove', (e) => active >= 0 && point(e))
  function finish() {
    const m = members[active]
    active = -1
    if (m && moved) opts.end(m.id)
    moved = false
    draw(members, colors)
  }
  el.addEventListener('pointerup', finish)
  el.addEventListener('pointercancel', finish)

  // Wheel: the nearest node's damping (Q), which a bell's or shelf's own height doesn't set. A burst of ticks is one change.
  let wheelEnd = 0
  el.addEventListener('wheel', (e) => {
    if (active >= 0 && !wheeling) return
    const { x, y } = local(e)
    const i = wheeling ? active : pick(x, y)
    const m = members[i]
    if (!m || m.locks.damping) return
    e.preventDefault()
    active = i
    wheeling = true
    moved = true
    opts.move(m.id, { damping: Math.min(2, Math.max(0.05, m.damping * Math.exp(e.deltaY * 0.002))) })
    clearTimeout(wheelEnd)
    wheelEnd = window.setTimeout(() => { wheeling = false; finish() }, 300)
  }, { passive: false })
  let wheeling = false

  return {
    el,
    draw,
    /** The index of the node the pointer holds, or -1. While held the cards must not overwrite what the pointer sets. */
    get dragging() { return active >= 0 },
  }
}
