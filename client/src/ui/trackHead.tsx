// A track's header (and a bus's, and the master's): name, kind icon, M / S / R / I, input meter, fader and pan, and the drawer tabs. Mounted
// into the lane's `.head` with `render()`. The widgets that are not Solid (`knob`, `ticks`, `valueTip`, `popover`) are used as they are.
import { MASTER_TRACK, MIX_GAIN, MIX_PAN, deleteTrack, effectiveParent, getTracks, tracksMap, updateTrack, type ParamTarget, type Track } from '@mobdaw/shared'
import { render } from 'solid-js/web'
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js'
import type * as Y from 'yjs'
import type { Recorder } from '../project/recorder'
import type { ProjectStore } from '../project/store'
import { busTargets, moveTrack, newBusFrom, treeRows } from '../project/buses'
import type { createCollapsed, createDrawers, createMixDrive, createTabAvailability, TabName } from '../project/viewState'
import { icon, setIcon } from '../theme/icons'
import { inUse } from './held'
import { knob } from './knob'
import { closedBy, popover } from './popover'
import { fmtDb, gainToPos, posToGain, ticks, UNITY_POS } from './slider'
import { trackKind } from './trackKind'
import { valueTip } from './valueTip'

const TAB_LABEL: Record<TabName, string> = { source: 'src', synth: 'synth', loopers: 'loops', fx: 'fx', auto: 'auto', presets: 'presets' }
const TAB_TITLE: Record<TabName, string> = { source: 'source audio', synth: 'instruments', loopers: 'loopers', fx: 'effects', auto: 'automation lanes', presets: 'presets' }
export const TABS: Record<string, TabName[]> = {
  audio: ['fx', 'auto', 'presets'], midi: ['synth', 'fx', 'auto', 'presets'], soundscape: ['source', 'loopers', 'fx', 'auto', 'presets'], bus: ['fx', 'auto', 'presets'],
}

/** What the headers share. */
export type HeadCtx = {
  doc: Y.Doc
  undo: Y.UndoManager
  store: ProjectStore
  rec: Recorder
  drawers: ReturnType<typeof createDrawers>
  avail: ReturnType<typeof createTabAvailability>
  drive: ReturnType<typeof createMixDrive>
  /** Which buses are folded shut (local view state). */
  collapsed?: ReturnType<typeof createCollapsed>
  /** The tab to open or shut one drawer. */
  toggleTab(id: string, tab: TabName): void
  /** Right-click (and click) on a control offers automation. */
  autoMenu(label: HTMLElement, target: () => ParamTarget, clickToo?: boolean): void
  /** A fader or pan mid-drag: the engine takes the value now (not in the doc)... */
  live(deviceId: string, paramId: number, value: number): void
  /** ...the peers are told (null: the drag is over)... */
  drag(drags: { deviceId: string; paramId: number; value: number }[] | null): void
  /** ...and the final value is written once (one undo step). */
  commit(deviceId: string, paramId: number, value: number): void
}

/** The elements the timeline drives itself, per frame (the level meters write `--l` / `--r` on the fader and `--lv` on the input meter). */
export type HeadRefs = { gain: HTMLInputElement; meter: HTMLElement | null }

/** One button per drawer this scope has. The tabs open and shut drawers in the lane below; they live in the header column only. */
function Tabs(p: { ctx: HeadCtx; id: string; names: TabName[] }) {
  return (
    <div class="tabs">
      <For each={p.names}>{(n) => {
        const open = () => p.ctx.drawers.isOpen(p.id, n)
        return (
          <button class="tab" classList={{ on: open() }} aria-pressed={open()} title={TAB_TITLE[n]}
            hidden={(n === 'auto' || n === 'presets') && !p.ctx.avail.has(p.id, n)} on:click={() => p.ctx.toggleTab(p.id, n)}>{TAB_LABEL[n]}</button>
        )
      }}</For>
    </div>
  )
}

/**
 * The volume fader and pan knob of a track or the master bus: they read and write the scope's mix device (one undo step per
 * gesture), and right-click offers automation. The fader doubles as the level meter. While a lane drives one, it follows the
 * lane (as device knobs do) and can't be dragged.
 */
