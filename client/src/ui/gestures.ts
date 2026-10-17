// The pointer gestures on the timeline's blocks: clips (move, trim, loop, pass), soundscape regions, loop boxes and the
// region a looper is armed to draw. They write the doc live (one undo step per drag) and know the layout only through `Geo`.
import {
  clipLength, getPads, isForever, isLooping, loopersMap, padsMap, passLength, clipsMap, tracksMap, updateClip, updateLooper, updatePad,
  type Clip, type Looper,
} from '@mobdaw/shared'
import type * as Y from 'yjs'
import type { Accessor } from 'solid-js'
import { MIN_SEC, loopClip, passClip, trimClip } from '../project/actions'
import type { ProjectStore } from '../project/store'
import type { Selection } from '../project/viewState'
import { clamp, dragPointer, grabAt, passBoundaries, snapTracker, trimBlock, type Grab } from './blocks'

export const SNAP_PX = 8 // a dragged clip snaps to an edge within this many px...
export const REARM_PX = 24 // ...and, once pulled free, only snaps to it again after moving this far away

/** A soundscape track's source lane: its own body, and its own scale. */
export type SrcGeo = { row: HTMLElement; body: HTMLElement; pps: Accessor<number> }
export type LaneGeo = { row: HTMLElement; body: HTMLElement; src: SrcGeo | null }

/** What the gestures need to know about the layout, and the few things they can set in it. */
export type Geo = {
  rate(): number
  /** The main timeline's zoom (pixels per second). */
  pps(): number
  /** The transport position (samples). */
  position(): number
  lane(trackId: string): LaneGeo | undefined
  lanes(): Iterable<[string, LaneGeo]>
  /** The element the lanes live in (the fallback host of a clip). */
  content: HTMLElement
  /** Show the snap line at a sample of the main timeline, or hide it (null). */
  snapLine(at: number | null): void
}

export type GestureCtx = {
  doc: Y.Doc
  undo: Y.UndoManager
  store: ProjectStore
  sel: Selection
  geo: Geo
  /** Select exactly these clips (and tell the peers). */
  select(ids: string[]): void
}

const accepts = (trackKind: string, clipKind: string) => trackKind === clipKind

/**
 * Where each looping clip's pass restarts (samples): one per repeat boundary inside the clip, so a clip
 * can be trimmed to land on the repeats (a `forever` clip's seams go on for ten minutes past its start).
 */
export function repeatSeams(clips: Clip[], rate: number): number[] {
  const out: number[] = []
  for (const c of clips) {
    if (!isLooping(c)) continue
    const period = passLength(c, rate)
    const phase = c.kind === 'audio' ? c.loopPhase ?? 0 : 0
    const end = c.start + (isForever(c) ? Math.max(clipLength(c, rate), 600 * rate) : clipLength(c, rate))
    out.push(...passBoundaries(c.start, period, phase, end - 1))
  }
  return out
}

/**
 * What a dragged clip snaps to (samples): the timeline start, the playhead and the edges of every other clip and pad,
 * the repeat seams of the looping ones and, for the loop handle, the whole passes of the clip itself.
 */
export function snapTargets(o: {
  position: number; others: Clip[]; pads: { start: number; length: number }[]; rate: number
  /** The loop handle of this clip: where its passes end, from `drawn` samples out. */
  loop?: { start: number; pass: number; phase: number; drawn: number }
}): number[] {
  return [
    0,
    Math.round(o.position),
    ...o.others.flatMap((c) => [c.start, c.start + clipLength(c, o.rate)]),
    ...o.pads.flatMap((p) => [p.start, p.start + p.length]),
    ...repeatSeams(o.others, o.rate),
    ...(o.loop ? passBoundaries(o.loop.start, o.loop.pass, o.loop.phase, o.loop.start + o.loop.drawn + 600 * o.rate) : []),
  ]
}

/** An audio clip's trimmed edge, moved by `d` samples, soft-snapped: the corrected `d` and the target it landed on (null: none). */
export function trimSnap(snapAt: ReturnType<typeof snapTracker>, mode: 'l' | 'r', start: number, length: number, d: number, tol: number) {
  const edge = mode === 'l' ? start + d : start + length + d
  const snap = snapAt(edge, 0, tol)
  return { d: snap ? d + snap.at - edge : d, at: snap ? snap.at : null }
}

/** The source's length in frames (audio clips can't reach past it); infinite for MIDI and unknown sources. */
export const sourceFrames = (store: ProjectStore, rate: number, c: Clip) =>
  c.kind === 'audio' ? (store.samples[c.sourceHash]?.duration ?? Infinity) * rate : Infinity

/**
 * Which handle of clip `c` (drawn as `el`) is under the pointer. The right edge loops (the whole height once the clip
 * loops or is open as an editor, else its upper half; the lower half trims); a looping clip's first seam has the pass
 * handle on its lower half.
 */
