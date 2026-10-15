import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { createEffect, createRoot } from 'solid-js'
import { addAudioClip, addDevice, addNote, addTrack, deleteClip, deleteTrack, updateClip, updateDevice, updateTrack, tracksMap, MIX, setParam, type AwarenessState } from '@mobdaw/shared'
import { createProjectStore } from '../src/project/store'

const setup = () => {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  let states: AwarenessState[] = []
  const store = createProjectStore({ doc, awareness, remoteStates: () => states })
  return { doc, awareness, store, peers: (s: AwarenessState[]) => ((states = s), awareness.emit('change', [{ added: [], updated: [], removed: [] }, 'test'])) }
}
const clip = (doc: Y.Doc, trackId: string, start: number) => addAudioClip(doc, { trackId, sourceHash: 'h', start, length: 100 })

describe('project store', () => {
  it('loads what is in the doc and follows adds', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'one')
    const store = createProjectStore({ doc, awareness: new Awareness(doc), remoteStates: () => [] })
    expect(store.tracks().map((x) => x.id)).toEqual([t])
    const t2 = addTrack(doc, 'two')
    expect(store.tracks().map((x) => x.name)).toEqual(['one', 'two'])
    expect(store.trackById[t2].kind).toBe('audio')
    store.dispose()
  })

  it('a single-entity change keeps every other entity object', () => {
    const { doc, store } = setup()
    const t = addTrack(doc, 'a')
    const a = clip(doc, t, 0), b = clip(doc, t, 500)
    const before = { a: store.clipById[a], b: store.clipById[b], t: store.trackById[t], list: store.clips() }
    updateClip(doc, a, { start: 50 })
    expect(store.clipById[a].start).toBe(50)
    expect(store.clipById[a]).toBe(before.a) // (reconciled in place)
    expect(store.clipById[b]).toBe(before.b)
    expect(store.trackById[t]).toBe(before.t)
    expect(store.clips()).toBe(before.list) // same members, same order: the list is untouched
    expect(store.clipsByTrack(t)()[0]).toBe(before.a)
    store.dispose()
  })

  it('only subscribers of the changed entity and field run', () => {
    const { doc, store } = setup()
    const t = addTrack(doc, 'a')
    const a = clip(doc, t, 0), b = clip(doc, t, 500)
    const runs = { a: 0, b: 0, list: 0 }
    const dispose = createRoot((d) => {
      createEffect(() => { store.clipById[a].start; runs.a++ })
      createEffect(() => { store.clipById[b].start; runs.b++ })
      createEffect(() => { store.clipsByTrack(t)(); runs.list++ })
      return d
    })
    expect(runs).toEqual({ a: 1, b: 1, list: 1 })
    updateClip(doc, a, { start: 7 })
    expect(runs).toEqual({ a: 2, b: 1, list: 1 })
    dispose()
    store.dispose()
  })

  it('handles deletes, including a track with its clips', () => {
    const { doc, store } = setup()
    const t = addTrack(doc, 'a'), u = addTrack(doc, 'b')
    const a = clip(doc, t, 0), b = clip(doc, u, 0)
    const ub = store.clipById[b]
    deleteClip(doc, a)
    expect(store.clipById[a]).toBeUndefined()
    expect(store.clips().map((c) => c.id)).toEqual([b])
    expect(store.clipsByTrack(t)()).toEqual([])
    deleteTrack(doc, t)
    expect(store.tracks().map((x) => x.id)).toEqual([u])
    expect(store.devicesByTrack(t)()).toEqual([]) // (its mix device went too)
    expect(store.clipById[b]).toBe(ub)
    store.dispose()
  })

  it('follows order changes of tracks and devices', () => {
    const { doc, store } = setup()
    const t = addTrack(doc, 'a'), u = addTrack(doc, 'b')
    expect(store.tracks().map((x) => x.id)).toEqual([t, u])
    const ta = store.trackById[t], tb = store.trackById[u]
    updateTrack(doc, t, { order: 10 })
    expect(store.tracks().map((x) => x.id)).toEqual([u, t])
    expect(store.trackById[t]).toBe(ta)
    expect(store.trackById[u]).toBe(tb)
    const d1 = addDevice(doc, t, 1), d2 = addDevice(doc, t, 2)
    updateDevice(doc, d1, { order: 99 })
    const ids = store.devicesByTrack(t)().map((d) => d.id)
    expect(ids.indexOf(d2)).toBeLessThan(ids.indexOf(d1))
    store.dispose()
  })

  it('sees nested changes (device params) and the mix device', () => {
    const { doc, store } = setup()
    const t = addTrack(doc, 'a')
    const mix = store.mixDevice(t)!
    expect(mix.type).toBe(MIX)
    const other = store.devicesByTrack(t)()
    setParam(doc, mix.id, 0, 0.5)
    expect(store.deviceById[mix.id].params?.[0]).toBe(0.5)
    expect(store.mixDevice(t)).toBe(mix) // same object, patched in place
    expect(store.devicesByTrack(t)()).toBe(other)
    store.dispose()
  })

  it('groups notes by clip', () => {
    const { doc, store } = setup()
    const t = addTrack(doc, 'm', 'midi')
    const c = clip(doc, t, 0)
    const n = addNote(doc, { clipId: c, tick: 0, durTicks: 10, pitch: 60, velocity: 100 })
    expect(store.notesByClip(c)().map((x) => x.id)).toEqual([n])
    expect(store.notesByClip('none')()).toEqual([])
    store.dispose()
  })

  it('mirrors the peers and who is recording', () => {
    const { store, peers } = setup()
    expect(store.remote()).toEqual([])
    const bob: AwarenessState = { user: { username: 'bob', color: 'red' }, playhead: 5, recording: { trackId: 'x', start: 0 } }
    peers([bob])
    expect(store.remote().map((r) => r.user.username)).toEqual(['bob'])
    expect(store.locks().get('x')).toBe('bob')
    peers([{ ...bob, playhead: 6 }])
    expect(store.locks().get('x')).toBe('bob')
    peers([])
    expect(store.locks().size).toBe(0)
    store.dispose()
  })

  it('stops following the doc after dispose', () => {
    const { doc, store } = setup()
    store.dispose()
    addTrack(doc, 'late')
    expect(store.tracks()).toEqual([])
    expect(tracksMap(doc).size).toBe(1)
  })
})
