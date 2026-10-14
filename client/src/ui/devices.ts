// FX chain cards: title (click for the delete menu), on/off switch and param controls for one device.
import { DEVICES, KEY_MAX, KEY_MIN, SIMPLE_FILTER, filterHasGain, paramToPos, paramToValue, type Device, type ParamDef, type ParamTarget } from '@mobdaw/shared'
import { h } from '../dom'
import { NO_AUTO, type AutoInfo } from './automation'
import { deviceDrumColor } from './drumColor'
import { CARD_W, FILTER_COLORS, filterCurve, type FilterChange, type FilterLocks, type FilterMember } from './filterCurve'
import { cardMenu, onOffSwitch, setSwitch } from './cardHead'
import { noteName, parseNote } from './noteName'
import { inUse } from './held'
import { dragToReorder } from './reorder'
import { knob } from './knob'
import { segmented, type Seg } from './segmented'
import { SEG_MAX, rows as rows_, span } from './deviceLayout'
import { formatParam, isBipolar } from './knobMath'

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
  /** Instruments: set the note range (MIDI pitches, inclusive), and rename the card. */
  keys(deviceId: string, lo: number, hi: number): void
  rename(deviceId: string): void
  /** The run of adjacent filters this one is in, in chain order, with `self` standing in for it. */
  run(deviceId: string, self: FilterMember): FilterMember[]
  /** This filter's values changed: the card that hosts its run's curve redraws it. */
  changed(deviceId: string): void
  /** A card is being dragged by its title bar (merged views split meanwhile); dropped before `beforeId` (null: last). */
  reorderStart(): void
  reorderDrop(deviceId: string, beforeId: string | null): void
  reorderEnd(): void
  /** The run's curve is moving a param of filter `deviceId` (any card in the run), and finished moving it. */
  dragFilter(deviceId: string, change: FilterChange): void
  dragFilterEnd(deviceId: string): void
  /** Make a param's name offer "Automate" (the timeline owns the lanes). */
  autoMenu(label: HTMLElement, target: ParamTarget, clickToo?: boolean): void
}

type Row = { p: ParamDef; input: HTMLSelectElement | null; seg: Seg | null; knob: ReturnType<typeof knob> | null; cell: HTMLElement; label: HTMLElement }

