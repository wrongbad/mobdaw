// A track's header (and the master bus's): name, kind icon, M / S / R / I, input meter, fader and pan, and the drawer tabs. Mounted
// into the lane's `.head` with `render()`. The widgets that are not Solid (`knob`, `ticks`, `valueTip`, `popover`) are used as they are.
import { MASTER_TRACK, MIX_GAIN, MIX_PAN, deleteTrack, setMixParam, tracksMap, updateTrack, type ParamTarget } from '@mobdaw/shared'
import { render } from 'solid-js/web'
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js'
import type * as Y from 'yjs'
import type { Recorder } from '../project/recorder'
import type { ProjectStore } from '../project/store'
import type { createDrawers, createMixDrive, createTabAvailability, TabName } from '../project/viewState'
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
  audio: ['fx', 'auto', 'presets'], midi: ['synth', 'fx', 'auto', 'presets'], soundscape: ['source', 'loopers', 'fx', 'auto', 'presets'], master: ['fx', 'auto'],
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
  /** The tab to open or shut one drawer. */
  toggleTab(id: string, tab: TabName): void
  /** Right-click (and click) on a control offers automation. */
  autoMenu(label: HTMLElement, target: () => ParamTarget, clickToo?: boolean): void
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
  gain.addEventListener('input', () => setMixParam(doc, p.scope, 'gain', posToGain(gain.valueAsNumber)))
  gain.addEventListener('pointerdown', () => undo.stopCapturing())
  const pan = knob({
    min: -1, max: 1, value: 0, def: 0, bipolar: true, size: 20,
    title: (v) => (Math.abs(v) < 0.005 ? 'pan: centre (double-click to reset)' : `pan: ${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`),
    onStart: () => undo.stopCapturing(), // one undo step per gesture
    onInput: (v) => setMixParam(doc, p.scope, 'pan', Math.abs(v) < 0.02 ? 0 : v),
    onChange: () => undo.stopCapturing(),
  })
  const target = (param: number) => (): ParamTarget => ({ scope: p.scope, kind: 'effect', owner: mix()?.id ?? '', param: String(param) })
  p.ctx.autoMenu(gain, target(MIX_GAIN), false)
  p.ctx.autoMenu(pan.el, target(MIX_PAN), false)
  p.refs(gain)
  createEffect(() => {
    const g = drive().gain
    gain.disabled = g != null
    const v = g ?? mix()?.params?.[MIX_GAIN] ?? 1
    if (g != null || !inUse(gain)) gain.value = String(gainToPos(v)) // (not while it is being dragged)
  })
  createEffect(() => {
    const pn = drive().pan
    pan.setDisabled(pn != null)
    pan.set(pn ?? mix()?.params?.[MIX_PAN] ?? 0)
  })
  return <div class="ctl gain-row">{gain}{pan.el}</div>
}

/** The master bus's header: its name, fader and pan, and the tabs of its drawers. */
export function MasterHead(p: { ctx: HeadCtx; refs: (r: HeadRefs) => void }) {
  return (
    <>
      <div class="head-top"><span class="name">master</span></div>
      <MixRow ctx={p.ctx} scope={MASTER_TRACK} refs={(gain) => p.refs({ gain, meter: null })} />
      <Tabs ctx={p.ctx} id={MASTER_TRACK} names={TABS.master} />
    </>
  )
}

/**
 * A track's header, in `host` (the lane's `.head`, which the menu anchors to). Click or right-click on it, off its controls,
 * offers the track's menu.
 */
export function TrackHead(p: { ctx: HeadCtx; id: string; host: HTMLElement; refs: (r: HeadRefs) => void }) {
  const { doc, store, rec } = p.ctx
  const id = p.id
  // (the track can be gone from the doc a moment before its lane is: keep showing the last one)
  const track = createMemo<ReturnType<typeof store.tracks>[number]>((prev) => store.trackById[id] ?? prev)
  const locked = () => store.locks().has(id)
  const audio = track().kind === 'audio'
  const kind = createMemo(() => trackKind(track(), store.devicesByTrack(id)(), store.clipsByTrack(id)()))
  const kindIcon = createMemo(() => kind().icon)
  const kindLabel = createMemo(() => kind().label)
  const glyph = icon('wave', 14)
  createEffect(on(kindIcon, (n) => setIcon(glyph, n)))

  const [renaming, setRenaming] = createSignal(false)
  const rename = () => setRenaming(true)
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

  const delTrack = () => !locked() && confirm('delete this track and its clips?') && deleteTrack(doc, id)
  let menuClosed = false // this press just closed the menu: don't open it again
  const trackMenu = (e: MouseEvent) => {
    if (locked()) return
    popover(p.host, [
      ['rename', () => setRenaming(true)],
      ['delete track', () => void delTrack()],
    ], [e.clientX, e.clientY])
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
        <span class="kind" data-icon={kindIcon()} title={kindLabel()}>{glyph}</span>
        <Name />
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
      </div>
      <MixRow ctx={p.ctx} scope={id} refs={(g) => (gainEl = g)} />
      <Tabs ctx={p.ctx} id={id} names={TABS[track().kind] ?? TABS.audio} />
    </>
  )
  p.refs({ gain: gainEl, meter })
  return out
}

export const mountMasterHead = (host: HTMLElement, ctx: HeadCtx, refs: (r: HeadRefs) => void) => render(() => <MasterHead ctx={ctx} refs={refs} />, host)

/** Fill `host` (the lane's `.head`) with the header of track `id`; `refs` gets the elements the timeline drives (fader and input meter). */
export function mountTrackHead(host: HTMLElement, ctx: HeadCtx, id: string): { refs: HeadRefs; dispose(): void } {
  let refs!: HeadRefs
  const dispose = render(() => <TrackHead ctx={ctx} id={id} host={host} refs={(r) => (refs = r)} />, host)
  return { refs, dispose }
}
