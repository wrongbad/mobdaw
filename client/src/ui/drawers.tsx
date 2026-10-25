// The drawers below a track's lane (instruments, loopers, effects, automation, presets); a bus's and the master's have no instruments or loopers:
// Solid components over the project store. Mounted once per lane into the lane's element, they follow the doc, the peers' drags and the
// automation's values by themselves; the timeline only draws what is left.
import {
  DEVICES, EFFECTS, INSTRUMENTS, LOFI_DRUM, MASTER_TRACK, MIX, addDevice, addDrum, addNextLooper, deviceParamDef, looperParamDef, resolveTarget,
  type Device, type Lane, type Looper, type ResolvedParam,
} from '@mobdaw/shared'
import { render } from 'solid-js/web'
import { For, Show, createEffect, createMemo, createRenderEffect, onCleanup, onMount, type Accessor } from 'solid-js'
import { applyPreset, presetsFor } from '../content/presets'
import type { AutoValues } from '../project/viewState'
import { autoRow, type RowDeps } from './automation'
import { DeviceCard, createChain, sameList, type CardDeps } from './deviceCard'
import type { HeadCtx } from './trackHead'
import { LOOP_COLORS, looperCard, type LooperDeps } from './loopers'
import { popover } from './popover'
import type { TransportControls } from './transport'

const EMPTY: never[] = []

/** What the drawers share, on top of what the headers do. */
export type DrawCtx = HeadCtx & {
  auto: AutoValues
  deps: CardDeps
  /** A card is being dragged by its title bar: merged filter views split until it lands. */
  reordering: Accessor<boolean>
  loops: LooperDeps
  rows: RowDeps
  /** The looper whose region is being drawn. */
  armed: Accessor<string | null>
  /** The width of an automation surface (the timeline's), and the zoom it is drawn at. */
  width: Accessor<number>
  scale: Accessor<{ pps: number; rate: number }>
}

/** A row of device cards. */
function DevicesRow(p: {
  ctx: DrawCtx; devices: Accessor<Device[]>; open: Accessor<boolean>; label: Accessor<string>
  add: { title: string; items: () => [string, () => void][] }
}) {
  const chain = createChain(p.devices)
  let box!: HTMLDivElement
  onMount(() => {
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => chain.relayout())
    ro.observe(box)
    onCleanup(() => ro.disconnect())
  })
  return (
    <div class="fx-row" hidden={!p.open()}>
      <div class="fx-toggle" classList={{ on: p.open() }}>{p.label()}</div>
      <div class="fx" hidden={!p.open()} ref={box}>
        <Show when={p.open()}>
          <For each={p.devices()}>{(d) => <DeviceCard id={d.id} ctx={p.ctx} chain={chain} />}</For>
        </Show>
        <button class="add-fx" title={p.add.title} on:click={(e) => popover(e.currentTarget, p.add.items())}>+</button>
      </div>
    </div>
  )
}

/** A scope's devices without the hidden ones (the mix device), in chain order. */
const chainOf = (ctx: DrawCtx, scope: string, instrument: boolean) =>
  createMemo(() => ctx.store.devicesByTrack(scope)().filter((d) => !DEVICES[d.type]?.hidden && !!DEVICES[d.type]?.instrument === instrument), EMPTY as Device[], { equals: sameList })

const effectItems = (ctx: DrawCtx, scope: string) => () => EFFECTS.map((d) => [d.name, () => addDevice(ctx.doc, scope, d.type)] as [string, () => void])

/** One looper's card: the imperative card, repainted from the store, the lanes that drive it and whether it is armed. */
function LooperCard(p: { id: string; ctx: DrawCtx }) {
  const { store } = p.ctx
  const lp = createMemo<Looper>((prev) => store.looperById[p.id] ?? prev)
  const card = looperCard(lp(), p.ctx.loops)
  createRenderEffect(() => card.update(lp(), p.ctx.armed() === p.id, p.ctx.scale().rate, p.ctx.auto.get(p.id)))
  return card.el
}