export function deviceCard(dev: Device, deps: CardDeps) {
  const def = DEVICES[dev.type]
  const id = dev.id
  // lit while the effect is running, off while bypassed
  const bypass = onOffSwitch('bypass', () => deps.bypass(id, !current.bypass))
  bypass.disabled = deps.readOnly
  let current = dev
  const title = h('strong', {}, dev.name ?? def?.name ?? `device ${dev.type}`)

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
      r.knob?.set(v)
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
    const label = h('span', { className: 'dim', title: p.name }, p.name)
    // drop-downs can't be automated; a click on the name offers it, a right-click on the knob too
    const target: ParamTarget = { scope: dev.trackId, kind: def?.instrument ? 'synth' : 'effect', owner: id, param: String(p.id) }
    if (!p.options) deps.autoMenu(label, target)
    if (p.options && p.options.length <= SEG_MAX) {
      const seg = segmented(p.options.map((o, i) => ({ value: String(i), label: o })), String(p.def), (sv) => {
        const v = Number(sv)
        deps.live(id, p.id, v)
        deps.commit(id, p.id, v)
        shown.set(p.id, v)
        showCurve()
      }, p.name)
      return { p, input: null, seg, knob: null, cell: h('div', { className: 'kn sel', 'data-param': p.id, style: `--span:${span(p)}` }, seg.el, label), label }
    }
    if (p.options) {
      const input = h('select', { onchange: () => {
        const v = Number(input.value)
        deps.live(id, p.id, v)
        deps.commit(id, p.id, v)
        shown.set(p.id, v)
        showCurve()
      } }, ...p.options.map((o, i) => h('option', { value: String(i) }, o)))
      input.disabled = deps.readOnly
      input.title = p.name
      return { p, input, seg: null, knob: null, cell: h('label', { className: 'kn sel', 'data-param': p.id, style: `--span:${span(p)}` }, input, label), label }
    }
    const k = knob({
      min: p.min, max: p.max, value: p.def, def: p.def, size: 30, disabled: deps.readOnly,
      toPos: (v) => paramToPos(p, v), fromPos: (t) => paramToValue(p, t), bipolar: isBipolar(p),
      format: (v) => formatParam(p, v),
      onInput: (v) => {
        shown.set(p.id, v)
        deps.live(id, p.id, v)
        deps.drag([{ deviceId: id, paramId: p.id, value: v }])
        showCurve()
      },
      onChange: (v) => { // the gesture ended
        deps.commit(id, p.id, v)
        deps.drag(null)
      },
    })
    deps.autoMenu(k.el, target, false)
    return { p, input: null, seg: null, knob: k, cell: h('div', { className: 'kn', 'data-param': p.id }, k.el, label), label }
  })

  // Instruments take the notes inside their range: two note-name fields, lo and hi (c2, f#3, or a pitch number).
  const keyIn = (tip: string) => h('input', { className: 'key', title: tip, spellcheck: false, disabled: deps.readOnly })
  const lo = keyIn('lowest note'), hi = keyIn('highest note')
  const range = def?.instrument ? h('div', { className: 'prm keys' }, h('span', { className: 'dim' }, 'notes'), h('div', {}, lo, '–', hi)) : null
  const setKeys = (which: 'lo' | 'hi') => {
    const p = parseNote((which === 'lo' ? lo : hi).value)
    const [kl, kh] = [current.keyLo ?? KEY_MIN, current.keyHi ?? KEY_MAX]
    if (p == null) return showKeys(kl, kh) // not a note: put the old one back
    deps.keys(id, which === 'lo' ? p : Math.min(kl, p), which === 'hi' ? p : Math.max(kh, p)) // the other end follows if they would cross
  }
  const showKeys = (kl: number, kh: number) => {
    if (document.activeElement !== lo) lo.value = noteName(kl)
    if (document.activeElement !== hi) hi.value = noteName(kh)
  }
  lo.onchange = () => setKeys('lo')
  hi.onchange = () => setKeys('hi')
  for (const i of [lo, hi]) i.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur() }

  const head = h('div', { className: 'dev-head' }, title, h('span', { className: 'grow' }), bypass)
  const el = h('div', { className: 'dev', 'data-device': id },
    head,
    slot,
    h('div', { className: 'krows' }, ...rows_(def ?? { type: dev.type, name: '', instrument: false, params: [] }).map((row) =>
      h('div', { className: 'krow' }, row.title ? h('div', { className: 'ktitle' }, row.title) : null,
        h('div', { className: 'kcells' }, ...row.params.map((p) => {
          const c = rows.find((r) => r.p === p)!.cell
          c.classList.toggle('same', row.title === p.name) // the caption already says it
          return c
        }))))),
    range)
  if (slot) el.classList.add("filter")
  if (slot) el.style.width = `${CARD_W}px` // filters stay narrow: their run shares one curve view, a card wide per filter
  if (!deps.readOnly) dragToReorder(head, el, { start: deps.reorderStart, drop: (before) => deps.reorderDrop(id, before), end: deps.reorderEnd })
  cardMenu(el, head, title, def?.instrument ? 'delete instrument' : 'delete effect', () => deps.remove(id), () => !deps.readOnly,
    def?.instrument ? [['rename', () => deps.rename(id)]] : [])

  /**
   * `remote`: in-progress values from other users' drags, keyed by param id. `auto`: the params a lane
   * drives, keyed by param id as a string; those show the lane's value and can't be dragged.
   */
  let lastRemote = new Map<number, number>()
  function update(d: Device, remote: Map<number, number>, auto: Map<string, AutoInfo> = NO_AUTO) {
    current = d
    lastRemote = remote
    setSwitch(bypass, el, !d.bypass)
    title.textContent = d.name ?? def?.name ?? `device ${d.type}`
    const dc = deviceDrumColor(d) // a drum wears its grid row's colour
    el.classList.toggle('drum', !!dc)
    if (dc) el.style.setProperty('--rc', dc)
    else el.style.removeProperty('--rc')
    showKeys(d.keyLo ?? KEY_MIN, d.keyHi ?? KEY_MAX)
    for (const { p, input, seg, knob: k, label } of rows) {
      const a = auto.get(String(p.id))
      const driven = !!a?.on && a.value != null
      label.classList.toggle('auto', !!a)
      label.classList.toggle('driven', driven)
      const dis = deps.readOnly || driven
      if (input) input.disabled = dis
      if (seg) { seg.el.classList.toggle('off', dis); seg.el.querySelectorAll('button').forEach((b) => (b.disabled = dis)) }
      k?.setDisabled(dis)
      const v = (driven ? a!.value : null) ?? remote.get(p.id) ?? d.params?.[p.id] ?? p.def
      const mine = nodeDrag?.get(p.id) // the pointer is on this card's curve
      const free = driven || ((input ? !inUse(input) : true) && mine == null) // a driven knob follows the lane even while focused
      if (free) shown.set(p.id, v)
      if (p.id >= 1 && p.id <= 3) locks[(['cutoff', 'damping', 'gain'] as const)[p.id - 1]] = deps.readOnly || driven
      if (free) input ? (input.value = String(Math.round(v))) : seg ? seg.set(String(Math.round(v))) : k!.set(v)
    }
    // the gain row only matters to a bell or shelf
    const gainRow = rows.find((r) => r.p.id === 3 && dev.type === SIMPLE_FILTER)
    if (gainRow) gainRow.cell.hidden = !filterHasGain(shown.get(0) ?? 0)
    showCurve()
  }
  update(dev, new Map())
  /** Repaint with new automation values only (the playhead moved). */
  const refresh = (auto: Map<string, AutoInfo>) => update(current, lastRemote, auto)
  return { el, update, refresh, /** The filter's current values, or null for other devices. */ member: () => (curve ? member() : null), redrawCurve, dragMove, dragEnd }
}
