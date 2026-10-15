import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addMidiClip, addNote, getNotes, undoScope, updateNote } from '@mobdaw/shared'
import {
  applyPatches, cancelNoteDrag, centrePitch, clampVelocity, gmDrum, gridTicks, hitOpacity, inMarquee, moveGroup, nextVelocity, nudgeVelocity, quantize,
  resizeGroup, shift, snapStep, snapTick, subPx, transpose, velocityAt,
} from '../src/ui/noteOps'

const n = (id: string, tick: number, pitch = 60, durTicks = 480, velocity = 0.8) => ({ id, clipId: 'c', tick, pitch, durTicks, velocity })
const PPQ = 960

describe('grid maths', () => {
  it('turns grid sizes into ticks of the clip ppq, a bar being 4 beats', () => {
    expect(gridTicks(0.25, PPQ)).toBe(240)
    expect(gridTicks(1, 480)).toBe(480)
    expect(gridTicks('bar', PPQ)).toBe(3840)
    expect(gridTicks(1 / 3, PPQ)).toBe(320)
    expect(gridTicks(0, PPQ)).toBe(0)
  })
  it('snaps, and not while alt or ctrl is held', () => {
    expect(snapTick(119, 240)).toBe(0)
    expect(snapTick(121, 240)).toBe(240)
    expect(snapTick(121.4, 0)).toBe(121)
    expect(snapStep(240, { altKey: false, ctrlKey: false })).toBe(240)
    expect(snapStep(240, { altKey: true, ctrlKey: false })).toBe(0)
    expect(snapStep(240, { altKey: false, ctrlKey: true })).toBe(0)
  })
  it('draws sub-beat lines only with room for them', () => {
    expect(subPx(240, PPQ, 48)).toBe(12)
    expect(subPx(240, PPQ, 16)).toBe(0) // 4px apart: too tight
    expect(subPx(PPQ, PPQ, 400)).toBe(0) // the grid is the beat: beat lines already
    expect(subPx(0, PPQ, 400)).toBe(0)
  })
})

describe('quantize', () => {
  it('moves starts to the nearest line and keeps lengths', () => {
    expect(quantize([n('a', 250), n('b', 470, 60, 100), n('c', 480)], 240)).toEqual([{ id: 'a', tick: 240 }, { id: 'b', tick: 480 }])
  })
  it('goes part of the way with a strength, and can fix lengths', () => {
    expect(quantize([n('a', 300)], 240, 0.5)).toEqual([{ id: 'a', tick: 270 }])
    expect(quantize([n('a', 240, 60, 100)], 240, 1, true)).toEqual([{ id: 'a', durTicks: 240 }])
  })
  it('does nothing with the grid off', () => expect(quantize([n('a', 3)], 0)).toEqual([]))
})

describe('transpose, shift and group moves', () => {
  it('transposes, refusing the whole move at the range ends', () => {
    expect(transpose([n('a', 0, 60), n('b', 0, 64)], 12)).toEqual([{ id: 'a', pitch: 72 }, { id: 'b', pitch: 76 }])
    expect(transpose([n('a', 0, 60), n('b', 0, 108)], 1)).toBeNull()
  })
  it('shifts a group and stops it together at tick 0', () => {
    expect(shift([n('a', 100), n('b', 500)], -240)).toEqual([{ id: 'a', tick: 0 }, { id: 'b', tick: 400 }])
    expect(shift([n('a', 0)], -240)).toEqual([])
  })
  it('moves a group clamped as a whole', () => {
    expect(moveGroup([n('a', 100, 60), n('b', 300, 107)], -500, 5)).toEqual([{ id: 'a', tick: 0, pitch: 61 }, { id: 'b', tick: 200, pitch: 108 }])
  })
  it('resizes a group with a floor', () => {
    expect(resizeGroup([n('a', 0, 60, 480), n('b', 0, 60, 100)], -200, 60)).toEqual([{ id: 'a', durTicks: 280 }, { id: 'b', durTicks: 60 }])
  })
})

describe('velocity and drums', () => {
  it('maps lane height to velocity', () => {
    expect(velocityAt(0, 40)).toBe(1)
    expect(velocityAt(20, 40)).toBeCloseTo(0.5)
    expect(velocityAt(40, 40)).toBe(clampVelocity(0))
  })
  it('edits a group relatively, clamped', () => {
    expect(nudgeVelocity([n('a', 0, 60, 1, 0.5), n('b', 0, 60, 1, 0.9)], 0.3).map((p) => p.velocity)).toEqual([0.8, 1])
  })
  it('cycles alt-click velocity and keeps quiet hits visible', () => {
    expect([1, 0.75, 0.5, 0.25].map(nextVelocity)).toEqual([0.75, 0.5, 0.25, 1])
    expect(hitOpacity(0.05)).toBeGreaterThan(0.35)
    expect(hitOpacity(1)).toBe(1)
  })
  it('names GM drums', () => {
    expect(gmDrum(36)).toBe('bass drum')
    expect(gmDrum(38)).toBe('acoustic snare')
    expect(gmDrum(10)).toBeUndefined()
  })
})