function LoopersRow(p: { ctx: DrawCtx; id: string; tc: TransportControls }) {
  const { store, doc, drawers } = p.ctx
  const mine = createMemo(() => store.loopers().filter((l) => l.trackId === p.id), EMPTY as Looper[], { equals: sameList })
  const open = () => drawers.isOpen(p.id, 'loopers')
  createRenderEffect(() => (p.tc.el.hidden = !open()))
  return (
    <div class="fx-row" hidden={!open()}>
      <div class="fx-head"><div class="fx-toggle" classList={{ on: open() }}>loopers</div>{p.tc.el}</div>
      <div class="fx" hidden={!open()}>
        <Show when={open()}>
          <For each={mine()}>{(l) => <LooperCard id={l.id} ctx={p.ctx} />}</For>
        </Show>
        <button class="add-fx" title="add looper" on:click={() => addNextLooper(doc, p.id)}>+</button>
      </div>
    </div>
  )
}

/** The presets drawer: a section like the automation one (same toggle and box), holding one column of plain-text buttons per group. */
function PresetsDrawer(p: { ctx: DrawCtx; id: string }) {
  const { store, doc, undo, drawers, avail } = p.ctx
  // the offer depends on the kind of the track only; it is made once, so the buttons live as long as the track does
  const groups = createMemo(() => {
    void store.trackById[p.id]?.kind
    const g = new Map<string, ReturnType<typeof presetsFor>>()
    for (const t of presetsFor(doc, p.id)) g.set(t.group, [...(g.get(t.group) ?? []), t])
    return [...g].map(([name, items]) => ({ name, items }))
  }, EMPTY as { name: string; items: ReturnType<typeof presetsFor> }[], { equals: (a, b) => a.length === b.length && a.every((g, i) => g.name === b[i].name && sameList(g.items.map((x) => x.id), b[i].items.map((x) => x.id))) })
  const has = () => groups().length > 0
  const open = () => drawers.isOpen(p.id, 'presets')
  const preset = () => store.trackById[p.id]?.preset
  const disabled = () => store.locks().has(p.id)
  createEffect(() => avail.set(p.id, 'presets', has()))
  return (
    <div class="auto-section" hidden={!(has() && open())}>
      <div class="fx-row">
        <div class="fx-toggle on">presets</div>
        <div class="preset-grid">
          <Show when={open()}>
            <For each={groups()}>{(g) => (
              <div class="preset-col" role="group" aria-label={g.name}>
                <h4>{g.name}</h4>
                <For each={g.items}>{(t) => (
                  <button class="preset" classList={{ on: preset() === t.id }} disabled={disabled()} aria-pressed={preset() === t.id}
                    on:click={() => {
                      undo.stopCapturing()
                      applyPreset(doc, p.id, t.id)
                      undo.stopCapturing()
                    }}>{t.name}</button>
                )}</For>
              </div>
            )}</For>
          </Show>
        </div>
      </div>
    </div>
  )
}

/** The lane (automation) of one param: the imperative row, repainted from the store. */
function AutoLane(p: { ctx: DrawCtx; id: string }) {
  const { store, doc } = p.ctx
  const lane = createMemo<Lane>((prev) => store.laneById[p.id] ?? prev)
  const row = autoRow(p.ctx.rows)
  const pts = createMemo(() => [...store.pointsByLane(p.id)()].sort((a, b) => a.pos - b.pos), EMPTY as ReturnType<typeof store.points>, { equals: sameList })
  /** Where the lane points, with the values it reads from the doc followed (a device's param, a looper's fields). */
  const resolved = createMemo<ResolvedParam | null>(() => {
    const l = lane()
    if (l.kind === 'looper') {
      const lp = store.looperById[l.owner]
      if (lp) void [lp.slot, lp.gain, lp.speed, lp.sat, lp.cutoff, lp.warble]
    } else {
      const d = store.deviceById[l.owner]
      if (d) void [d.type, d.params?.[l.param]]
    }
    return resolveTarget(doc, l)
  }, null, { equals: (a, b) => a === b || (!!a && !!b && a.label === b.label && a.owner === b.owner && a.value === b.value && JSON.stringify(a.def) === JSON.stringify(b.def)) })
  /** The owner's name for a lane header: the device's, numbered when its chain has several of a kind. */
  const ownerLabel = (l: Lane, base: string) => {
    if (l.kind === 'looper') return base
    const devices = store.devicesByTrack(l.scope)()
    const same = devices.filter((d) => DEVICES[d.type]?.name === base)
    return same.length > 1 ? `${base} ${same.findIndex((d) => d.id === l.owner) + 1}` : base
  }
  createRenderEffect(() => {
    const l = lane(), r = resolved()
    p.ctx.scale() // (the lane is drawn at the zoom)
    if (!r) return
    const slot = l.kind === 'looper' ? store.looperById[l.owner]?.slot : undefined
    row.update(l, pts(), {
      def: r.def, label: store.deviceById[l.owner]?.type === MIX ? r.label : `${ownerLabel(l, r.owner)} · ${r.label}`, value: r.value, width: p.ctx.width(),
      color: slot != null ? LOOP_COLORS[slot % LOOP_COLORS.length] : 'var(--accent)',
    })
  })
  return row.el
}

