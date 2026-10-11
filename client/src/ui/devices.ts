// FX chain cards: title, bypass, remove and param controls for one device.
import { DEVICES, SIMPLE_FILTER, filterHasGain, paramToPos, paramToValue, type Device, type ParamDef, type ParamTarget } from '@mobdaw/shared'
import { h } from '../dom'
import { NO_AUTO, type AutoInfo } from './automation'
import { FILTER_COLORS, filterCurve, type FilterChange, type FilterLocks, type FilterMember } from './filterCurve'
import { deleteMenu } from './popover'
import { valueTip } from './valueTip'

export type CardDeps = {
  readOnly: boolean
  /** Apply a value to the local engine immediately (not in the doc). */
  live(deviceId: string, paramId: number, value: number): void
  /** Publish (or clear, with null) the in-progress drag for collaborators. */
  drag(d: { deviceId: string; paramId: number; value: number }[] | null): void
  /** Write the final value to the doc (one undo step). */
  commit(deviceId: string, paramId: number, value: number): void
  /** Write several params at once (one undo step). */
  commitMany(deviceId: string, values: Record<number, number>): void
  bypass(deviceId: string, bypass: boolean): void
  remove(deviceId: string): void
  /** The run of adjacent filters this one is in, in chain order, with `self` standing in for it. */
  run(deviceId: string, self: FilterMember): FilterMember[]
  /** This filter's values changed: the card that hosts its run's curve redraws it. */
  changed(deviceId: string): void
  /** The run's curve is moving a param of filter `deviceId` (any card in the run), and finished moving it. */
  dragFilter(deviceId: string, change: FilterChange): void
  dragFilterEnd(deviceId: string): void
  /** Make a param's name offer "Automate" (the timeline owns the lanes). */
  autoMenu(label: HTMLElement, target: ParamTarget): void
}

export const fmt = (p: ParamDef, v: number) =>
  `${v >= 1000 ? Math.round(v) : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3)}${p.unit ? ` ${p.unit}` : ''}`

type Row = { p: ParamDef; input: HTMLInputElement | HTMLSelectElement; out: HTMLElement; label: HTMLElement }

