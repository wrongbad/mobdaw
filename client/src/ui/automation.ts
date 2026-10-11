// Automation UI: the "Automate" menu on a param's label, and one lane's editor (a header cell plus a
// drawing surface). The sections that hold the lanes belong to the timeline.
//   click empty space   add a point (and drag it)         shift-drag    draw freehand
//   drag a point        move it                           right-click a point   delete it / make its segment a step or a line
// Points are stored normalised (0..1 of the param's own scale), so the line drawn is the curve that plays.
// A lane's header menu picks Disabled / Keyframes / LFO. In LFO mode the keyframes are kept but not read, the
// header shows the wave's shape, rate and depth, and the surface draws the wave around the param's own value.
import * as Y from 'yjs'
import {
  LFO_DEFAULTS, LFO_RATE_MAX, LFO_RATE_MIN, LFO_SHAPES, addPoint, deleteLane, deletePoint, laneState, lfoWave, pointsMap, setLaneState, updateLaneLfo, updatePoint,
  type AutoCurve, type Lane, type LaneState, type ParamDef, type Point,
} from '@mobdaw/shared'
import { h } from '../dom'
import { clamp, dragPointer } from './blocks'
import { popover } from './popover'

export const AUTO_H = 64
const LFO_H = 96 // an LFO lane is taller: its header stacks the mode, rate and depth rows (matches .auto-row.lfo)
const PAD = 7 // the top and bottom of the surface stay reachable: 0 and 1 sit this far from the edges
const NS = 'http://www.w3.org/2000/svg'
const FREEHAND_PX = 10

/** An automated param as its control shows it: the lane is driving it (`on`), `value` being what it reads at the playhead. */
export type AutoInfo = { on: boolean; value: number | null }
export const NO_AUTO = new Map<string, AutoInfo>()

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

// --- the label menu
export type AutoMenu = {
  /** 'none': no lane yet; 'on': a lane drives the param; 'off': a disabled lane. */
  state(): 'none' | 'on' | 'off'
  automate(): void
  /** Automate it with an LFO (the lane starts in LFO mode). */
  lfo(): void
  show(): void
  toggle(): void
  remove(): void
}

/** Left or right click on a param's name offers Automate (or, once it has a lane, show / disable / delete it). */
export function automateMenu(label: HTMLElement, m: AutoMenu, readOnly: boolean) {
  label.classList.add('automatable')
  label.title = 'click to automate'
  const open = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation() // not the card's own menu, nor the <label> focusing its control
    const s = m.state()
    const items: [string, () => void][] =
      s === 'none' ? (readOnly ? [] : [['automate', m.automate], ['modulate with lfo', m.lfo]])
        : [['show automation', m.show], ...(readOnly ? [] : [[s === 'on' ? 'disable automation' : 'enable automation', m.toggle], ['delete automation', m.remove]] as [string, () => void][])]
    if (items.length) popover(label, items, [e.clientX, e.clientY])
  }
  label.addEventListener('click', open)
  label.addEventListener('contextmenu', open)
}

// --- one lane
export type RowDeps = {
  doc: Y.Doc
  readOnly: boolean
  /** A drag begins or ends (so it undoes as one step). */
  grab(): void
  /** Timeline sample <-> surface pixel, at the current zoom. */
  x(smp: number): number
  fromX(px: number): number
  /** Samples per second (an LFO's phase is `position / rate * hz`). */
  rate: number
}
export type RowView = {
  def: ParamDef
  /** Header text, e.g. "loop 1 · volume". */
  label: string
  color: string
  /** The param's static (un-automated) value, drawn as a dashed line while the lane has no points. */
  value: number
  /** Surface width in px. */
  width: number
}

const yOf = (v: number, h = AUTO_H) => PAD + (1 - v) * (h - 2 * PAD)

