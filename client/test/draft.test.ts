import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import {
  addAudioClip, addLane, addMidiClip, addNote, addPoint, addTrack, getClips, getNotes, getPoints, undoScope, type AwarenessState, type Moving,
} from '@mobdaw/shared'
import { commitMoving, mergeMoving, sliderDraft } from '../src/project/draft'
import { createProjectStore } from '../src/project/store'
import { remoteKey } from '../src/project/presence'

const rig = () => {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
  let states: AwarenessState[] = []
  const sent: (Moving | null)[] = []
  const store = createProjectStore({ doc, awareness, remoteStates: () => states, setLocal: (p) => sent.push(p.moving) })
  const track = addTrack(doc, 't', 'audio')
  const clip = addAudioClip(doc, { trackId: track, sourceHash: 'h', start: 0, length: 1000 })
  undo.stopCapturing()
  let updates = 0
  doc.on('update', () => updates++)
  return {
    doc, undo, store, track, clip, sent, updates: () => updates,
    peers: (s: AwarenessState[]) => ((states = s), awareness.emit('change', [{ added: [], updated: [], removed: [] }, 'test'])),
  }
}
const peer = (moving: Moving | null): AwarenessState => ({ user: { username: 'p', color: 'red' }, moving })

afterEach(() => vi.useRealTimers())

describe('a drag is a draft until it is dropped', () => {
  it('shows in the store at once and writes nothing to the doc', () => {
    const r = rig()
    r.store.setDraft({ clips: { [r.clip]: { start: 500 } } })
    r.store.setDraft({ clips: { [r.clip]: { start: 700 } } })
    expect(r.store.clipById[r.clip].start).toBe(700)
    expect(getClips(r.doc)[0].kind === 'audio' && getClips(r.doc)[0].start).toBe(0)
    expect(r.updates()).toBe(0)
    expect(r.undo.undoStack.length).toBe(1) // (only the setup)
    r.store.dispose()
  })

  it('the drop is exactly one transaction and one undo step', () => {
    const r = rig()
    const d: Moving = { clips: { [r.clip]: { start: 700, length: 300 } } }
    r.store.setDraft(d)
    commitMoving(r.doc, r.undo, d)
    r.store.clearDraft()
    expect(r.updates()).toBe(1)
    expect(r.store.clipById[r.clip]).toMatchObject({ start: 700, length: 300 })
    expect(r.undo.undoStack.length).toBe(2)
    r.undo.undo()
    expect(r.store.clipById[r.clip]).toMatchObject({ start: 0, length: 1000 })
    r.store.dispose()
  })

  it('a cancel clears the draft and leaves the doc and the undo stack alone', () => {
    const r = rig()
    r.store.setDraft({ clips: { [r.clip]: { start: 700 } } })
    r.store.clearDraft()
    expect(r.store.clipById[r.clip].start).toBe(0)
    expect(r.updates()).toBe(0)
    expect(r.undo.undoStack.length).toBe(1)
    r.store.dispose()
  })

  it('a note copy is a draft-only entity until the drop, then added under the same id', () => {
    const r = rig()
    const mc = addMidiClip(r.doc, { trackId: r.track, startTick: 0, lengthTicks: 3840 })
    const n = addNote(r.doc, { clipId: mc, tick: 0, durTicks: 240, pitch: 60, velocity: 1 })
    r.undo.stopCapturing()
    const before = r.updates()
    const copy = { id: 'copy1', clipId: mc, tick: 480, durTicks: 240, pitch: 62, velocity: 1 }
    r.store.setDraft({ notes: { copy1: copy, [n]: { tick: 0 } } })
    expect(r.store.notesByClip(mc)().map((x) => x.id).sort()).toEqual(['copy1', n].sort())
    expect(getNotes(r.doc)).toHaveLength(1)
    commitMoving(r.doc, r.undo, { notes: { copy1: copy } })
    r.store.clearDraft()
    expect(r.updates()).toBe(before + 1)
    expect(getNotes(r.doc).map((x) => x.id).sort()).toEqual(['copy1', n].sort())
    r.undo.undo()
    expect(getNotes(r.doc).map((x) => x.id)).toEqual([n])
    r.store.dispose()
  })

  it('a null in the draft hides the entity (a point drawn over) and the drop deletes it', () => {
    const r = rig()
    const lane = addLane(r.doc, { scope: r.track, kind: 'effect', owner: 'x', param: '1' } as never, { min: 0, max: 1, def: 0 } as never)
    const p = addPoint(r.doc, lane, 10, 0.5)
    expect(r.store.pointById[p]).toBeDefined()
    r.store.setDraft({ points: { [p]: null } })
    expect(r.store.pointById[p]).toBeUndefined()
    commitMoving(r.doc, r.undo, { points: { [p]: null } })
    r.store.clearDraft()
    expect(getPoints(r.doc).find((x) => x.id === p)).toBeUndefined()
    r.store.dispose()
  })

  it('an entity deleted meanwhile is skipped on the drop', () => {
    const r = rig()
    const d: Moving = { clips: { gone: { start: 5 } } }
    commitMoving(r.doc, r.undo, d)
    expect(r.updates()).toBe(0)
    r.store.dispose()
  })
})

