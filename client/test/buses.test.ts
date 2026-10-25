import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { MASTER_TRACK, addBus, addTrack, deleteTrack, effectiveParent, getTracks, tracksMap } from '@mobdaw/shared'
import { busTargets, isInSlot, moveTrack, newBus, newBusFrom, slotFor, subtreeOf, treeRows } from '../src/project/buses'

/** master: a, bus(x, y, inner(z)), b */
function project() {
  const doc = new Y.Doc()
  const a = addTrack(doc, 'a')
  const bus = addBus(doc, 'bus')
  const x = addTrack(doc, 'x'), y = addTrack(doc, 'y')
  const inner = addBus(doc, 'inner')
  const z = addTrack(doc, 'z')
  const b = addTrack(doc, 'b')
  const set = (id: string, parent: string) => tracksMap(doc).get(id)!.set('parent', parent)
  set(x, bus); set(y, bus); set(inner, bus); set(z, inner)
  return { doc, a, bus, x, y, inner, z, b }
}
const names = (doc: Y.Doc) => treeRows(getTracks(doc)).map((r) => `${' '.repeat(r.depth)}${getTracks(doc).find((t) => t.id === r.id)!.name}`)

describe('the track list as a tree', () => {
  it('lists a bus right before its tracks, nested buses deeper, with depth, below and ancestors', () => {
    const p = project()
    expect(names(p.doc)).toEqual(['a', 'bus', ' x', ' y', ' inner', '  z', 'b'])
    const rows = treeRows(getTracks(p.doc))
    expect(rows.find((r) => r.id === p.bus)).toMatchObject({ bus: true, kids: 3, below: 4, depth: 0 })
    expect(rows.find((r) => r.id === p.z)).toMatchObject({ parent: p.inner, depth: 2, ancestors: [p.bus, p.inner], bus: false })
  })

  it('marks what a folded bus hides, however deep', () => {
    const p = project()
    const rows = treeRows(getTracks(p.doc), (id) => id === p.bus)
    expect(rows.filter((r) => r.hidden).map((r) => r.id)).toEqual([p.x, p.y, p.inner, p.z])
    expect(treeRows(getTracks(p.doc), (id) => id === p.inner).filter((r) => r.hidden).map((r) => r.id)).toEqual([p.z])
  })

  it('follows order within a parent, not the flat order, and treats a dangling parent as the master', () => {
    const p = project()
    tracksMap(p.doc).get(p.x)!.set('order', 100)
    tracksMap(p.doc).get(p.z)!.set('parent', 'gone')
    expect(names(p.doc)).toEqual(['a', 'bus', ' y', ' inner', ' x', 'z', 'b'])
  })

  it('knows the subtree of a bus', () => {
    const p = project()
    expect([...subtreeOf(treeRows(getTracks(p.doc)), p.bus)].sort()).toEqual([p.bus, p.x, p.y, p.inner, p.z].sort())
  })
})

describe('moving tracks', () => {
  it('into a bus before a sibling, at the end, and out to the master', () => {
    const p = project()
    expect(moveTrack(p.doc, p.a, { parent: p.bus, before: p.y })).toBe(true)
    expect(names(p.doc)).toEqual(['bus', ' x', ' a', ' y', ' inner', '  z', 'b'])
    expect(moveTrack(p.doc, p.a, { parent: p.bus, before: null })).toBe(true)
    expect(names(p.doc)).toEqual(['bus', ' x', ' y', ' inner', '  z', ' a', 'b'])
    expect(moveTrack(p.doc, p.a, { parent: MASTER_TRACK, before: p.bus })).toBe(true)
    expect(names(p.doc)).toEqual(['a', 'bus', ' x', ' y', ' inner', '  z', 'b'])
    expect(tracksMap(p.doc).get(p.a)!.has('parent')).toBe(false)
  })

  it('moves a bus with everything in it', () => {
    const p = project()
    expect(moveTrack(p.doc, p.bus, { parent: MASTER_TRACK, before: null })).toBe(true)
    expect(names(p.doc)).toEqual(['a', 'b', 'bus', ' x', ' y', ' inner', '  z'])
    expect(moveTrack(p.doc, p.inner, { parent: MASTER_TRACK, before: p.a })).toBe(true)
    expect(names(p.doc)).toEqual(['inner', ' z', 'a', 'b', 'bus', ' x', ' y'])
  })

  it('refuses a bus into itself or into its own subtree, and a parent that is not a bus; nothing is written', () => {
    const p = project()
    const before = JSON.stringify(getTracks(p.doc))
    expect(moveTrack(p.doc, p.bus, { parent: p.inner, before: null })).toBe(false)
    expect(moveTrack(p.doc, p.bus, { parent: p.bus, before: null })).toBe(false)
    expect(moveTrack(p.doc, p.a, { parent: p.b, before: null })).toBe(false)
    expect(moveTrack(p.doc, 'nope', { parent: p.bus, before: null })).toBe(false)
    expect(JSON.stringify(getTracks(p.doc))).toBe(before)
  })

  it('is one undo step and a move to where it already is writes nothing', () => {
    const p = project()
    const undo = new Y.UndoManager([tracksMap(p.doc)], { captureTimeout: 0 })
    let updates = 0
    p.doc.on('update', () => updates++)
    expect(moveTrack(p.doc, p.x, { parent: p.bus, before: p.y })).toBe(true)
    expect(updates).toBe(0)
    expect(moveTrack(p.doc, p.a, { parent: p.bus, before: null })).toBe(true)
    expect(updates).toBe(1)
    undo.undo()
    expect(names(p.doc)).toEqual(['a', 'bus', ' x', ' y', ' inner', '  z', 'b'])
  })

  it('lists the buses a track could move into', () => {
    const p = project()
    const tracks = getTracks(p.doc)
    expect(busTargets(tracks, p.a).map((t) => t.id)).toEqual([p.bus, p.inner])
    expect(busTargets(tracks, p.bus).map((t) => t.id)).toEqual([])
    expect(busTargets(tracks, p.inner).map((t) => t.id)).toEqual([p.bus])
  })
})

