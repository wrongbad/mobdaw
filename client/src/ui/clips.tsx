// The blocks on the lanes as Solid components: audio and MIDI clips, soundscape regions, loop boxes and heads, and the growing
// regions of takes in progress. Mounted once per lane body with `render()`; they follow the project store, the selection, the
// locks, the zoom and the peers' selections by themselves, so a doc change patches the clips it touches and the playhead moves
// none of them. The canvases (waveforms) and the MIDI widgets (note editor, drum grid) stay imperative, driven by effects.
import { DEVICES, clipLength, deletePad, isForever, isLooping, type AudioClip, type Clip, type MidiClip, type Note, type SampleMeta } from '@mobdaw/shared'
import { render } from 'solid-js/web'
import { For, createEffect, createMemo, createRenderEffect, type Accessor } from 'solid-js'
import { peaksFailed, peaksFor, storedPeaks } from '../audio/peaks'
import { h } from '../dom'
import { playable } from '../samples'
import { sameList } from './deviceCard'
import { clipDown, clipZone, loopBoxDown, padDown, type GestureCtx } from './gestures'
import { drawSeams, drawVisibleWave, newWave } from './clipWave'
import { LOOP_COLORS } from './loopers'
import type { drumGrid } from './drumGrid'
import type { noteEditor } from './noteEditor'
import { deleteMenu, popover } from './popover'

/** A soundscape track's source lane, as the components see it: its own scale and scroll. */
export type SrcView = {
  pps: Accessor<number>
  /** The lane's horizontal scroll (px), as a signal. */
  scrollX: Accessor<number>
  view: HTMLElement
  /** Where each sounding looper's head is (source samples), written every frame while it plays. */
  heads: Accessor<Map<string, number>>
}

export type ClipsCtx = GestureCtx & {
  scale: Accessor<{ pps: number; rate: number }>
  /** The main timeline's extent (samples): a `forever` clip is drawn out to it. */
  total: Accessor<number>
  /** The engine is open (waveforms are drawn from then on). */
  ready: Accessor<boolean>
  /** Counts the peaks that arrived. */
  peaks: Accessor<number>
  /** The scroller's visible width and scroll (px), as signals. */
  viewW: Accessor<number>
  scrollX: Accessor<number>
  scroller: HTMLElement
  header: number
  projectId: string
  ne: ReturnType<typeof noteEditor>
  dg: ReturnType<typeof drumGrid>
  /** The clip's context menu. */
  menu(clipId: string): [string, () => void][]
  /** The label of an incoming take's clip. */
  incomingLabel(m: SampleMeta): string
  /** The take being recorded here, and the transport position (written every frame while it grows). */
  myTake: Accessor<{ trackId: string; start: number } | null>
  position: Accessor<number>
  drawLive(region: HTMLElement, startPx: number, widthPx: number): void
}

const EMPTY: never[] = []

/** Preview of a MIDI clip: its label plus tiny note marks (a looping clip's first pass in full, the repeats faded). */
export function midiPreview(e: HTMLElement, c: Pick<MidiClip, 'view'>, notes: Pick<Note, 'tick' | 'durTicks' | 'pitch'>[], lp: number, extent: number) {
  const shown = lp ? notes.filter((n) => n.tick < lp) : notes
  const lo = Math.min(...shown.map((n) => n.pitch)), hi = Math.max(...shown.map((n) => n.pitch))
  const passes = lp ? Math.ceil(extent / lp) : 1
  const marks: HTMLElement[] = []
  for (let k = 0; k < passes; k++) {
    if (k) { // where the pattern starts over
      const edge = h('i', { className: 'loop-edge' })
      edge.style.left = `${((k * lp) / extent) * 100}%`
      marks.push(edge)
      if (k === 1) { // the pass handle lights up here when hovered
        const first = h('i', { className: 'seam-first' })
        first.style.left = `calc(${(lp / extent) * 100}% - 1px)`
        marks.push(first)
      }
    }
    for (const n of shown) {
      const tick = k * lp + n.tick
      if (tick >= extent) continue
      const m = h('i', { className: k ? 'mark rep' : 'mark' })
      m.style.left = `${(tick / extent) * 100}%`
      m.style.width = `${(Math.min(n.durTicks, lp || Infinity) / extent) * 100}%` // (min-width in the CSS: a % minimum is huge on a forever clip)
      m.style.top = `${hi === lo ? 50 : 20 + ((hi - n.pitch) / (hi - lo)) * 60}%`
      marks.push(m)
    }
  }
  e.replaceChildren(c.view === 'drums' ? 'drums' : 'midi', ...marks)
}