export function clipZone(g: GestureCtx, ev: PointerEvent, el: HTMLElement, c: Clip): Grab {
  const box = el.getBoundingClientRect()
  const looping = isLooping(c)
  const open = c.kind === 'midi' && c.id === g.sel.editing
  const cpps = g.geo.lane(c.trackId)?.src?.pps() ?? g.geo.pps()
  const seam = looping && !open ? box.left + ((passLength(c, g.geo.rate()) - (c.kind === 'audio' ? c.loopPhase ?? 0 : 0)) / g.geo.rate()) * cpps : undefined
  return grabAt(ev.clientX, box, { y: ev.clientY, looping: looping || open, seam })
}

/**
 * The track a dragged clip would land on: audio clips go to audio lanes or to any soundscape's source
 * lane; MIDI clips to MIDI lanes. Null when the pointer isn't over a valid lane.
 */
export function targetAt(g: GestureCtx, clientY: number, clipKind: string): string | null {
  const within = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return clientY >= r.top && clientY < r.bottom
  }
  for (const [id, l] of g.geo.lanes()) {
    if (clipKind === 'audio' && l.src && within(l.src.row)) return id
    if (within(l.row) && accepts(String(tracksMap(g.doc).get(id)?.get('kind')), clipKind)) return id
  }
  return null
}

/** The element a track's clips are positioned in, and its scale (source lanes differ). */
export function hostOf(g: GestureCtx, trackId: string) {
  const l = g.geo.lane(trackId)
  return l?.src ? { el: l.src.body, pps: l.src.pps() } : { el: l?.body ?? g.geo.content, pps: g.geo.pps() }
}

/** Press on a clip: select it, then (live Yjs updates, rAF-throttled, one undo step per drag) move it or trim, loop or pass its edges. */
export function clipDown(g: GestureCtx, ev: PointerEvent, id: string) {
  const { doc, undo, store, sel, geo } = g
  if (ev.button !== 0) return
  const found = store.clipById[id]
  if (!found) return
  const clip: Clip = { ...found } // (the drag measures from how it was when picked up)
  const rate = geo.rate()
  const el = ev.currentTarget as HTMLElement
  const box = el.getBoundingClientRect()
  const mode = clipZone(g, ev, el, clip)
  sel.pressClip()
  const lane0 = geo.lane(clip.trackId)
  const cpps = lane0?.src ? lane0.src.pps() : geo.pps() // source clips scale with their own lane
  // a click (no drag) on a MIDI clip zooms into its editor; on the open clip's header strip it zooms back out
  const zoom = () => {
    if (clip.kind !== 'midi' || mode !== 'move') return
    sel.toggleEditing(id)
  }
  g.select([id])
  if (lane0?.src || store.locks().has(clip.trackId)) return zoom() // source audio stays anchored: only the loop windows move
  undo.stopCapturing()
  ev.preventDefault()
  const grab = ev.clientX - box.left // where in the clip it was picked up
  let curTrack = clip.trackId
  const srcFrames = sourceFrames(store, rate, clip)
  const notes0 = clip.kind === 'midi' ? store.notesByClip(id)().map((n) => ({ ...n })) : []
  const length = clipLength(clip, rate)
  // a `forever` clip's real extent is off screen: the loop handle at its drawn end sets the extent from there
  const drawn = isForever(clip) ? (box.width / cpps) * rate : length
  const pass0 = passLength(clip, rate)
  const phase0 = clip.kind === 'audio' && isLooping(clip) ? clip.loopPhase ?? 0 : 0
  const seam0 = clip.start + pass0 - phase0
  const pps = geo.pps()
  const snapAt = snapTracker(snapTargets({
    position: geo.position(), rate,
    others: store.clips().filter((c) => c.id !== id && !geo.lane(c.trackId)?.src).map((c) => ({ ...c })), // (source lanes keep their own time)
    pads: getPads(doc),
    loop: mode === 'loop' ? { start: clip.start, pass: pass0, phase: phase0, drawn } : undefined,
  }), (REARM_PX / pps) * rate)
  const tol = (SNAP_PX / pps) * rate
  const snapTo = (m: PointerEvent, at: number, d: number) => { // soft-snap the handle at sample `at` (moved `d`), with the snap line
    const snap = m.altKey ? null : snapAt(at + d, 0, tol)
    geo.snapLine(snap ? snap.at : null)
    return snap ? snap.at - at : d
  }
  dragPointer(ev, {
    onDrag: (m) => {
      if (!clipsMap(doc).has(id)) return
      const dSmp = Math.round(((m.clientX - ev.clientX) / cpps) * rate)
      if (mode === 'loop') return loopClip(doc, rate, clip, drawn + snapTo(m, clip.start + drawn, dSmp), srcFrames)
      if (mode === 'pass') return passClip(doc, rate, clip, pass0 + (clip.kind === 'audio' ? snapTo(m, seam0, dSmp) : dSmp), srcFrames)
      if (mode !== 'move') {
        // an audio clip's edge snaps to the same targets, repeat seams included, so it can be trimmed to land on them
        const t = clip.kind !== 'audio' || m.altKey ? { d: dSmp, at: null } : trimSnap(snapAt, mode, clip.start, length, dSmp, tol)
        geo.snapLine(t.at)
        return trimClip(doc, rate, clip, mode, t.d, srcFrames, notes0)
      }
      // Absolute position under the pointer, in the target lane's own scale (source lanes differ).
      const hit = targetAt(g, m.clientY, clip.kind)
      if (hit) curTrack = hit
      const host = hostOf(g, curTrack)
      let start = Math.max(0, Math.round(((m.clientX - grab - host.el.getBoundingClientRect().left) / host.pps) * rate))
      const snap = m.altKey || geo.lane(curTrack)?.src ? null : snapAt(start, length, (SNAP_PX / host.pps) * rate)
      if (snap) start = snap.start
      geo.snapLine(snap ? snap.at : null)
      updateClip(doc, id, { start, ...(curTrack !== clip.trackId ? { trackId: curTrack } : {}) })
    },
    onEnd: (moved) => {
      geo.snapLine(null)
      undo.stopCapturing()
      if (!moved) zoom()
    },
  })
}