describe('where a drop would land', () => {
  it('before / after a track, into a bus at the start or end, or at the end of the master', () => {
    const p = project()
    const tracks = getTracks(p.doc)
    expect(slotFor(tracks, p.a, { id: p.y, at: 'before' })).toEqual({ parent: p.bus, before: p.y })
    expect(slotFor(tracks, p.a, { id: p.y, at: 'after' })).toEqual({ parent: p.bus, before: p.inner })
    expect(slotFor(tracks, p.a, { id: p.inner, at: 'after' })).toEqual({ parent: p.bus, before: null })
    expect(slotFor(tracks, p.a, { id: p.bus, at: 'start' })).toEqual({ parent: p.bus, before: p.x })
    expect(slotFor(tracks, p.a, { id: p.bus, at: 'end' })).toEqual({ parent: p.bus, before: null })
    expect(slotFor(tracks, p.a, { id: p.bus, at: 'after' })).toEqual({ parent: MASTER_TRACK, before: p.b })
    expect(slotFor(tracks, p.a, { id: MASTER_TRACK, at: 'end' })).toEqual({ parent: MASTER_TRACK, before: null })
    expect(slotFor(tracks, p.b, { id: MASTER_TRACK, at: 'start' })).toEqual({ parent: MASTER_TRACK, before: p.a })
  })

  it('never counts the dragged track as its own neighbour, and not onto itself, its subtree or a plain track', () => {
    const p = project()
    const tracks = getTracks(p.doc)
    expect(slotFor(tracks, p.x, { id: p.bus, at: 'start' })).toEqual({ parent: p.bus, before: p.y })
    expect(slotFor(tracks, p.x, { id: p.x, at: 'before' })).toBeNull()
    expect(slotFor(tracks, p.bus, { id: p.z, at: 'before' })).toBeNull()
    expect(slotFor(tracks, p.bus, { id: p.inner, at: 'end' })).toBeNull()
    expect(slotFor(tracks, p.a, { id: p.b, at: 'end' })).toBeNull()
  })

  it('knows a slot the track is already in', () => {
    const p = project()
    const tracks = getTracks(p.doc)
    expect(isInSlot(tracks, p.x, { parent: p.bus, before: p.y })).toBe(true)
    expect(isInSlot(tracks, p.x, { parent: p.bus, before: null })).toBe(false)
    expect(isInSlot(tracks, p.b, { parent: MASTER_TRACK, before: null })).toBe(true)
    expect(isInSlot(tracks, p.a, { parent: p.bus, before: null })).toBe(false)
  })
})

describe('making buses', () => {
  it('a bus from a track takes its place (and its bus) and holds it', () => {
    const p = project()
    const id = newBusFrom(p.doc, p.a)!
    expect(names(p.doc)).toEqual(['a bus', ' a', 'bus', ' x', ' y', ' inner', '  z', 'b'])
    expect(getTracks(p.doc).find((t) => t.id === id)).toMatchObject({ kind: 'bus', name: 'a bus' })
    const inBus = newBusFrom(p.doc, p.y)!
    expect(effectiveParent(getTracks(p.doc)).get(inBus)).toBe(p.bus)
    expect(names(p.doc)).toEqual(['a bus', ' a', 'bus', ' x', ' y bus', '  y', ' inner', '  z', 'b'])
    expect(newBusFrom(p.doc, 'nope')).toBeNull()
  })

  it('a bus from a track is one undo step', () => {
    const p = project()
    const undo = new Y.UndoManager([tracksMap(p.doc)], { captureTimeout: 0 })
    newBusFrom(p.doc, p.a)
    undo.undo()
    expect(names(p.doc)).toEqual(['a', 'bus', ' x', ' y', ' inner', '  z', 'b'])
  })

  it('a new bus goes last, in the master or in a bus', () => {
    const p = project()
    const id = newBus(p.doc)
    expect(names(p.doc).at(-1)).toBe('bus 3')
    const sub = newBus(p.doc, p.bus)
    expect(effectiveParent(getTracks(p.doc)).get(sub)).toBe(p.bus)
    expect(names(p.doc).at(-1)).toBe('bus 3')
    expect(id).not.toBe(sub)
  })

  it('deleting a bus leaves its tracks in its place', () => {
    const p = project()
    deleteTrack(p.doc, p.bus)
    expect(names(p.doc)).toEqual(['a', 'x', 'y', 'inner', ' z', 'b'])
  })
})
