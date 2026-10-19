// MIDI clips on the shared timeline: their position and extent are ticks, so a drag turns the pointer's sample into a tick
// (snapped to the bar grid of the zoom in a metered region, to 1/16 notes in a free one) and writes ticks. Pure given the map
// except the functions that take the doc.
import { isLooping, updateClip, updateNote, type MidiClip, type Note, type TimeMap } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { rotateTick, clamp } from './blocks'
import { gridSnapTick } from './gridSnap'

/** The shortest a MIDI clip (or its pass) gets: a 1/16 note. */
export const minTicks = (map: TimeMap) => map.ppq / 4

/** A tick moved onto the grid of the zoom; inside a free region (no grid) it stays where it is, like a clip edge there always did. */
export const quantTick = (map: TimeMap, tick: number, pps: number): number => gridSnapTick(map, tick, pps) ?? tick

/** The tick under a sample, snapped unless `snap` is false (alt held). */
export const tickAt = (map: TimeMap, sample: number, pps: number, snap = true) => {
  const t = map.sampleToTick(sample)
  return snap ? quantTick(map, t, pps) : t
}

/** Where a clip dragged to start at `sample` goes (ticks, never before bar 1 beat 1). */
export const moveTick = (map: TimeMap, sample: number, pps: number, snap = true) => Math.max(0, tickAt(map, sample, pps, snap))

/** The clip's length for an end edge dragged to `endSample`. */
export const lengthForEnd = (map: TimeMap, startTick: number, endSample: number, pps: number, snap = true) =>
  Math.max(minTicks(map), tickAt(map, endSample, pps, snap) - startTick)

/**
 * The left edge dragged to `sample`: the start moves and the clip shortens by the same ticks (`d`, positive = shorter), so the
 * music stays put. The start can't pass bar 1 or the end (the clip keeps a step).
 */
export function trimLeft(map: TimeMap, c: Pick<MidiClip, 'startTick' | 'lengthTicks'>, sample: number, pps: number, snap = true) {
  const end = c.startTick + c.lengthTicks
  const startTick = clamp(tickAt(map, sample, pps, snap), 0, end - minTicks(map))
  return { startTick, lengthTicks: end - startTick, d: startTick - c.startTick }
}

/** Move a clip to start at `sample` (and onto `trackId`). */
export function moveMidi(doc: Y.Doc, map: TimeMap, c: MidiClip, sample: number, pps: number, snap: boolean, trackId?: string) {
  updateClip(doc, c.id, { startTick: moveTick(map, sample, pps, snap), ...(trackId && trackId !== c.trackId ? { trackId } : {}) })
}

/**
 * Resize from either edge, non-destructively (the notes stay whole). `sample` is where the dragged edge now is. The left edge moves
 * every note back by the ticks it moved so the music stays put (notes before the new start go silent but are kept); a looping
 * clip's pattern turns instead, so every repeat stays where it was. The right edge clears a stale pass.
 */
export function trimMidi(doc: Y.Doc, map: TimeMap, c: MidiClip, mode: 'l' | 'r', sample: number, pps: number, snap: boolean, notes0: Pick<Note, 'id' | 'tick'>[]) {
  if (mode === 'r') return updateClip(doc, c.id, { lengthTicks: lengthForEnd(map, c.startTick, sample, pps, snap), loopTicks: 0 })
  const t = trimLeft(map, c, sample, pps, snap)
  const loop = isLooping(c) ? c.loopTicks! : 0
  doc.transact(() => {
    updateClip(doc, c.id, { startTick: t.startTick, lengthTicks: t.lengthTicks })
    for (const n of notes0) updateNote(doc, n.id, { tick: loop && n.tick < loop ? rotateTick(n.tick, t.d, loop) : n.tick - t.d })
  })
}

/** The right edge as the loop handle: the extent becomes `endSample`; a clip that wasn't looping starts to, its length as the pass. */
export function loopMidi(doc: Y.Doc, map: TimeMap, c: MidiClip, endSample: number, pps: number, snap: boolean) {
  updateClip(doc, c.id, {
    lengthTicks: lengthForEnd(map, c.startTick, endSample, pps, snap),
    ...(isLooping(c) ? {} : { loopTicks: c.lengthTicks }),
    ...(c.forever ? { forever: false } : {}),
  })
}

/** The first seam of a looping clip dragged to `seamSample`: the pass becomes that long. */
export function passMidi(doc: Y.Doc, map: TimeMap, c: MidiClip, seamSample: number, pps: number, snap: boolean) {
  const loopTicks = clamp(tickAt(map, seamSample, pps, snap) - c.startTick, minTicks(map), c.lengthTicks)
  updateClip(doc, c.id, { loopTicks })
}
