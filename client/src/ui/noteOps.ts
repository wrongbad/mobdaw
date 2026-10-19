// Pure note edits and grid maths for the piano roll and drum grid (ported from the fork's dock/noteOps). Notes are clip-local
// ticks at the project's ppq; the grid they snap to is the project's time map (bars and beats follow the meter, docs/engine.md §2),
// found at the clip's place on the timeline. In a free (unmetered) region there is no grid: positions only round to whole ticks.
// Nothing here touches the DOM.
import { updateNote, addNote, deleteNote, notesMap, type Note, type TimeMap } from '@mobdaw/shared'
import type * as Y from 'yjs'

export type NotePatch = { id: string; tick?: number; durTicks?: number; pitch?: number; velocity?: number }
export const PITCH_MIN = 12 // c0
export const PITCH_MAX = 108 // c8
export const VEL_MIN = 0.05
/** A bar of 4 quarter notes: the 'bar' grid's length when there is no map to ask. */
export const BEATS_PER_BAR = 4

/** Grid choices: a fraction of a beat, 'bar', or 0 (off). */
export type Grid = number | 'bar'
export const GRIDS: [Grid, string][] = [['bar', 'bar'], [1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [0.125, '1/32'], [1 / 3, '1/8t'], [1 / 6, '1/16t'], [0, 'off']]
export const DEFAULT_GRID: Grid = 0.25

/** A grid as ticks (0: off). 'bar' is `barTicks` long (a 4/4 bar unless the caller knows the meter). */
export function gridTicks(g: Grid, ppq: number, barTicks = ppq * BEATS_PER_BAR): number {
  if (g === 0) return 0
  if (g === 'bar') return barTicks
  return Math.max(1, Math.round(ppq * g))
}

/**
 * Snap a global tick (ticks from bar 1) to the map's grid: 'bar' lines, or steps of `g` quarter notes counted from the start of the
 * bar it is in (the last step of a bar that does not divide evenly is short; the next bar line is always a candidate). 'round' goes
 * to the nearest line, 'floor' to the one at or before. Returns null in a free region (no grid) and when `g` is 0 (off).
 */
export function snapGlobal(map: TimeMap, tick: number, g: Grid, mode: 'round' | 'floor' = 'round'): number | null {
  if (g === 0) return null
  const ppq = map.ppq
  const p = map.position(tick)
  if (p.free) return null
  const barTicks = map.meterAt(p.bar).barTicks
  const barStart = tick - p.tickInBar
  const step = g === 'bar' ? barTicks : Math.min(barTicks, gridTicks(g, ppq))
  const k = p.tickInBar / step
  const lo = Math.floor(k + 1e-9) * step
  if (mode === 'floor') return barStart + lo
  const hi = Math.min(lo + step, barTicks)
  return barStart + (p.tickInBar - lo <= hi - p.tickInBar ? lo : hi)
}

/**
 * A clip-local snapper: takes a note tick (from the clip's start at `startTick`), returns the tick on the map's grid; whole ticks
 * where the grid is off or the clip sits in a free region.
 */
export function localSnap(map: TimeMap, startTick: number, g: Grid, mode: 'round' | 'floor' = 'round'): (tick: number) => number {
  return (t) => {
    const s = snapGlobal(map, startTick + t, g, mode)
    return s == null ? (mode === 'floor' ? Math.floor(t) : Math.round(t)) : s - startTick
  }
}

/** The pattern length of `ticks` in bars from a clip at `startTick` (fractional when it ends inside a bar), and the inverse. */
export function ticksToBars(map: TimeMap, startTick: number, ticks: number): number {
  const at = (t: number) => {
    const p = map.position(t)
    return p.bar + p.tickInBar / map.meterAt(p.bar).barTicks
  }
  return at(startTick + ticks) - at(startTick)
}
export function barsToTicks(map: TimeMap, startTick: number, bars: number): number {
  const p = map.position(startTick)
  const b0 = p.bar + p.tickInBar / map.meterAt(p.bar).barTicks
  return map.barStart(b0 + bars) - startTick
}

/** Round a tick to the grid (`step` 0: only to a whole tick). */
export const snapTick = (tick: number, step: number) => (step > 0 ? Math.round(tick / step) * step : Math.round(tick))
/** The grid line at or before a tick. */
export const floorTick = (tick: number, step: number) => (step > 0 ? Math.floor(tick / step) * step : Math.floor(tick))

/** The step to snap to right now: none while alt or ctrl is held. */
export const snapStep = (step: number, e: { altKey: boolean; ctrlKey: boolean }) => (e.altKey || e.ctrlKey ? 0 : step)

/** Spacing in css px of the grid's own subdivision lines, or 0 when they would be closer than `minPx` (or fall on beats). */
export const subPx = (step: number, ppq: number, pxBeat: number, minPx = 6) => (step > 0 && step < ppq && (step / ppq) * pxBeat >= minPx ? (step / ppq) * pxBeat : 0)

/**
 * Quantize notes to the grid: each start moves `strength` (0..1) of the way to its nearest line. With `lengths`, a length
 * under a step becomes a step and the rest round to the grid. Notes already on the grid give no patch.
 */
export function quantize(notes: Note[], step: number | ((tick: number) => number), strength = 1, lengths = false, minDur?: number): NotePatch[] {
  const snap = typeof step === 'function' ? step : (t: number) => snapTick(t, step)
  const unit = typeof step === 'function' ? minDur ?? 1 : step
  if (!(unit > 0)) return []
  const out: NotePatch[] = []
  for (const n of notes) {
    const target = Math.max(0, snap(n.tick))
    const tick = Math.round(n.tick + (target - n.tick) * Math.min(1, Math.max(0, strength)))
    const dur = !lengths ? n.durTicks : typeof step === 'function' ? Math.max(unit, snap(n.tick + n.durTicks) - target) : Math.max(unit, snapTick(n.durTicks, unit))
    if (tick !== n.tick || dur !== n.durTicks) out.push({ id: n.id, ...(tick !== n.tick ? { tick } : {}), ...(dur !== n.durTicks ? { durTicks: dur } : {}) })
  }
  return out
}

/** Move notes by `semis` semitones; if any would leave the range the whole move is refused (null). */
export function transpose(notes: Note[], semis: number, lo = PITCH_MIN, hi = PITCH_MAX): NotePatch[] | null {
  if (!semis || !notes.length) return []
  if (notes.some((n) => n.pitch + semis < lo || n.pitch + semis > hi)) return null
  return notes.map((n) => ({ id: n.id, pitch: n.pitch + semis }))
}

/** Move notes in time by `dTicks`; the group stops together at tick 0. */
export function shift(notes: Note[], dTicks: number): NotePatch[] {
  if (!notes.length || !dTicks) return []
  const d = Math.max(-Math.min(...notes.map((n) => n.tick)), dTicks)
  return d ? notes.map((n) => ({ id: n.id, tick: n.tick + d })) : []
}

/** Move a group by `dTicks` and `dPitch`, clamped together so no note leaves tick >= 0 or the pitch range. */
export function moveGroup(notes: Note[], dTicks: number, dPitch: number): NotePatch[] {
  if (!notes.length) return []
  const dt = Math.max(-Math.min(...notes.map((n) => n.tick)), dTicks)
  const lo = Math.min(...notes.map((n) => n.pitch)), hi = Math.max(...notes.map((n) => n.pitch))
  const dp = Math.min(PITCH_MAX - hi, Math.max(PITCH_MIN - lo, dPitch))
  return notes.map((n) => ({ id: n.id, tick: n.tick + dt, pitch: n.pitch + dp }))
}

/** Resize a group: each length changes by `dTicks`, floored at `min`. */
export const resizeGroup = (notes: Note[], dTicks: number, min: number): NotePatch[] =>
  notes.map((n) => ({ id: n.id, durTicks: Math.max(min, n.durTicks + dTicks) }))

export const clampVelocity = (v: number) => Math.min(1, Math.max(VEL_MIN, v))
/** Velocity from a pointer height in a lane `height` px tall (`y` from its top). */
export const velocityAt = (y: number, height: number) => clampVelocity(1 - y / Math.max(1, height))
/** Add `d` to every velocity, clamped (a multi-select edit keeps the notes' differences). */
export const nudgeVelocity = (notes: Note[], d: number): NotePatch[] => notes.map((n) => ({ id: n.id, velocity: clampVelocity(n.velocity + d) }))

/** The drum grid's alt-click: full, three quarters, half, a quarter, then full again. */
export const VELOCITY_STEPS = [1, 0.75, 0.5, 0.25]
export function nextVelocity(v: number): number {
  const i = VELOCITY_STEPS.findIndex((s) => v >= s - 0.01)
  return VELOCITY_STEPS[(i < 0 ? 0 : i + 1) % VELOCITY_STEPS.length]
}
/** A hit's opacity: low velocities stay visible. */
export const hitOpacity = (v: number) => 0.35 + 0.65 * clampVelocity(v)

/** The notes that overlap a marquee from tick `t0` to `t1` across pitches `p0..p1` (either order). */
export function inMarquee(notes: Note[], t0: number, t1: number, p0: number, p1: number): Note[] {
  const [ta, tb] = t0 < t1 ? [t0, t1] : [t1, t0]
  const [pa, pb] = p0 < p1 ? [p0, p1] : [p1, p0]
  return notes.filter((n) => n.pitch >= pa && n.pitch <= pb && n.tick < tb && n.tick + n.durTicks > ta)
}

/** The pitch to centre the roll on: the middle of the notes, else c4. */
export const centrePitch = (notes: { pitch: number }[]) => (notes.length ? (Math.min(...notes.map((n) => n.pitch)) + Math.max(...notes.map((n) => n.pitch))) / 2 : 60)

/** The General MIDI percussion names (notes 35..81), for drum rows that carry no name of their own. */
const GM = ['acoustic bass drum', 'bass drum', 'side stick', 'acoustic snare', 'hand clap', 'electric snare', 'low floor tom', 'closed hi-hat', 'high floor tom', 'pedal hi-hat', 'low tom', 'open hi-hat', 'low-mid tom', 'hi-mid tom', 'crash cymbal', 'high tom', 'ride cymbal', 'chinese cymbal', 'ride bell', 'tambourine', 'splash cymbal', 'cowbell', 'crash cymbal 2', 'vibraslap', 'ride cymbal 2', 'hi bongo', 'low bongo', 'mute hi conga', 'open hi conga', 'low conga', 'high timbale', 'low timbale', 'high agogo', 'low agogo', 'cabasa', 'maracas', 'short whistle', 'long whistle', 'short guiro', 'long guiro', 'claves', 'hi wood block', 'low wood block', 'mute cuica', 'open cuica', 'mute triangle', 'open triangle']
export const gmDrum = (pitch: number): string | undefined => GM[pitch - 35]

/** Write patches as one undo step: they are one transaction, bracketed so neighbouring edits do not merge into it. */
export function applyPatches(doc: Y.Doc, undo: Y.UndoManager, patches: NotePatch[]) {
  if (!patches.length) return
  undo.stopCapturing()
  doc.transact(() => patches.forEach(({ id, ...p }) => updateNote(doc, id, p)))
  undo.stopCapturing()
}
/**
 * Roll a note drag back without touching the undo history: the notes go back to `before` (as they were when pressed), copies the
 * drag made (`added`) are deleted, all untracked. The drag's own undo step is dropped only if it is still the top one
 * (`depth` is the undo stack's length when the drag began); a step the user added meanwhile stays where it is.
 */
export function cancelNoteDrag(doc: Y.Doc, undo: Y.UndoManager, before: Note[], added: string[], depth: number) {
  doc.transact(() => {
    for (const id of added) deleteNote(doc, id)
    for (const { id, tick, durTicks, pitch } of before) if (!added.length && notesMap(doc).has(id)) updateNote(doc, id, { tick, durTicks, pitch })
  }, 'note-cancel')
  if (undo.undoStack.length === depth + 1) undo.undoStack.pop()
  undo.stopCapturing()
}
/** Copy notes (offset by `dTicks`) into a clip as one undo step; returns the new ids. */
export function copyNotes(doc: Y.Doc, undo: Y.UndoManager, notes: Note[], dTicks: number, dPitch = 0): string[] {
  undo.stopCapturing()
  const ids: string[] = []
  doc.transact(() => notes.forEach(({ id: _id, ...n }) => ids.push(addNote(doc, { ...n, tick: n.tick + dTicks, pitch: n.pitch + dPitch }))))
  undo.stopCapturing()
  return ids
}
export function removeNotes(doc: Y.Doc, undo: Y.UndoManager, ids: string[]) {
  if (!ids.length) return
  undo.stopCapturing()
  doc.transact(() => ids.forEach((id) => deleteNote(doc, id)))
  undo.stopCapturing()
}
