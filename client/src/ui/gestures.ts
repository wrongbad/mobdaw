// The pointer gestures on the timeline's blocks: clips (move, trim, loop, pass), soundscape regions, loop boxes and the
// region a looper is armed to draw. They write the doc live (one undo step per drag) and know the layout only through `Geo`.
import {
  clipLength, clipStart, getPads, isForever, isLooping, loopersMap, padsMap, passLength, clipsMap, tracksMap, updateClip, updateLooper, updatePad,
  type Clip, type Looper, type MidiClip, type TimeMap,
} from '@mobdaw/shared'
import type * as Y from 'yjs'
import type { Accessor } from 'solid-js'
import { MIN_SEC, loopClip, passClip, trimClip } from '../project/actions'
import { softGrid } from './gridSnap'
import { loopMidi, moveMidi, passMidi, trimMidi } from './midiClipOps'
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
  /** The project's time map (bars, beats and where MIDI clips sit). Hold on to the one you get for a drag: it is immutable. */
  map(): TimeMap
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
export function repeatSeams(clips: Clip[], map: TimeMap): number[] {
  const out: number[] = []
  const rate = map.sampleRate
  for (const c of clips) {
    if (!isLooping(c)) continue
    const start = clipStart(c, map)
    const length = clipLength(c, map)
    const end = start + (isForever(c) ? Math.max(length, 600 * rate) : length)
    if (c.kind === 'audio') {
      out.push(...passBoundaries(start, passLength(c, map), c.loopPhase ?? 0, end - 1))
      continue
    }
    // a MIDI pass is a fixed number of ticks, so its seams follow the tempo: each repeat is one pass further in ticks
    for (let k = 1; k < 8192; k++) {
      const at = map.tickToSample(c.startTick + k * c.loopTicks!)
      if (at > end - 1) break
      out.push(at)
    }
  }
  return out
}

/**
 * What a dragged clip snaps to (samples): the timeline start, the playhead and the edges of every other clip and pad,
 * the repeat seams of the looping ones and, for the loop handle, the whole passes of the clip itself.
 */