/** One clip. `src`: set for the clips of a soundscape's source lane, which draws them in its own scale. */
function ClipEl(p: { ctx: ClipsCtx; clip: Clip; src: SrcView | null }) {
  const { ctx } = p
  const { store, sel, geo } = ctx
  const c = p.clip
  const rate = () => ctx.scale().rate
  const cpps = () => (p.src ? p.src.pps() : ctx.scale().pps)
  const forever = () => isForever(c)
  /** The clip's drawn length in seconds: a `forever` clip runs out to the end of the scroll area, which its finite part alone decides. */
  const secs = () => (forever() ? Math.max(clipLength(c, rate()), ctx.total() - c.start) : clipLength(c, rate())) / rate()
  const width = () => Math.max(2, secs() * cpps())
  const audio = c.kind === 'audio' // (a clip's kind never changes)
  const meta = () => (audio ? store.samples[(c as AudioClip).sourceHash] : undefined)
  const canPlay = () => !audio || (!!meta() && playable(meta()!))
  const status = () => meta()?.status // incoming and missing audio is drawn from the stored peaks (docs/engine.md §9.3)
  /** An audio clip whose sample is still downloading/decoding: drawn as a pulsing placeholder (with the stored waveform, if any). */
  const loading = () => audio && !!meta() && canPlay() && !status() && !livePeaks() && !peaksFailed((c as AudioClip).sourceHash, rate())
  const livePeaks = () => {
    void ctx.peaks() // (re-read when a decode finishes)
    return ctx.ready() && meta() && canPlay() && !status() ? peaksFor(ctx.projectId, (c as AudioClip).sourceHash, rate()) : undefined
  }
  const label = () => {
    const m = meta()
    if (!m) return '…'
    if (loading()) return `${m.name} · loading…`
    if (status() === 'incoming') return `${m.name} · ${ctx.incomingLabel(m)}`
    if (status() === 'missing') return `${m.name} · audio deleted`
    return canPlay() ? m.name : `${m.name} · too long to play yet`
  }
  const open = () => c.kind === 'midi' && sel.editing === c.id
  let el!: HTMLDivElement

  const w = audio ? newWave() : null
  if (w) {
    createRenderEffect(() => { const t = label(); if (w.label.textContent !== t) w.label.textContent = t })
    createEffect(() => drawSeams(c as AudioClip, w, width(), cpps(), rate()))
    createEffect(() => {
      void [ctx.ready(), ctx.peaks(), ctx.viewW(), p.src ? p.src.scrollX() : ctx.scrollX()] // (redrawn when it scrolls, the zoom, the clip or the peaks change)
      const m = meta()
      const pk = !ctx.ready() || !canPlay() || !m ? undefined : status() ? storedPeaks(m, rate()) : livePeaks() ?? storedPeaks(m, rate())
      if (pk) drawVisibleWave(c as AudioClip, w, pk, width(), p.src ? { pps: cpps(), scroller: p.src.view, off: 0 } : { pps: cpps(), scroller: ctx.scroller, off: ctx.header }, rate())
      else w.cv.style.display = 'none'
    })
  } else {
    // the preview, or the open editor: the drum grid for a `view: 'drums'` clip, else the piano roll
    const notes = () => store.notesByClip(c.id)()
    const notesJson = createMemo(() => JSON.stringify(notes()))
    const instrumentsJson = createMemo(() => JSON.stringify(store.devicesByTrack(c.trackId)().filter((d) => DEVICES[d.type]?.instrument)))
    const m = c as MidiClip
    const extent = () => (forever() ? secs() * m.bpm * m.ppq / 60 : m.lengthTicks)
    createEffect(() => {
      const editor = m.view === 'drums' ? ctx.dg : ctx.ne
      const other = editor === ctx.dg ? ctx.ne : ctx.dg
      if (other.el.parentElement === el) { other.el.remove(); other.reset() }
      if (open()) {
        if (editor.el.parentElement !== el) el.replaceChildren(editor.el)
        const snap = { ...m } as MidiClip
        const list = JSON.parse(notesJson()) as Note[]
        if (editor === ctx.dg) ctx.dg.update(snap, list, JSON.parse(instrumentsJson()), ctx.scale().pps, extent())
        else ctx.ne.update(snap, list, sel.note, ctx.scale().pps, extent())
        return
      }
      if (editor.el.parentElement === el) { editor.el.remove(); editor.reset() }
      const lp = isLooping(m) ? m.loopTicks! : 0
      midiPreview(el, m, notes().map((n) => ({ tick: n.tick, durTicks: n.durTicks, pitch: n.pitch })), lp, extent())
    })
  }

  return (
    <div class="clip" ref={el}
      classList={{
        forever: forever(), looping: isLooping(c), loopable: !p.src && !store.locks().has(c.trackId), midi: !audio,
        editing: open(), sel: sel.clips.includes(c.id), unplayable: !canPlay(), incoming: status() === 'incoming', loading: loading(), missing: status() === 'missing',
      }}
      style={{ left: `${(c.start / rate()) * cpps()}px`, width: `${width()}px`, outline: ctx.store.outlines().has(c.id) ? `2px solid ${ctx.store.outlines().get(c.id)}` : '' }}
      on:pointerdown={(ev) => clipDown(ctx, ev, c.id)}
      on:pointermove={(ev) => { // which handle is under the pointer drives the cursor and the edge highlight (CSS, by data-zone)
        if (ev.buttons) return
        const cur = store.clipById[c.id]
        const zone = cur && !geo.lane(cur.trackId)?.src && !store.locks().has(cur.trackId) ? clipZone(ctx, ev, el, cur) : 'move'
        if (el.dataset.zone !== zone) el.dataset.zone = zone
      }}
      on:contextmenu={(ev) => {
        ev.preventDefault()
        ev.stopPropagation() // not the lane's background menu underneath
        const trackId = store.clipById[c.id]?.trackId
        if (trackId != null && !store.locks().has(trackId)) popover(el, ctx.menu(c.id), [ev.clientX, ev.clientY])
      }}>
      {w ? <>{w.cv}{w.seams}{w.first}{w.label}</> : null}
    </div>
  )
}