function MixRow(p: { ctx: HeadCtx; scope: string; refs: (gain: HTMLInputElement) => void }) {
  const { doc, undo, store } = p.ctx
  const mix = () => store.mixDevice(p.scope)
  const drive = () => p.ctx.drive.get(p.scope)
  const gain = (<input type="range" class="gain" min={0} max={1} step="any" title="volume" />) as HTMLInputElement
  ticks(gain, [UNITY_POS]) // 0 dB; the top of the range is +6 dB
  valueTip(gain, () => fmtDb(posToGain(gain.valueAsNumber)))
  // a drag is the live value to the engine and the peers (as a device knob's is); the doc is written once, when it lets go
  const moving = (param: number, v: number) => {
    const m = mix()
    if (!m) return
    p.ctx.live(m.id, param, v)
    p.ctx.drag([{ deviceId: m.id, paramId: param, value: v }])
  }
  const done = (param: number, v: number) => {
    const m = mix()
    if (m) p.ctx.commit(m.id, param, v)
    p.ctx.drag(null)
  }
  gain.addEventListener('input', () => moving(MIX_GAIN, posToGain(gain.valueAsNumber)))
  gain.addEventListener('change', () => done(MIX_GAIN, posToGain(gain.valueAsNumber)))
  const snapPan = (v: number) => (Math.abs(v) < 0.02 ? 0 : v)
  const pan = knob({
    min: -1, max: 1, value: 0, def: 0, bipolar: true, size: 20,
    title: (v) => (Math.abs(v) < 0.005 ? 'pan: centre (double-click to reset)' : `pan: ${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`),
    onInput: (v) => moving(MIX_PAN, snapPan(v)),
    onChange: (v) => done(MIX_PAN, snapPan(v)),
  })
  const target = (param: number) => (): ParamTarget => ({ scope: p.scope, kind: 'effect', owner: mix()?.id ?? '', param: String(param) })
  p.ctx.autoMenu(gain, target(MIX_GAIN), false)
  p.ctx.autoMenu(pan.el, target(MIX_PAN), false)
  p.refs(gain)
  createEffect(() => {
    const g = drive().gain
    gain.disabled = g != null
    const m = mix()
    const peer = m ? store.drags(m.id)().get(MIX_GAIN) : undefined // (a collaborator is dragging it)
    const v = g ?? peer ?? m?.params?.[MIX_GAIN] ?? 1
    if (g != null || !inUse(gain)) gain.value = String(gainToPos(v)) // (not while it is being dragged)
  })
  createEffect(() => {
    const pn = drive().pan
    pan.setDisabled(pn != null)
    const m = mix()
    pan.set(pn ?? (m ? store.drags(m.id)().get(MIX_PAN) : undefined) ?? m?.params?.[MIX_PAN] ?? 0)
  })
  return <div class="ctl gain-row">{gain}{pan.el}</div>
}

const MASTER: Pick<Track, 'id' | 'name' | 'kind' | 'muted' | 'soloed'> = { id: MASTER_TRACK, name: 'master', kind: 'bus', muted: false, soloed: false }

/**
 * A track's header, in `host` (the lane's `.head`, which the menu anchors to). Click or right-click on it, off its controls,
 * offers the track's menu. A bus has the same header (no record button, and a fold button for the tracks under it), and the master
 * bus (`MASTER_TRACK`) is a bus that can't be renamed, muted, soloed, moved or deleted: it has no menu.
 */
