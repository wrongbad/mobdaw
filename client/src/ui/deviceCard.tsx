// FX chain cards: title (click for the delete menu), on/off switch and param controls for one device. A component: the doc's values
// come from the store, the peers' drags and the automation's values from signals, so a change patches only the control it is for.
import { DEVICES, SIMPLE_FILTER, filterHasGain, paramToPos, paramToValue, type Device, type ParamDef, type ParamTarget } from '@mobdaw/shared'
import { createEffect, createMemo, createRenderEffect, createSignal, onCleanup, onMount, batch, type Accessor } from 'solid-js'
import { createStore } from 'solid-js/store'
import type { ProjectStore } from '../project/store'
import type { AutoValues } from '../project/viewState'
import { deviceDrumColor } from './drumColor'
import { CARD_W, FILTER_COLORS, filterCurve, type FilterChange, type FilterLocks, type FilterMember } from './filterCurve'
import { cardMenu, onOffSwitch, setSwitch } from './cardHead'
import { inUse } from './held'
import { dragToReorder } from './reorder'
import { knob } from './knob'
import { segmented } from './segmented'
import { SEG_MAX, rows as rows_, span } from './deviceLayout'
import { formatParam, isBipolar } from './knobMath'

export type CardDeps = {
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
  /** Instruments: rename the card. */
  rename(deviceId: string): void
  /** A card is being dragged by its title bar (merged views split meanwhile); dropped before `beforeId` (null: last). */
  reorderStart(): void
  reorderDrop(deviceId: string, beforeId: string | null): void
  reorderEnd(): void
}

/** What the cards share. */
export type CardCtx = {
  readOnly: boolean
  store: ProjectStore
  auto: AutoValues
  deps: CardDeps
  /** A card is being dragged by its title bar: merged filter views split until it lands. */
  reordering: Accessor<boolean>
  /** Make a param's name offer "Automate" (the timeline owns the lanes). */
  autoMenu(label: HTMLElement, target: () => ParamTarget, clickToo?: boolean): void
}