export function snapTargets(o: {
  position: number; others: Clip[]; pads: { start: number; length: number }[]; map: TimeMap
  /** The loop handle of this clip: where its passes end, from `drawn` samples out. */
  loop?: { start: number; pass: number; phase: number; drawn: number }
}): number[] {
  return [
    0,
    Math.round(o.position),
    ...o.others.flatMap((c) => [clipStart(c, o.map), clipStart(c, o.map) + clipLength(c, o.map)]),
    ...o.pads.flatMap((p) => [p.start, p.start + p.length]),
    ...repeatSeams(o.others, o.map),
    ...(o.loop ? passBoundaries(o.loop.start, o.loop.pass, o.loop.phase, o.loop.start + o.loop.drawn + 600 * o.map.sampleRate) : []),
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
  const seam = looping && !open ? box.left + ((passLength(c, g.geo.map()) - (c.kind === 'audio' ? c.loopPhase ?? 0 : 0)) / g.geo.rate()) * cpps : undefined
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
  const map = geo.map() // (the drag measures against the timeline as it was when the clip was picked up)
  const midi = clip.kind === 'midi' ? (clip as MidiClip) : null
  const s0 = clipStart(clip, map)
  const length = clipLength(clip, map)
  // a `forever` clip's real extent is off screen: the loop handle at its drawn end sets the extent from there
  const drawn = isForever(clip) ? (box.width / cpps) * rate : length
  const pass0 = passLength(clip, map)
  const phase0 = clip.kind === 'audio' && isLooping(clip) ? clip.loopPhase ?? 0 : 0
  const seam0 = s0 + pass0 - phase0
  const pps = geo.pps()
  const snapAt = snapTracker(snapTargets({
    position: geo.position(), map,
    others: store.clips().filter((c) => c.id !== id && !geo.lane(c.trackId)?.src).map((c) => ({ ...c })), // (source lanes keep their own time)
    pads: getPads(doc),
    loop: mode === 'loop' ? { start: s0, pass: pass0, phase: phase0, drawn } : undefined,
  }), (REARM_PX / pps) * rate)
  const tol = (SNAP_PX / pps) * rate
  /**
   * Soft-snap the handle(s) at `edges` (samples, as picked up) moved by `d`: first to the edges of other blocks, else to the bar
   * grid of the zoom (none in a free region), with the snap line. Alt snaps to nothing. `hit`: whether an edge was caught.
   */
  const snapEdges = (m: PointerEvent, edges: number[], d: number) => {
    if (m.altKey) return geo.snapLine(null), { d, hit: false }
    const snap = snapAt(edges[0] + d, edges.length > 1 ? edges[1] - edges[0] : 0, tol)
    if (snap) return geo.snapLine(snap.at), { d: snap.start - edges[0], hit: true }
    const g = softGrid(map, edges.map((e) => e + d), pps, tol)
    geo.snapLine(g ? g.at : null)
    return { d: g ? d + g.shift : d, hit: false }
  }
  dragPointer(ev, {
    onDrag: (m) => {
      if (!clipsMap(doc).has(id)) return
      const dSmp = Math.round(((m.clientX - ev.clientX) / cpps) * rate)
      // (a MIDI clip's ticks are put on the grid by its own edit, unless alt is held or an edge was caught)
      if (mode === 'loop') {
        const r = snapEdges(m, [s0 + drawn], dSmp)
        if (midi) return loopMidi(doc, map, midi, s0 + drawn + r.d, pps, !m.altKey && !r.hit)
        return loopClip(doc, rate, clip, drawn + r.d, srcFrames)
      }
      if (mode === 'pass') {
        const r = snapEdges(m, [seam0], dSmp)
        if (midi) return passMidi(doc, map, midi, seam0 + r.d, pps, !m.altKey && !r.hit)
        return passClip(doc, rate, clip, pass0 + r.d, srcFrames)
      }
      if (mode !== 'move') {
        const edge = mode === 'l' ? s0 : s0 + length
        if (midi) {
          geo.snapLine(null)
          return trimMidi(doc, map, midi, mode, edge + dSmp, pps, !m.altKey, notes0)
        }
        // an audio clip's edge snaps to the same targets, repeat seams included, so it can be trimmed to land on them
        const base = clip.kind === 'audio' && !m.altKey ? trimSnap(snapAt, mode, s0, length, dSmp, tol) : { d: dSmp, at: null as number | null }
        let d = base.d
        let at = base.at
        if (at == null && !m.altKey) { // no edge caught: the bar grid
          const g = softGrid(map, [edge + d], pps, tol)
          if (g) (d += g.shift), (at = g.at)
        }
        geo.snapLine(at)
        return trimClip(doc, rate, clip, mode, d, srcFrames, notes0)
      }
      // Absolute position under the pointer, in the target lane's own scale (source lanes differ).
      const hit = targetAt(g, m.clientY, clip.kind)
      if (hit) curTrack = hit
      const host = hostOf(g, curTrack)
      let start = Math.max(0, Math.round(((m.clientX - grab - host.el.getBoundingClientRect().left) / host.pps) * rate))
      const src = !!geo.lane(curTrack)?.src
      let caught = false
      if (!m.altKey && !src) {
        const hostTol = (SNAP_PX / host.pps) * rate
        const snap = snapAt(start, length, hostTol)
        if (snap) (start = snap.start), (caught = true), geo.snapLine(snap.at)
        else {
          const gr = softGrid(map, [start, start + length], host.pps, hostTol)
          if (gr) start = Math.max(0, start + gr.shift)
          geo.snapLine(gr ? gr.at : null)
        }
      } else geo.snapLine(null)
      if (midi) return moveMidi(doc, map, midi, start, host.pps, !m.altKey && !src && !caught, curTrack)
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
  const map = geo.map()
  const mode = grabAt(ev.clientX, (ev.currentTarget as HTMLElement).getBoundingClientRect())
  sel.selectPad(id)
  g.select([])
  undo.stopCapturing()
  ev.preventDefault()
  dragPointer(ev, {
    onDrag: (m) => {
      if (!padsMap(doc).has(id)) return
      let dSmp = Math.round(((m.clientX - ev.clientX) / geo.pps()) * geo.rate())
      // soft-snap to the bar grid of the zoom (none in a free region; alt: free)
      const edges = mode === 'move' ? [pad.start, pad.start + pad.length] : [mode === 'l' ? pad.start : pad.start + pad.length]
      const gr = m.altKey ? null : softGrid(map, edges.map((e) => e + dSmp), geo.pps(), (SNAP_PX / geo.pps()) * geo.rate())
      geo.snapLine(gr ? gr.at : null)
      if (gr) dSmp += gr.shift
      if (mode === 'move') updatePad(doc, id, { start: Math.max(0, pad.start + dSmp) })
      else {
        const t = trimBlock(mode, pad, dSmp, { minLength: MIN_SEC * geo.rate(), slackLeft: pad.start })
        updatePad(doc, id, { start: t.start, length: t.length })
      }
    },
    onEnd: () => (geo.snapLine(null), undo.stopCapturing()),
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