/** A scope's automation: one collapsible section holding a lane per automated param (absent when there are none). */
function AutoSection(p: { ctx: DrawCtx; scope: string; title: string; ref?: (el: HTMLElement) => void }) {
  const { store, drawers, avail } = p.ctx
  const scope = p.scope
  /** The lanes whose param still exists; the fader's and pan's lead the section. */
  const mine = createMemo(() => {
    const mixId = store.mixDevice(scope)?.id
    const rank = (l: Lane) => (l.owner === mixId ? 0 : 1)
    const exists = (l: Lane) => {
      if (l.kind === 'looper') return !!store.looperById[l.owner] && !!looperParamDef(l.param)
      const d = store.deviceById[l.owner]
      return !!d && !!deviceParamDef(d.type, l.param)
    }
    return store.lanes().filter((l) => l.scope === scope && exists(l)).sort((a, b) => rank(a) - rank(b) || (rank(a) ? 0 : Number(a.param) - Number(b.param)))
  }, EMPTY as Lane[], { equals: sameList })
  const open = () => drawers.isOpen(scope, 'auto')
  createEffect(() => avail.set(scope, 'auto', mine().length > 0)) // (no lanes: nothing to open)
  return (
    <div class="auto-section" hidden={mine().length === 0 || !open()} data-title={p.title} ref={(el) => p.ref?.(el)}>
      <div class="fx-row"><div class="fx-toggle" classList={{ on: open() }}>{`${p.title} (${mine().length})`}</div></div>
      <div class="auto-box">
        <Show when={open()}>
          <For each={mine()}>{(l) => <AutoLane ctx={p.ctx} id={l.id} />}</For>
        </Show>
      </div>
    </div>
  )
}

/**
 * A track's drawers, in the order they sit under its lane: instruments (MIDI), loopers (soundscape), effects, automation and presets.
 * A bus (and the master, `MASTER_TRACK`) has no instruments or loopers: effects, automation and presets only.
 */
function LaneDrawers(p: { ctx: DrawCtx; id: string; kind: string; tc?: TransportControls; refs: (r: { auto: HTMLElement }) => void }) {
  const { ctx, id } = p
  const { drawers, doc } = ctx
  const root = id === MASTER_TRACK // (the master bus: a bus like the others, named in its labels)
  const effects = chainOf(ctx, id, false)
  const instruments = chainOf(ctx, id, true)
  let auto!: HTMLElement
  const out = (
    <>
      <Show when={p.kind === 'midi'}>
        <DevicesRow ctx={ctx} devices={instruments} open={() => drawers.isOpen(id, 'synth')} label={() => 'synth'}
          add={{ title: 'add instrument', items: () => INSTRUMENTS.map((d) => [d.name, () => (d.type === LOFI_DRUM ? addDrum(doc, id) : addDevice(doc, id, d.type))] as [string, () => void]) }} />
      </Show>
      <Show when={p.kind === 'soundscape'}><LoopersRow ctx={ctx} id={id} tc={p.tc!} /></Show>
      <DevicesRow ctx={ctx} devices={effects} open={() => drawers.isOpen(id, 'fx')} label={() => (root && effects().length ? `master fx (${effects().length})` : root ? 'master fx' : 'fx')}
        add={{ title: 'add effect', items: effectItems(ctx, id) }} />
      <AutoSection ctx={ctx} scope={id} title={root ? 'master automation' : 'automation'} ref={(el) => (auto = el)} />
      <PresetsDrawer ctx={ctx} id={id} />
    </>
  )
  p.refs({ auto })
  return out
}

/** Append a track's drawers to `host` (its `.lane`, after the rows the timeline made). `refs.auto` is the automation section. */
/** (`tc`, the loopers' preview transport, is for soundscapes; buses and the master have none.) */
export function mountLaneDrawers(host: HTMLElement, ctx: DrawCtx, id: string, kind: string, tc?: TransportControls) {
  let refs!: { auto: HTMLElement }
  const dispose = render(() => <LaneDrawers ctx={ctx} id={id} kind={kind} tc={tc} refs={(r) => (refs = r)} />, host)
  return { refs, dispose }
}