/** The clips of one track. */
function Clips(p: { ctx: ClipsCtx; trackId: string; src: SrcView | null }) {
  return <For each={p.ctx.store.clipsByTrack(p.trackId)()}>{(c) => <ClipEl ctx={p.ctx} clip={c} src={p.src} />}</For>
}

/** A soundscape region: a clip-styled block (same edges, same hover) on the main lane during which all of the loopers are on. */
function PadEl(p: { ctx: ClipsCtx; id: string }) {
  const { ctx } = p
  const pad = () => ctx.store.padById[p.id]
  const x = (smp: number) => (smp / ctx.scale().rate) * ctx.scale().pps
  return (
    <div class="clip region" classList={{ sel: ctx.sel.pad === p.id }}
      style={{ left: `${x(pad()?.start ?? 0)}px`, width: `${Math.max(2, x(pad()?.length ?? 0))}px` }}
      on:pointerdown={(ev) => padDown(ctx, ev, p.id)}
      ref={(e) => deleteMenu(e, 'delete region', () => { deletePad(ctx.doc, p.id); ctx.sel.forgetPad(p.id) })}>loopers on</div>
  )
}

/** The coloured region boxes drawn over a soundscape track's source audio. */
function LoopBoxes(p: { ctx: ClipsCtx; trackId: string; src: SrcView }) {
  const { ctx, src } = p
  const { store, sel } = ctx
  const mine = createMemo(() => store.loopers().filter((l) => l.trackId === p.trackId && l.length > 0), EMPTY as ReturnType<typeof store.loopers>, { equals: sameList })
  return (
    <For each={mine()}>{(lp) => (
      <div class="loop-box" classList={{ armed: sel.armedLooper === lp.id }}
        style={{
          '--c': LOOP_COLORS[lp.slot % LOOP_COLORS.length],
          left: `${(lp.start / ctx.scale().rate) * src.pps()}px`, width: `${Math.max(2, (lp.length / ctx.scale().rate) * src.pps())}px`,
        }}
        on:pointerdown={(ev) => loopBoxDown(ctx, ev, lp.id, ev.currentTarget)}><span>{lp.slot + 1}</span></div>
    )}</For>
  )
}