/** Move, or trim either edge of, a soundscape region (the same controls as an audio clip). */
export function padDown(g: GestureCtx, ev: PointerEvent, id: string) {
  const { doc, undo, sel, geo } = g
  if (ev.button !== 0) return
  const found = g.store.padById[id]
  if (!found) return
  const pad = { ...found }
  const mode = grabAt(ev.clientX, (ev.currentTarget as HTMLElement).getBoundingClientRect())
  sel.selectPad(id)
  g.select([])
  undo.stopCapturing()
  ev.preventDefault()
  dragPointer(ev, {
    onDrag: (m) => {
      if (!padsMap(doc).has(id)) return
      const dSmp = Math.round(((m.clientX - ev.clientX) / geo.pps()) * geo.rate())
      if (mode === 'move') updatePad(doc, id, { start: Math.max(0, pad.start + dSmp) })
      else {
        const t = trimBlock(mode, pad, dSmp, { minLength: MIN_SEC * geo.rate(), slackLeft: pad.start })
        updatePad(doc, id, { start: t.start, length: t.length })
      }
    },
    onEnd: () => undo.stopCapturing(),
  })
}

/** Drag a loop window to move it, or either edge to resize it (live in the doc, one undo step). */
export function loopBoxDown(g: GestureCtx, ev: PointerEvent, id: string, el: HTMLElement) {
  const { doc, undo, sel, geo } = g
  if (ev.button !== 0) return
  ev.stopPropagation()
  const found = g.store.looperById[id]
  const l = found && geo.lane(found.trackId)
  if (!found || !l?.src || sel.armedLooper) return
  const lp = { ...found }
  ev.preventDefault()
  const mode = grabAt(ev.clientX, el.getBoundingClientRect())
  const pps = l.src.pps()
  const rate = geo.rate()
  const min = Math.round(MIN_SEC * rate)
  const end = lp.start + lp.length
  undo.stopCapturing()
  dragPointer(ev, {
    onDrag: (m) => {
      if (!loopersMap(doc).has(id)) return
      const d = Math.round(((m.clientX - ev.clientX) / pps) * rate)
      if (mode === 'move') updateLooper(doc, id, { start: Math.max(0, lp.start + d) })
      else if (mode === 'l') {
        const start = clamp(lp.start + d, 0, end - min)
        updateLooper(doc, id, { start, length: end - start })
      } else updateLooper(doc, id, { length: Math.max(min, lp.length + d) })
    },
    onEnd: () => undo.stopCapturing(),
  })
}

/** Drag across a source lane to set an armed looper's region (live in the doc, one undo step). */
export function drawRegion(g: GestureCtx, ev: PointerEvent, lp: Looper, src: SrcGeo) {
  const { doc, undo, sel, geo } = g
  const at = (cx: number) => Math.max(0, Math.round(((cx - src.body.getBoundingClientRect().left) / src.pps()) * geo.rate()))
  let drew = false
  undo.stopCapturing()
  dragPointer(ev, {
    onDrag: (m) => {
      if (Math.abs(m.clientX - ev.clientX) < 4) return // a click doesn't erase the old region
      drew = true
      const a = at(ev.clientX), b = at(m.clientX)
      updateLooper(doc, lp.id, { start: Math.min(a, b), length: Math.abs(b - a) })
    },
    onEnd: () => {
      undo.stopCapturing()
      if (drew) sel.doneDrawing()
    },
  })
}