export function deviceCard(dev: Device, deps: CardDeps) {
  const def = DEVICES[dev.type]
  const id = dev.id
  const bypass = h('button', { title: 'bypass', className: 'byp', onclick: () => deps.bypass(id, !current.bypass) }, 'bypass')
  const remove = h('button', { title: 'remove device', className: 'x', onclick: () => deps.remove(id) }, '×')
  bypass.disabled = remove.disabled = deps.readOnly
  let current = dev
  const title = h('strong', {}, def?.name ?? `device ${dev.type}`)

  /** What each param currently shows (doc, automation, a remote drag or this card's own drag). */
  const shown = new Map<number, number>()
  /** Params a lane drives: the curve can't move those. */
  const locks: FilterLocks = { cutoff: false, damping: false, gain: false }
  let nodeDrag: Map<number, number> | null = null
  const member = (): FilterMember => ({
    id, mode: shown.get(0) ?? 0, cutoff: shown.get(1) ?? 1000, damping: shown.get(2) ?? 0.7071, gain: shown.get(3) ?? 0,
    bypass: current.bypass, locks: { ...locks }, row: el.offsetTop,
  })
  // The response curve is one view per run of adjacent filters: the run's first card hosts it, as wide as the run, over
  // the curve slots of the cards after it (a run that wraps onto another row gets a view per row). The other cards keep their (empty) slot so everything lines up.
  const slot = dev.type === SIMPLE_FILTER ? h('div', { className: 'fslot' }) : null
  const curve = slot ? filterCurve({ move: (fid, change) => deps.dragFilter(fid, change), end: (fid) => deps.dragFilterEnd(fid) }) : null
  const redrawCurve = () => {
    if (!curve || !slot) return
    const run = deps.run(id, member())
    const at = run.findIndex((m) => m.id === id)
    const row = run[at]?.row
    let from = at
    while (from > 0 && run[from - 1].row === row) from--
    let to = at
    while (to + 1 < run.length && run[to + 1].row === row) to++
    const host = at >= 0 && from === at
    if (host && curve.el.parentNode !== slot) slot.append(curve.el)
    else if (!host) curve.el.remove()
    // a run's filters are told apart by colour; a lone one keeps the default
    const color = (i: number) => (run.length > 1 ? FILTER_COLORS[i % FILTER_COLORS.length] : null)
    title.style.color = (at >= 0 && color(at)) || ''
    if (host) curve.draw(run.slice(from, to + 1), run.slice(from, to + 1).map((_, k) => color(from + k)))
  }
  let told = ''
  const showCurve = () => {
    if (!curve) return
    redrawCurve()
    const now = JSON.stringify(member())
    if (now !== told) (told = now, deps.changed(id))
  }
  /** The run's curve moves this filter: apply to the sliders and the engine now, commit when it lets go. */
  const dragMove = (change: FilterChange) => {
    nodeDrag ??= new Map()
    for (const [pid, v] of [[1, change.cutoff], [2, change.damping], [3, change.gain]] as const) if (v != null) nodeDrag.set(pid, v)
    for (const [pid, v] of nodeDrag) {
      deps.live(id, pid, v)
      shown.set(pid, v)
      const r = rows.find((r) => r.p.id === pid)!
      ;(r.input as HTMLInputElement).value = String(paramToPos(r.p, v))
      r.out.textContent = fmt(r.p, v)
    }
    deps.drag([...nodeDrag].map(([paramId, value]) => ({ deviceId: id, paramId, value })))
    showCurve()
  }
  const dragEnd = () => {
    deps.commitMany(id, Object.fromEntries(nodeDrag ?? []))
    deps.drag(null)
    nodeDrag = null
  }

  const rows: Row[] = (def?.params ?? []).map((p) => {
    const out = h('span', { className: 'dim out' })
    const label = h('span', { className: 'dim' }, p.name)
    // drop-downs can't be automated
    if (!p.options) deps.autoMenu(label, { scope: dev.trackId, kind: def?.instrument ? 'synth' : 'effect', owner: id, param: String(p.id) })
    if (p.options) {
      const input = h('select', { onchange: () => {
        const v = Number(input.value)
        deps.live(id, p.id, v)
        deps.commit(id, p.id, v)
        shown.set(p.id, v)
        showCurve()
      } }, ...p.options.map((o, i) => h('option', { value: String(i) }, o)))
      input.disabled = deps.readOnly
      return { p, input, out, label }
    }
    const input = h('input', { type: 'range', min: 0, max: 1, step: 'any', disabled: deps.readOnly })
    valueTip(input, out)
    input.oninput = () => {
      const v = paramToValue(p, Number(input.value))
      out.textContent = fmt(p, v)
      shown.set(p.id, v)
      deps.live(id, p.id, v)
      deps.drag([{ deviceId: id, paramId: p.id, value: v }])
      showCurve()
    }
    input.onchange = () => { // fires on release
      deps.commit(id, p.id, paramToValue(p, Number(input.value)))
      deps.drag(null)
    }
    return { p, input, out, label }
  })

  const el = h('div', { className: 'dev' },
    h('div', { className: 'dev-head' }, title, h('span', { className: 'grow' }), bypass, def?.instrument ? null : remove),
    slot,
    ...rows.map((r) => h('label', { className: 'prm' }, r.label, r.input)))
  if (!def?.instrument) deleteMenu(el, 'delete device', () => deps.remove(id), () => !deps.readOnly)

  /**
   * `remote`: in-progress values from other users' drags, keyed by param id. `auto`: the params a lane
   * drives, keyed by param id as a string; those show the lane's value and can't be dragged.
   */
  let lastRemote = new Map<number, number>()
  function update(d: Device, remote: Map<number, number>, auto: Map<string, AutoInfo> = NO_AUTO) {
    current = d
    lastRemote = remote
    bypass.classList.toggle('on', d.bypass)
    el.classList.toggle('bypassed', d.bypass)
    for (const { p, input, out, label } of rows) {
      const a = auto.get(String(p.id))
      const driven = !!a?.on && a.value != null
      label.classList.toggle('auto', !!a)
      label.classList.toggle('driven', driven)
      input.disabled = deps.readOnly || driven
      const v = (driven ? a!.value : null) ?? remote.get(p.id) ?? d.params?.[p.id] ?? p.def
      const mine = nodeDrag?.get(p.id) // the pointer is on this card's curve
      const free = driven || (document.activeElement !== input && mine == null) // a driven slider follows the lane even while focused
      if (free) shown.set(p.id, v)
      if (p.id >= 1 && p.id <= 3) locks[(['cutoff', 'damping', 'gain'] as const)[p.id - 1]] = deps.readOnly || driven
      if (free) input instanceof HTMLSelectElement ? (input.value = String(Math.round(v))) : (input.value = String(paramToPos(p, v)))
      if (!(input instanceof HTMLSelectElement) && free) out.textContent = fmt(p, v)
    }
    // the gain row only matters to a bell or shelf
    const gainRow = rows.find((r) => r.p.id === 3 && dev.type === SIMPLE_FILTER)
    if (gainRow) gainRow.label.parentElement!.hidden = !filterHasGain(shown.get(0) ?? 0)
    showCurve()
  }
  update(dev, new Map())
  /** Repaint with new automation values only (the playhead moved). */
  const refresh = (auto: Map<string, AutoInfo>) => update(current, lastRemote, auto)
  return { el, update, refresh, /** The filter's current values, or null for other devices. */ member: () => (curve ? member() : null), redrawCurve, dragMove, dragEnd }
}