/** One thin playhead per sounding looper, in source time over the source audio. */
function LoopHeads(p: { ctx: ClipsCtx; src: SrcView }) {
  const ids = createMemo(() => [...p.src.heads().keys()], EMPTY as string[], { equals: sameList })
  return (
    <For each={ids()}>{(id) => (
      <div class="loop-head"
        style={{ '--c': LOOP_COLORS[(p.ctx.store.looperById[id]?.slot ?? 0) % LOOP_COLORS.length], left: `${((p.src.heads().get(id) ?? 0) / p.ctx.scale().rate) * p.src.pps()}px` }} />
    )}</For>
  )
}

/** The growing regions of takes in progress on one track: ours, and other people's (from their awareness). */
function RecRegions(p: { ctx: ClipsCtx; trackId: string }) {
  const { ctx } = p
  type Region = { start: number; end: number; label: string; mine: boolean }
  const regions = createMemo(() => {
    const out = new Map<string, Region>()
    const t = ctx.myTake()
    if (t && t.trackId === p.trackId) out.set('me', { start: t.start, end: ctx.position(), label: 'recording', mine: true })
    for (const r of ctx.store.remote()) {
      if (r.recording?.trackId === p.trackId) out.set(`${r.user.username}:${r.recording.trackId}`, { start: r.recording.start, end: r.playhead ?? r.recording.start, label: `${r.user.username} is recording`, mine: false })
    }
    return out
  })
  const keys = createMemo(() => [...regions().keys()], EMPTY as string[], { equals: sameList })
  return (
    <For each={keys()}>{(k) => {
      const r = () => regions().get(k)
      const x = (smp: number) => (smp / ctx.scale().rate) * ctx.scale().pps
      const left = () => x(r()?.start ?? 0)
      const width = () => Math.max(2, x(Math.max(r()?.start ?? 0, r()?.end ?? 0) - (r()?.start ?? 0)))
      let el!: HTMLDivElement
      if (k === 'me') createEffect(() => {
        void [ctx.viewW(), ctx.scrollX()]
        if (ctx.ready() && r()) ctx.drawLive(el, left(), width())
      })
      return <div class="clip recording" ref={el} style={{ left: `${left()}px`, width: `${width()}px` }}>{r()?.label}</div>
    }}</For>
  )
}

/** A lane's body: clips (audio and MIDI lanes) or regions (soundscapes, whose clips are in the source lane), and the takes in progress. */
function LaneBody(p: { ctx: ClipsCtx; trackId: string; kind: string }) {
  const pads = createMemo(() => p.ctx.store.pads().filter((x) => x.trackId === p.trackId), EMPTY as ReturnType<typeof p.ctx.store.pads>, { equals: sameList })
  return (
    <>
      {p.kind === 'soundscape' ? <For each={pads()}>{(pd) => <PadEl ctx={p.ctx} id={pd.id} />}</For> : <Clips ctx={p.ctx} trackId={p.trackId} src={null} />}
      <RecRegions ctx={p.ctx} trackId={p.trackId} />
    </>
  )
}

/** A soundscape's source lane body: the source clips in the lane's own scale, the loop boxes over them and the loopers' heads. */
function SourceBody(p: { ctx: ClipsCtx; trackId: string; src: SrcView }) {
  return (
    <>
      <Clips ctx={p.ctx} trackId={p.trackId} src={p.src} />
      <LoopBoxes ctx={p.ctx} trackId={p.trackId} src={p.src} />
      <LoopHeads ctx={p.ctx} src={p.src} />
    </>
  )
}

/** Render a lane body's blocks into `body` (which keeps its other children). */
export const mountLaneBody = (body: HTMLElement, ctx: ClipsCtx, trackId: string, kind: string) => render(() => <LaneBody ctx={ctx} trackId={trackId} kind={kind} />, body)
export const mountSourceBody = (body: HTMLElement, ctx: ClipsCtx, trackId: string, src: SrcView) => render(() => <SourceBody ctx={ctx} trackId={trackId} src={src} />, body)