export function TrackHead(p: { ctx: HeadCtx; id: string; host: HTMLElement; refs: (r: HeadRefs) => void }) {
  const { doc, store, rec } = p.ctx
  const id = p.id
  const root = id === MASTER_TRACK
  // (the track can be gone from the doc a moment before its lane is: keep showing the last one)
  const track = createMemo<Pick<Track, 'id' | 'name' | 'kind' | 'muted' | 'soloed'>>((prev) => (root ? MASTER : store.trackById[id] ?? prev))
  const locked = () => store.locks().has(id)
  const audio = track().kind === 'audio'
  const bus = track().kind === 'bus'
  const kind = createMemo(() => (root ? { icon: 'mixer' as const, label: 'master bus' } : trackKind(track() as Track, store.devicesByTrack(id)(), store.clipsByTrack(id)())))
  const kindIcon = createMemo(() => kind().icon)
  const kindLabel = createMemo(() => kind().label)
  const glyph = icon('wave', 14)
  createEffect(on(kindIcon, (n) => setIcon(glyph, n)))
  const folded = () => !!p.ctx.collapsed?.isCollapsed(id)
  const chevron = icon('chevron-down', 14)
  createEffect(() => setIcon(chevron, folded() ? 'chevron-right' : 'chevron-down'))

  const [renaming, setRenaming] = createSignal(false)
  const rename = () => !root && setRenaming(true)
  const Name = () => (
    <Show when={renaming()} fallback={<span class="name" on:dblclick={rename}>{track().name}</span>}>
      <input class="rename" value={track().name}
        ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
        on:keydown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') done(e.currentTarget, true)
          if (e.key === 'Escape') done(e.currentTarget, false)
        }}
        on:blur={(e) => done(e.currentTarget, true)} />
    </Show>
  )
  const done = (input: HTMLInputElement, ok: boolean) => {
    if (!renaming()) return
    setRenaming(false)
    if (ok && input.value.trim()) updateTrack(doc, id, { name: input.value.trim() })
  }

  const delTrack = () => !locked() && confirm(bus ? 'delete this bus? the tracks in it move up a level.' : 'delete this track and its clips?') && deleteTrack(doc, id)
  /** "move to bus": the master (no bus) and every bus this track is not in or above, as a menu of its own. */
  const moveMenu = (at: [number, number]) => {
    const tracks = getTracks(doc)
    const now = effectiveParent(tracks).get(id) ?? MASTER_TRACK
    const depth = new Map(treeRows(tracks).map((r) => [r.id, r.depth]))
    const to = (parent: string) => () => void moveTrack(doc, id, { parent, before: null })
    popover(p.host, [
      { label: `${now === MASTER_TRACK ? '✓ ' : ''}master (no bus)`, run: to(MASTER_TRACK), disabled: now === MASTER_TRACK },
      ...busTargets(tracks, id).map((b) => ({ label: `${b.id === now ? '✓ ' : ''}${' '.repeat(depth.get(b.id) ?? 0)}${b.name}`, run: to(b.id), disabled: b.id === now })),
    ], at)
  }
  let menuClosed = false // this press just closed the menu: don't open it again
  const trackMenu = (e: MouseEvent) => {
    if (locked() || root) return
    const at: [number, number] = [e.clientX, e.clientY]
    popover(p.host, [
      ['rename', () => setRenaming(true)],
      ['move to bus ▸', () => moveMenu(at)],
      ['new bus from this track', () => void newBusFrom(doc, id)],
      [bus ? 'delete bus' : 'delete track', () => void delTrack()],
    ], at)
  }
  const press = (e: Event) => (menuClosed = closedBy(e))
  const click = (e: MouseEvent) => {
    if (!menuClosed && !(e.target as HTMLElement).closest('button, input, .knob')) trackMenu(e)
  }
  const context = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation() // not the lane's background menu underneath
    trackMenu(e)
  }
  p.host.addEventListener('pointerdown', press, true)
  p.host.addEventListener('click', click)
  p.host.addEventListener('contextmenu', context)
  onCleanup(() => {
    p.host.removeEventListener('pointerdown', press, true)
    p.host.removeEventListener('click', click)
    p.host.removeEventListener('contextmenu', context)
  })

  let gainEl!: HTMLInputElement
  let meter: HTMLElement | null = null
  const armed = () => rec.armedTrack === id
  const out = (
    <>
      <div class="head-top">
        <Show when={bus && !root} fallback={<span class="kind" data-icon={kindIcon()} title={kindLabel()}>{glyph}</span>}>
          <button class="fold" aria-expanded={!folded()} title={folded() ? 'show the tracks in this bus' : 'fold the tracks in this bus'}
            on:click={() => p.ctx.collapsed?.toggle(id)}>{chevron}</button>
        </Show>
        <Name />
        <Show when={!root}>
          <div class="ctl track-btns">
            <button class="mute" classList={{ on: track().muted }} title="mute"
              on:click={() => updateTrack(doc, id, { muted: !tracksMap(doc).get(id)?.get('muted') })}>M</button>
            <button class="solo" classList={{ on: track().soloed }} title="solo"
              on:click={() => updateTrack(doc, id, { soloed: !tracksMap(doc).get(id)?.get('soloed') })}>S</button>
            <Show when={audio}>
              <button class="record" classList={{ on: armed() }} title="arm for recording" on:click={() => void rec.arm(id)}>R</button>
              <button class="listen" classList={{ on: rec.monitoring }} hidden={!armed()} title="monitor the input through this track's effects (use headphones)"
                on:click={() => rec.toggleMonitoring()}>I</button>
              <i class="meter" hidden={!armed()} title="input level" ref={(el) => (meter = el)} />
            </Show>
          </div>
        </Show>
      </div>
      <MixRow ctx={p.ctx} scope={id} refs={(g) => (gainEl = g)} />
      <Tabs ctx={p.ctx} id={id} names={TABS[track().kind] ?? TABS.audio} />
    </>
  )
  p.refs({ gain: gainEl, meter })
  return out
}

/** Fill `host` (the lane's `.head`) with the header of track `id`; `refs` gets the elements the timeline drives (fader and input meter). */
export function mountTrackHead(host: HTMLElement, ctx: HeadCtx, id: string): { refs: HeadRefs; dispose(): void } {
  let refs!: HeadRefs
  const dispose = render(() => <TrackHead ctx={ctx} id={id} host={host} refs={(r) => (refs = r)} />, host)
  return { refs, dispose }
}