describe('marquee and centring', () => {
  it('finds overlapping notes in either corner order', () => {
    const list = [n('a', 0, 60, 100), n('b', 500, 64), n('c', 500, 80)]
    expect(inMarquee(list, 600, 50, 66, 58).map((x) => x.id)).toEqual(['a', 'b'])
  })
  it('centres on the notes, c4 when empty', () => {
    expect(centrePitch([])).toBe(60)
    expect(centrePitch([{ pitch: 40 }, { pitch: 50 }])).toBe(45)
  })
})

describe('a group edit is one undo step', () => {
  it('undoes a multi-note quantize in one go', () => {
    const doc = new Y.Doc()
    const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
    const clip = addMidiClip(doc, { trackId: 't', start: 0 })
    undo.stopCapturing()
    for (const t of [10, 250, 490]) addNote(doc, { clipId: clip, tick: t, durTicks: 100, pitch: 60, velocity: 1 })
    undo.stopCapturing()
    applyPatches(doc, undo, quantize(getNotes(doc), 240))
    expect(getNotes(doc).map((x) => x.tick).sort((a, b) => a - b)).toEqual([0, 240, 480])
    undo.undo()
    expect(getNotes(doc).map((x) => x.tick).sort((a, b) => a - b)).toEqual([10, 250, 490])
  })
})

describe('cancelling a note drag', () => {
  const rig = () => {
    const doc = new Y.Doc()
    const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
    const clip = addMidiClip(doc, { trackId: 't', start: 0 })
    undo.stopCapturing()
    const a = addNote(doc, { clipId: clip, tick: 0, durTicks: 240, pitch: 60, velocity: 1 })
    undo.stopCapturing()
    return { doc, undo, clip, a }
  }
  const note = (doc: Y.Doc, id: string) => getNotes(doc).find((x) => x.id === id)
  it('puts the notes back and leaves the earlier undo step alone', () => {
    const { doc, undo, a } = rig()
    const before = getNotes(doc).map((x) => ({ ...x }))
    const depth = undo.undoStack.length // the add of `a`
    undo.stopCapturing()
    doc.transact(() => updateNote(doc, a, { tick: 480, pitch: 64 })) // the drag
    expect(undo.undoStack.length).toBe(depth + 1)
    cancelNoteDrag(doc, undo, before, [], depth)
    expect(note(doc, a)).toMatchObject({ tick: 0, pitch: 60 })
    expect(undo.undoStack.length).toBe(depth)
    undo.undo() // the user's previous edit (adding the note) is still the one on top
    expect(note(doc, a)).toBeUndefined()
  })
  it('does not undo the previous edit when the drag never wrote anything', () => {
    const { doc, undo, a } = rig()
    const before = getNotes(doc).map((x) => ({ ...x }))
    const depth = undo.undoStack.length
    cancelNoteDrag(doc, undo, before, [], depth)
    expect(note(doc, a)).toBeDefined()
    expect(undo.undoStack.length).toBe(depth)
  })
  it('deletes the copies a drag made and keeps the originals', () => {
    const { doc, undo, clip, a } = rig()
    const before = getNotes(doc).map((x) => ({ ...x }))
    const depth = undo.undoStack.length
    undo.stopCapturing()
    let copy = ''
    doc.transact(() => (copy = addNote(doc, { clipId: clip, tick: 480, durTicks: 240, pitch: 60, velocity: 1 })))
    cancelNoteDrag(doc, undo, before, [copy], depth)
    expect(getNotes(doc).map((x) => x.id)).toEqual([a])
    expect(undo.undoStack.length).toBe(depth)
  })
  it('keeps a step the user added since', () => {
    const { doc, undo, a } = rig()
    const before = getNotes(doc).map((x) => ({ ...x }))
    const depth = undo.undoStack.length
    undo.stopCapturing()
    doc.transact(() => updateNote(doc, a, { tick: 480 }))
    undo.stopCapturing()
    doc.transact(() => updateNote(doc, a, { velocity: 0.5 }))
    cancelNoteDrag(doc, undo, before, [], depth)
    expect(undo.undoStack.length).toBe(depth + 2) // not ours to drop
  })
})
