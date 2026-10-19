// Doc writes behind the timeline's gestures and menus: no DOM, no playback, so they can be tested on a bare doc.
import type * as Y from 'yjs'
import {
  DEVICES, addAudioClip, addLane, addPoint, addTrack, deleteClip, getDevices, getPoints, getPpq, getTimeMap, isLooping, nextTrackColor, getTracks, orderBetween, paramToPos, resolveTarget,
  setLaneState, setParam, updateClip, updateDevice, updateNote, type Clip, type Note, type ParamTarget,
} from '@mobdaw/shared'
import { clamp, rotatePhase, rotateTick, trimBlock } from '../ui/blocks'

export const MIN_SEC = 0.05 // the shortest a clip, loop window or pass can be made

/**
 * MIDI clip lengths live in project ticks and snap to 1/16 notes (ppq / 4). Sample distances from the clip start go through the
 * project's time map, so a drag over a tempo change or a ramp lands where the pointer is. (`rate` is the audio branch's; MIDI uses the map's.)
 */
const midiStep = (doc: Y.Doc) => getPpq(doc) / 4
/** Ticks from a MIDI clip's start to `extent` samples after it. */
function ticksAfter(doc: Y.Doc, clip: { startTick: number }, extent: number) {
  const map = getTimeMap(doc)
  return map.sampleToTick(map.tickToSampleExact(clip.startTick) + extent) - clip.startTick
}

/** One undo step each: a knob's final value, or several params at once (a preset, a filter drag). */
export function commitParam(doc: Y.Doc, undo: Y.UndoManager, device: string, param: number, value: number) {
  undo.stopCapturing()
  setParam(doc, device, param, value)
  undo.stopCapturing()
}
export function commitParams(doc: Y.Doc, undo: Y.UndoManager, device: string, values: Record<number, number>) {
  undo.stopCapturing()
  for (const [p, v] of Object.entries(values)) setParam(doc, device, Number(p), v)
  undo.stopCapturing()
}

/** Drop a card before `before` (the end of its row when null); instruments and effects are separate rows. */
export function reorderDevice(doc: Y.Doc, undo: Y.UndoManager, id: string, before: string | null) {
  const dev = getDevices(doc).find((x) => x.id === id)
  if (!dev) return
  const synth = !!DEVICES[dev.type]?.instrument
  const chain = getDevices(doc).filter((x) => x.trackId === dev.trackId && x.id !== id && !!DEVICES[x.type]?.instrument === synth)
  const i = before == null ? chain.length : chain.findIndex((x) => x.id === before)
  if (i < 0) return
  undo.stopCapturing()
  updateDevice(doc, id, { order: orderBetween(chain[i - 1]?.order, chain[i]?.order) })
  undo.stopCapturing()
}

/** Automate a param: a lane that starts flat at its current value, so nothing changes until a point is moved (or, with `lfo`, one in LFO mode). */
export function automateParam(doc: Y.Doc, t: ParamTarget, lfo = false) {
  const r = resolveTarget(doc, t)
  if (!r) return false
  doc.transact(() => {
    const id = addLane(doc, t, r.def)
    if (!getPoints(doc).some((p) => p.laneId === id)) addPoint(doc, id, 0, paramToPos(r.def, r.value), r.def.options ? 'hold' : 'linear')
    if (lfo) setLaneState(doc, id, 'lfo')
  })
  return true
}

/** The fields that make a non-looping clip's current length its pass, dropping any stale pass first (its phase moves into the source offset). */
export function startPass(clip: Clip & { kind: 'audio' }, srcFrames: number) {
  const sourceOffset = clip.sourceOffset + (clip.loopLength ? clip.loopPhase ?? 0 : 0)
  return { sourceOffset, loopLength: Math.min(clip.length, srcFrames - sourceOffset), loopPhase: 0 }
}

/**
 * Drag a clip's right edge to change its extent to `extent` samples; the pass repeats to fill it. A clip that wasn't
 * looping starts to, with its current length as the pass. Dragging it back to a pass or less ends the loop (isLooping),
 * and a `forever` clip stops being forever.
 */
export function loopClip(doc: Y.Doc, rate: number, clip: Clip, extent: number, srcFrames: number) {
  const looping = isLooping(clip)
  const forever = clip.forever ? { forever: false } : {}
  if (clip.kind === 'audio') {
    updateClip(doc, clip.id, { length: Math.max(Math.round(MIN_SEC * rate), Math.round(extent)), ...(looping ? {} : startPass(clip, srcFrames)), ...forever })
    return
  }
  const step = midiStep(doc)
  const lengthTicks = Math.max(step, Math.round(ticksAfter(doc, clip, extent) / step) * step)
  updateClip(doc, clip.id, { lengthTicks, ...(looping ? {} : { loopTicks: clip.lengthTicks }), ...forever })
}

/** Drag a looping clip's first seam: the pass becomes `pass` samples (audio) or ticks' worth (MIDI, in 1/16 steps) and the repeats re-tile. */
export function passClip(doc: Y.Doc, rate: number, clip: Clip, pass: number, srcFrames: number) {
  if (clip.kind === 'audio') {
    const lo = Math.round(MIN_SEC * rate) + (clip.loopPhase ?? 0) // the first seam stays after the clip's start
    updateClip(doc, clip.id, { loopLength: Math.round(clamp(pass, lo, Math.max(lo, Math.min(clip.length, srcFrames - clip.sourceOffset)))) })
    return
  }
  const step = midiStep(doc)
  updateClip(doc, clip.id, { loopTicks: clamp(Math.round(ticksAfter(doc, clip, pass) / step) * step, step, clip.lengthTicks) })
}