export function autoRow(deps: RowDeps) {
  const { doc, readOnly } = deps
  let lane!: Lane
  let pts: Point[] = []
  let view!: RowView
  let sig = ''

  const name = h('span', { className: 'name' })
  const modes: [LaneState, string][] = [['off', 'disabled'], ['keyframes', 'keyframes'], ['lfo', 'lfo']]
  const mode = h('select', { className: 'auto-mode', title: 'what drives the parameter', onchange: () => setLaneState(doc, lane.id, mode.value as LaneState) },
    ...modes.map(([v, t]) => h('option', { value: v }, t)))
  const del = h('button', { className: 'x', title: 'delete automation', onclick: () => deleteLane(doc, lane.id) }, '×')
  mode.disabled = readOnly

  // LFO controls, shown in LFO mode. The slider positions are 0..1; rate is logarithmic.
  const rateToPos = (hz: number) => Math.log(hz / LFO_RATE_MIN) / Math.log(LFO_RATE_MAX / LFO_RATE_MIN)
  const posToRate = (t: number) => LFO_RATE_MIN * (LFO_RATE_MAX / LFO_RATE_MIN) ** t
  const slider = (title: string, onInput: (t: number) => void) => {
    const el = h('input', { type: 'range', min: '0', max: '1', step: 'any', title, disabled: readOnly })
    el.addEventListener('pointerdown', () => deps.grab()) // one drag, one undo step
    el.addEventListener('input', () => onInput(el.valueAsNumber))
    return el
  }
  const shape = h('select', { className: 'auto-shape', title: 'wave shape', hidden: true, onchange: () => updateLaneLfo(doc, lane.id, { shape: Number(shape.value) }) },
    ...LFO_SHAPES.map((t, i) => h('option', { value: String(i) }, t)))
  shape.disabled = readOnly
  const rate = slider('rate', (t) => updateLaneLfo(doc, lane.id, { rate: posToRate(t) }))
  const depth = slider('depth', (t) => updateLaneLfo(doc, lane.id, { depth: t }))
  const lfoRow = (label: string, input: HTMLElement) => h('div', { className: 'ctl lfo-ctl', hidden: true }, h('span', { className: 'lfo-label' }, label), input)
  const lfoRows = [lfoRow('rate', rate), lfoRow('depth', depth)]

  const head = h('div', { className: 'head auto-head' },
    h('div', { className: 'auto-title' }, name, readOnly ? null : del),
    h('div', { className: 'ctl' }, mode, shape),
    ...lfoRows)
  const surface = svg('svg', { class: 'auto-svg', height: AUTO_H })
  const body = h('div', { className: 'lane-body auto-body' })
  body.append(surface)
  const el = h('div', { className: 'lane-row auto-row' }, head, body)

  // pointer -> (timeline sample, normalised value)
  const at = (e: { clientX: number; clientY: number }) => {
    const r = body.getBoundingClientRect()
    const v = clamp(1 - (e.clientY - r.top - PAD) / (AUTO_H - 2 * PAD), 0, 1)
    const n = view.def.max - view.def.min
    return { pos: Math.max(0, deps.fromX(e.clientX - r.left)), value: view.def.options && n > 0 ? Math.round(v * n) / n : v }
  }
  const newCurve = (): AutoCurve => (view.def.options ? 'hold' : 'linear')
  const livePoints = () => [...pointsMap(doc).values()].map((p) => p.toJSON() as Point).filter((p) => p.laneId === lane.id)

  /** Press on empty space: add a point there and carry on dragging it. Shift: draw a line freehand. */
  surface.addEventListener('pointerdown', (e) => {
    if (readOnly || e.button !== 0 || e.target !== surface || laneState(lane) === 'lfo') return
    e.preventDefault()
    deps.grab()
    const first = at(e)
    if (e.shiftKey) {
      let prev = first
      addPoint(doc, lane.id, first.pos, first.value, 'linear')
      dragPointer(e, {
        onDrag: (m) => {
          const q = at(m)
          if (Math.abs(deps.x(q.pos) - deps.x(prev.pos)) < FREEHAND_PX) return
          const [lo, hi] = [Math.min(prev.pos, q.pos), Math.max(prev.pos, q.pos)]
          doc.transact(() => {
            for (const p of livePoints()) if (p.pos > lo && p.pos < hi) deletePoint(doc, p.id) // drawing over a stretch replaces it
            addPoint(doc, lane.id, q.pos, q.value, 'linear')
          })
          prev = q
        },
        onEnd: () => deps.grab(),
      })
      return
    }
    dragPoint(e, addPoint(doc, lane.id, first.pos, first.value, newCurve()))
  })

  function dragPoint(e: PointerEvent, id: string) {
    dragPointer(e, {
      onDrag: (m) => {
        if (!pointsMap(doc).has(id)) return
        const q = at(m)
        updatePoint(doc, id, { pos: q.pos, value: q.value })
      },
      onEnd: () => deps.grab(),
    })
  }

  function pointMenu(e: MouseEvent, p: Point) {
    e.preventDefault()
    e.stopPropagation()
    if (readOnly) return
    const next: AutoCurve = p.curve === 'hold' ? 'linear' : 'hold'
    popover(surface as unknown as HTMLElement, [
      ['delete point', () => deletePoint(doc, p.id)],
      [next === 'hold' ? 'step to next point' : 'line to next point', () => updatePoint(doc, p.id, { curve: next })],
    ], [e.clientX, e.clientY])
  }

  /** `list` must be sorted by position. */
  function update(l: Lane, list: Point[], v: RowView) {
    lane = l
    pts = list
    view = v
    name.textContent = v.label
    name.title = v.label
    const state = laneState(l)
    const lfo = state === 'lfo'
    mode.value = state
    el.classList.toggle('off', state === 'off')
    el.classList.toggle('lfo', lfo)
    shape.hidden = !lfo
    for (const r of lfoRows) r.hidden = !lfo
    surface.setAttribute('height', String(lfo ? LFO_H : AUTO_H))
    const d = { shape: l.shape ?? LFO_DEFAULTS.shape, rate: l.rate ?? LFO_DEFAULTS.rate, depth: l.depth ?? LFO_DEFAULTS.depth }
    if (shape.value !== String(d.shape)) shape.value = String(d.shape)
    if (document.activeElement !== rate) rate.value = String(rateToPos(d.rate))
    if (document.activeElement !== depth) depth.value = String(d.depth)
    rate.title = `rate: ${d.rate < 1 ? d.rate.toFixed(2) : d.rate.toFixed(1)} hz`
    depth.title = `depth: ±${Math.round(d.depth * 100)}% of the slider`
    el.style.setProperty('--c', v.color)
    // the wave is drawn around the param's own value, the keyframes from the points: only what is drawn is in the signature
    const drawn = lfo ? `lfo,${d.shape},${d.rate},${d.depth},${v.value},${deps.rate},${deps.x(deps.rate)}` : pts.length ? pts.map((p) => `${p.id},${p.pos},${p.value},${p.curve}`).join(';') : v.value
    const next = `${v.width}|${state}|${v.color}|${v.def.min}|${v.def.max}|${v.def.scale}|${drawn}`
    if (next === sig) return
    sig = next
    surface.setAttribute('width', String(v.width))
    body.style.width = `${v.width}px`
    surface.replaceChildren(...draw())
  }

  const norm = (value: number) => {
    const d = view.def
    const t = d.scale === 'log' ? Math.log(value / d.min) / Math.log(d.max / d.min) : d.scale === 'pow' ? Math.cbrt((value - d.min) / (d.max - d.min)) : (value - d.min) / (d.max - d.min)
    return clamp(Number.isFinite(t) ? t : 0, 0, 1)
  }

  /** The wave: the param's own value (dashed) with the LFO swinging it by `depth`, sampled every few px. */
  function drawLfo(): SVGElement[] {
    const W = view.width
    const center = norm(view.value)
    const depth = lane.depth ?? LFO_DEFAULTS.depth
    const hz = lane.rate ?? LFO_DEFAULTS.rate
    const shp = lane.shape ?? LFO_DEFAULTS.shape
    const cy = yOf(center, LFO_H)
    let d = ''
    for (let px = 0; px <= W + 2; px += 2) {
      const v = clamp(center + depth * lfoWave((Math.max(0, deps.fromX(px)) / deps.rate) * hz, shp), 0, 1)
      d += `${px ? ' L' : 'M'}${px} ${yOf(v, LFO_H).toFixed(1)}`
    }
    return [
      svg('line', { x1: 0, x2: W, y1: cy, y2: cy, class: 'auto-idle' }),
      svg('path', { d, class: 'auto-line' }),
    ]
  }

  function draw(): SVGElement[] {
    if (laneState(lane) === 'lfo') return drawLfo()
    const W = view.width
    if (!pts.length) { // nothing drawn yet: the static value, dashed
      const y = yOf(norm(view.value))
      return [svg('line', { x1: 0, x2: W, y1: y, y2: y, class: 'auto-idle' })]
    }
    const xs = pts.map((p) => deps.x(p.pos))
    const ys = pts.map((p) => yOf(p.value))
    let d = `M0 ${ys[0]} L${xs[0]} ${ys[0]}`
    for (let i = 0; i < pts.length - 1; i++) d += pts[i].curve === 'hold' ? ` L${xs[i + 1]} ${ys[i]} L${xs[i + 1]} ${ys[i + 1]}` : ` L${xs[i + 1]} ${ys[i + 1]}`
    d += ` L${Math.max(W, xs.at(-1)!)} ${ys.at(-1)}`
    const kids: SVGElement[] = [
      svg('path', { d: `${d} L${Math.max(W, xs.at(-1)!)} ${AUTO_H} L0 ${AUTO_H} Z`, class: 'auto-fill' }),
      svg('path', { d, class: 'auto-line' }),
    ]
    pts.forEach((p, i) => {
      const dot: SVGElement = p.curve === 'hold' ? svg('rect', { x: xs[i] - 4, y: ys[i] - 4, width: 8, height: 8, class: 'auto-pt' }) : svg('circle', { cx: xs[i], cy: ys[i], r: 4.5, class: 'auto-pt' })
      dot.addEventListener('pointerdown', (e) => {
        if (readOnly || e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        deps.grab()
        dragPoint(e, p.id)
      })
      dot.addEventListener('contextmenu', (e) => pointMenu(e, p))
      kids.push(dot)
    })
    return kids
  }

  return { el, update }
}