export const sameList = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** What a filter card lends its chain: its current values (for the run's curve) and the curve's drag. */
type CardApi = { member(): FilterMember; dragMove(change: FilterChange): void; dragEnd(): void }

/**
 * The cards of one row (a track's effects, the master bus's, or a track's instruments) and what they share: each filter's run (the ids of the filters
 * adjacent to it, itself included, in chain order), and the signals that say the layout changed (a card came or went, the row was resized or opened).
 */
export function createChain(devices: Accessor<Device[]>) {
  const runs = createMemo(() => {
    const m = new Map<string, string[]>()
    let run: string[] = []
    const flush = () => { for (const id of run) m.set(id, run); run = [] }
    for (const d of devices()) {
      if (d.type === SIMPLE_FILTER) run.push(d.id)
      else flush()
    }
    flush()
    return m
  })
  const [ver, setVer] = createSignal(0)
  const [layout, setLayout] = createSignal(0)
  return {
    cards: new Map<string, CardApi>(),
    runOf: (id: string) => runs().get(id) ?? [id],
    /** Fires when a filter card is made or dropped. */
    ver,
    touch: () => setVer((v) => v + 1),
    /** Fires when the cards may have wrapped differently. */
    layout,
    relayout: () => setLayout((v) => v + 1),
  }
}
export type Chain = ReturnType<typeof createChain>

/** One card. `chain` is the row it is in (its filters' runs share a curve). */
export function DeviceCard(p: { id: string; ctx: CardCtx; chain: Chain }) {
  const { readOnly, store, deps } = p.ctx
  const id = p.id
  // (the device can be gone from the doc a moment before its card is: keep showing the last one)
  const dev = createMemo<Device>((prev) => store.deviceById[id] ?? prev)
  const def = DEVICES[dev().type]
  const isFilter = dev().type === SIMPLE_FILTER
  const auto = () => p.ctx.auto.get(id)
  const drags = store.drags(id)

  /** What each param currently shows (doc, automation, a remote drag or this card's own drag). */
  const [shown, setShown] = createStore<Record<number, number>>({})
  /** Params a lane drives: the curve can't move those. */
  const [locks, setLocks] = createStore<FilterLocks>({ cutoff: false, damping: false, gain: false })
  /** The card's top in its (wrapping) chain, read when the layout changes and not on every value. */
  const [top, setTop] = createSignal(0)
  let nodeDrag: Map<number, number> | null = null
  const member = (): FilterMember => ({
    id, mode: shown[0] ?? 0, cutoff: shown[1] ?? 1000, damping: shown[2] ?? 0.7071, gain: shown[3] ?? 0,
    bypass: !!dev().bypass, locks: { ...locks }, row: top(),
  })

  const knobs = new Map<number, ReturnType<typeof knob>>()
  /** One param's cell: its control and its name. The control follows the doc, the peers' drags and the lane that drives it. */
  const cell = (pd: ParamDef): HTMLElement => {
    const info = () => auto().get(String(pd.id))
    const driven = () => { const a = info(); return !!a?.on && a.value != null }
    const label = (<span class="dim" classList={{ auto: !!info(), driven: driven() }} title={pd.name}>{pd.name}</span>) as HTMLElement
    // drop-downs can't be automated; a click on the name offers it, a right-click on the knob too
    const target = (): ParamTarget => ({ scope: dev().trackId, kind: def?.instrument ? 'synth' : 'effect', owner: id, param: String(pd.id) })
    if (!pd.options) p.ctx.autoMenu(label, target)
    const value = () => (driven() ? info()!.value : null) ?? drags().get(pd.id) ?? dev().params?.[pd.id] ?? pd.def
    /** Whether the doc's / lane's value may be put on the control now. */
    const free = (busy: boolean) => driven() || (!busy && nodeDrag?.get(pd.id) == null)
    const lock = () => {
      if (pd.id >= 1 && pd.id <= 3) setLocks((['cutoff', 'damping', 'gain'] as const)[pd.id - 1], readOnly || driven())
    }
    const choose = (v: number) => {
      deps.live(id, pd.id, v)
      deps.commit(id, pd.id, v)
      setShown(pd.id, v)
    }
    if (pd.options && pd.options.length <= SEG_MAX) {
      const seg = segmented(pd.options.map((o, i) => ({ value: String(i), label: o })), String(pd.def), (sv) => choose(Number(sv)), pd.name)
      createRenderEffect(() => {
        const dis = readOnly || driven()
        seg.el.classList.toggle('off', dis)
        seg.el.querySelectorAll('button').forEach((b) => (b.disabled = dis))
        lock()
        const v = value()
        if (free(false)) { setShown(pd.id, v); seg.set(String(Math.round(v))) }
      })
      return (<div class="kn sel" data-param={pd.id} style={`--span:${span(pd)}`}>{seg.el}{label}</div>) as HTMLElement
    }
    if (pd.options) {
      const input = (
        <select title={pd.name} disabled={readOnly} on:change={() => choose(Number(input.value))}>
          {pd.options.map((o, i) => <option value={String(i)}>{o}</option>)}
        </select>
      ) as HTMLSelectElement
      createRenderEffect(() => {
        input.disabled = readOnly || driven()
        lock()
        const v = value()
        if (free(inUse(input))) { setShown(pd.id, v); input.value = String(Math.round(v)) }
      })
      return (<label class="kn sel" data-param={pd.id} style={`--span:${span(pd)}`}>{input}{label}</label>) as HTMLElement
    }
    const k = knob({
      min: pd.min, max: pd.max, value: pd.def, def: pd.def, size: 30, disabled: readOnly,
      toPos: (v) => paramToPos(pd, v), fromPos: (t) => paramToValue(pd, t), bipolar: isBipolar(pd),
      format: (v) => formatParam(pd, v),
      onInput: (v) => {
        setShown(pd.id, v)
        deps.live(id, pd.id, v)
        deps.drag([{ deviceId: id, paramId: pd.id, value: v }])
      },
      onChange: (v) => { // the gesture ended
        deps.commit(id, pd.id, v)
        deps.drag(null)
      },
    })
    knobs.set(pd.id, k)
    p.ctx.autoMenu(k.el, target, false)
    createRenderEffect(() => {
      k.setDisabled(readOnly || driven())
      lock()
      const v = value()
      if (free(false)) { setShown(pd.id, v); k.set(v) }
    })
    const c = (<div class="kn" data-param={pd.id}>{k.el}{label}</div>) as HTMLElement
    // the gain row only matters to a bell or shelf
    if (isFilter && pd.id === 3) createRenderEffect(() => (c.hidden = !filterHasGain(shown[0] ?? 0)))
    return c
  }
  const cells = new Map<ParamDef, HTMLElement>((def?.params ?? []).map((pd) => [pd, cell(pd)]))

  /** The run's curve moves this filter: apply to the sliders and the engine now, commit when it lets go. */
  const dragMove = (change: FilterChange) => {
    nodeDrag ??= new Map()
    for (const [pid, v] of [[1, change.cutoff], [2, change.damping], [3, change.gain]] as const) if (v != null) nodeDrag.set(pid, v)
    batch(() => {
      for (const [pid, v] of nodeDrag!) {
        deps.live(id, pid, v)
        setShown(pid, v)
        knobs.get(pid)?.set(v)
      }
    })
    deps.drag([...nodeDrag].map(([paramId, value]) => ({ deviceId: id, paramId, value })))
  }
  const dragEnd = () => {
    deps.commitMany(id, Object.fromEntries(nodeDrag ?? []))
    deps.drag(null)
    nodeDrag = null
  }

  const bypass = onOffSwitch('bypass', () => deps.bypass(id, !dev().bypass))
  bypass.disabled = readOnly
  const name = () => dev().name ?? def?.name ?? `device ${dev().type}`
  // The response curve is one view per run of adjacent filters: the run's first card hosts it, as wide as the run, over
  // the curve slots of the cards after it (a run that wraps onto another row gets a view per row). The other cards keep their (empty) slot so everything lines up.
  const slot = isFilter ? ((<div class="fslot" />) as HTMLElement) : null
  const curve = slot ? filterCurve({ move: (fid, change) => p.chain.cards.get(fid)?.dragMove(change), end: (fid) => p.chain.cards.get(fid)?.dragEnd() }) : null
  let title!: HTMLElement
  const head = (
    <div class="dev-head">
      <strong ref={title}>{name()}</strong>
      <span class="grow" />
      {bypass}
    </div>
  ) as HTMLElement
  const el = (
    <div class="dev" classList={{ filter: isFilter }} data-device={id} style={isFilter ? `width:${CARD_W}px` : undefined}>
      {head}
      {slot}
      <div class="krows">
        {rows_(def ?? { type: dev().type, name: '', instrument: false, params: [] }).map((row) => (
          <div class="krow">
            {row.title ? <div class="ktitle">{row.title}</div> : null}
            <div class="kcells">{row.params.map((pd) => {
              const c = cells.get(pd)!
              c.classList.toggle('same', row.title === pd.name) // the caption already says it
              return c
            })}</div>
          </div>
        ))}
      </div>
    </div>
  ) as HTMLElement
  if (!readOnly) dragToReorder(head, el, { start: deps.reorderStart, drop: (before) => deps.reorderDrop(id, before), end: deps.reorderEnd })
  cardMenu(el, head, title, def?.instrument ? 'delete instrument' : 'delete effect', () => deps.remove(id), () => !readOnly,
    def?.instrument ? [['rename', () => deps.rename(id)]] : [])

  createRenderEffect(() => setSwitch(bypass, el, !dev().bypass))
  createRenderEffect(() => {
    const dc = deviceDrumColor(dev()) // a drum wears its grid row's colour
    el.classList.toggle('drum', !!dc)
    if (dc) el.style.setProperty('--rc', dc)
    else el.style.removeProperty('--rc')
  })

  if (curve && slot) {
    p.chain.cards.set(id, { member, dragMove, dragEnd })
    onMount(() => p.chain.touch())
    onCleanup(() => {
      p.chain.cards.delete(id)
      curve.el.remove()
      p.chain.touch()
    })
    // where the card sits changes with the layout (a card came, the row was resized or opened, a drag split the runs), not with its values
    createEffect(() => {
      p.chain.layout()
      p.chain.ver()
      p.ctx.reordering()
      setTop(el.offsetTop)
    })
    createEffect(() => {
      p.chain.ver()
      const run = p.ctx.reordering() ? [id] : p.chain.runOf(id)
      const ms = run.flatMap((rid) => (rid === id ? [member()] : p.chain.cards.get(rid)?.member() ?? []))
      const at = ms.findIndex((m) => m.id === id)
      const row = ms[at]?.row
      let from = at
      while (from > 0 && ms[from - 1].row === row) from--
      let to = at
      while (to + 1 < ms.length && ms[to + 1].row === row) to++
      const host = at >= 0 && from === at
      if (host && curve.el.parentNode !== slot) slot.append(curve.el)
      else if (!host) curve.el.remove()
      // a run's filters are told apart by colour; a lone one keeps the default
      const color = (i: number) => (ms.length > 1 ? FILTER_COLORS[i % FILTER_COLORS.length] : null)
      title.style.color = (at >= 0 && color(at)) || ''
      if (host) curve.draw(ms.slice(from, to + 1), ms.slice(from, to + 1).map((_, k) => color(from + k)))
    })
  }
  return el
}