/**
 * Resize a clip from either edge, non-destructively (the source audio and the notes stay whole;
 * dragging the edge back out restores them). `dSmp` is the pointer delta since the grab.
 */
export function trimClip(doc: Y.Doc, rate: number, clip: Clip, mode: 'l' | 'r', dSmp: number, srcFrames: number, notes0: Note[]) {
  const minLength = MIN_SEC * rate
  if (clip.kind === 'audio') {
    if (isLooping(clip)) { // the left edge turns the pass instead (the seams stay put); the right edge is the loop handle
      const t = trimBlock('l', clip, dSmp, { minLength, slackLeft: clip.start })
      updateClip(doc, clip.id, { start: t.start, length: t.length, loopPhase: rotatePhase(clip.loopPhase ?? 0, t.d, clip.loopLength!) })
      return
    }
    // a stale pass (the clip was pulled back to a pass or less) goes, so trimming it longer can't start it looping
    const stale = clip.loopLength ? { loopLength: 0, loopPhase: 0 } : {}
    const sourceOffset = clip.sourceOffset + (clip.loopLength ? clip.loopPhase ?? 0 : 0)
    const t = trimBlock(mode, clip, dSmp, { minLength, slackLeft: Math.min(sourceOffset, clip.start), maxLength: srcFrames - sourceOffset })
    updateClip(doc, clip.id, { ...stale, ...(mode === 'l' ? { start: t.start, length: t.length, sourceOffset: sourceOffset + t.d } : { length: t.length, sourceOffset }) })
    return
  }
  // MIDI: lengths are in ticks, snapped to 1/16 notes
  const step = midiStep(doc)
  const map = getTimeMap(doc)
  const s0 = map.tickToSampleExact(clip.startTick)
  if (mode === 'r') {
    const end = map.sampleToTick(map.tickToSampleExact(clip.startTick + clip.lengthTicks) + dSmp) - clip.startTick
    updateClip(doc, clip.id, { lengthTicks: Math.max(step, Math.round(end / step) * step), loopTicks: 0 }) // (clears a stale pass)
    return
  }
  // Left edge: the start moves and every note moves back by the same ticks, so the music stays put on the
  // timeline. Notes pushed before the new start go silent but are kept, and return if the edge is dragged out.
  // A looping clip's pattern turns instead: the notes rotate within the loop, so every repeat stays where it was.
  const dRaw = map.sampleToTick(s0 + dSmp) - clip.startTick
  const d = clamp(Math.round(dRaw / step) * step, Math.ceil(-clip.startTick / step) * step, clip.lengthTicks - step) // (ticks, positive = shorter; the start can't pass 0)
  const t = { startTick: clip.startTick + d, lengthTicks: clip.lengthTicks - d, d }
  const loop = isLooping(clip) ? clip.loopTicks! : 0
  doc.transact(() => {
    updateClip(doc, clip.id, { startTick: t.startTick, lengthTicks: t.lengthTicks })
    for (const n of notes0) updateNote(doc, n.id, { tick: loop && n.tick < loop ? rotateTick(n.tick, t.d, loop) : n.tick - t.d })
  })
}

/** Clip menu: "loop forever" / "loop to end" on a clip that loops (toggle), else it starts looping with two passes. */
export function loopForever(doc: Y.Doc, clip: Clip, srcFrames: number) {
  if (isLooping(clip)) return updateClip(doc, clip.id, { forever: !clip.forever })
  // not looping yet: the current length becomes the pass and the extent grows to two of them, so it repeats at all
  if (clip.kind === 'audio') updateClip(doc, clip.id, { ...startPass(clip, srcFrames), length: clip.length * 2, forever: true })
  else updateClip(doc, clip.id, { loopTicks: clip.lengthTicks, lengthTicks: clip.lengthTicks * 2, forever: true })
}

/** Clip menu: "no loop" puts the extent back to the first pass. */
export function unloopClip(doc: Y.Doc, clip: Clip) {
  if (clip.kind === 'audio') updateClip(doc, clip.id, { sourceOffset: clip.sourceOffset + (clip.loopPhase ?? 0), length: clip.loopLength! - (clip.loopPhase ?? 0), loopLength: 0, loopPhase: 0, forever: false })
  else updateClip(doc, clip.id, { lengthTicks: clip.loopTicks!, loopTicks: 0, forever: false })
}

export const deleteClips = (doc: Y.Doc, ids: string[]) => doc.transact(() => ids.forEach((id) => deleteClip(doc, id)))

/** A dropped or picked audio file becomes a clip at `at` (on a new track named for the file when `trackId` is null); returns the track. */
export function addImportedClip(doc: Y.Doc, trackId: string | null, file: { name: string; hash: string; length: number }, at: number) {
  doc.transact(() => {
    trackId ??= addTrack(doc, file.name.replace(/\.[^.]+$/, ''), 'audio', undefined, undefined, nextTrackColor(getTracks(doc)))
    addAudioClip(doc, { trackId, sourceHash: file.hash, start: at, length: file.length })
  })
  return trackId!
}