describe('the peers\' drafts', () => {
  it('lay over the doc in the store, and go when the peer lets go', () => {
    const r = rig()
    r.peers([peer({ clips: { [r.clip]: { start: 123 } } })])
    expect(r.store.clipById[r.clip].start).toBe(123)
    expect(r.updates()).toBe(0)
    r.peers([peer(null)])
    expect(r.store.clipById[r.clip].start).toBe(0)
    r.store.dispose()
  })
  it('our own draft wins over a peer\'s, field by field', () => {
    const r = rig()
    r.peers([peer({ clips: { [r.clip]: { start: 123, length: 50 } } })])
    r.store.setDraft({ clips: { [r.clip]: { start: 7 } } })
    expect(r.store.clipById[r.clip]).toMatchObject({ start: 7, length: 50 })
    r.store.dispose()
  })
  it('a peer\'s patch for an entity that is not here is ignored unless it is a whole one', () => {
    const r = rig()
    r.peers([peer({ clips: { nope: { start: 1 } } })])
    expect(r.store.clipById.nope).toBeUndefined()
    r.store.dispose()
  })
  it('remoteKey follows the draft', () => {
    expect(remoteKey([peer({ clips: { a: { start: 1 } } })])).not.toBe(remoteKey([peer(null)]))
  })
})

describe('publishing', () => {
  it('sends the draft to the peers at most every so often, and null at once when it ends', () => {
    vi.useFakeTimers()
    const r = rig()
    for (let i = 1; i <= 20; i++) r.store.setDraft({ clips: { [r.clip]: { start: i } } })
    expect(r.sent).toHaveLength(0)
    vi.advanceTimersByTime(100)
    expect(r.sent).toEqual([{ clips: { [r.clip]: { start: 20 } } }])
    r.store.clearDraft()
    expect(r.sent.at(-1)).toBeNull()
    r.store.clearDraft() // (nothing to end)
    expect(r.sent).toHaveLength(2)
    r.store.dispose()
  })
  it('a draft that ends before it was sent is never sent', () => {
    vi.useFakeTimers()
    const r = rig()
    r.store.setDraft({ clips: { [r.clip]: { start: 1 } } })
    r.store.clearDraft()
    vi.advanceTimersByTime(100)
    expect(r.sent).toEqual([null])
    r.store.dispose()
  })
})

describe('mergeMoving', () => {
  it('lays later drafts over earlier ones field by field', () => {
    expect(mergeMoving({ clips: { a: { start: 1, length: 2 } } }, null, { clips: { a: { start: 3 } }, notes: { n: { tick: 1 } } })).toEqual({ clips: { a: { start: 3, length: 2 } }, notes: { n: { tick: 1 } } })
  })
})

describe('a slider', () => {
  it('is a draft while it moves and one write, one undo step, on release', () => {
    const r = rig()
    const s = sliderDraft(r.store, r.doc, r.undo)
    for (const v of [0.1, 0.5, 0.9]) s.set({ clips: { [r.clip]: { gain: v } } })
    expect(r.store.clipById[r.clip]).toMatchObject({ gain: 0.9 })
    expect(r.updates()).toBe(0)
    s.release()
    expect(r.updates()).toBe(1)
    expect(r.undo.undoStack.length).toBe(2)
    expect(r.store.clipById[r.clip]).toMatchObject({ gain: 0.9 })
    s.release() // (a second release has nothing to write)
    expect(r.updates()).toBe(1)
    r.store.dispose()
  })
})
