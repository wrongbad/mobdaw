// Routing data model (docs/routing.md): buses, parents, taps, schema v5.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  COMPRESSOR, DEVICES, EFFECTS, FX_RECV, FX_SEND, MASTER_TRACK, MIX, SCHEMA_VERSION, addAudioClip, addBus, addDevice, addLooper, addMidiClip, addPad, addTrack,
  childrenOf, deleteTrack, effectiveParent, getDevices, getTaps, getTracks, metaMap, migrateToV2, migrateToV3, migrateToV4, migrateToV5, setParent, tapExists,
  tracksMap, trackTree, updateDevice, updateTrack, type Track,
} from '@mobdaw/shared'

const T = (id: string, kind: Track['kind'] = 'bus', parent?: string): Pick<Track, 'id' | 'kind' | 'parent'> => ({ id, kind, ...(parent ? { parent } : {}) })
const eff = (...ts: Pick<Track, 'id' | 'kind' | 'parent'>[]) => Object.fromEntries(effectiveParent(ts))

describe('effectiveParent', () => {
  it('defaults to the master and follows valid parents', () => {
    expect(eff(T('a', 'midi'), T('b'), T('c', 'audio', 'b'), T('d', 'bus', 'b'), T('e', 'midi', 'd'))).toEqual({ a: MASTER_TRACK, b: MASTER_TRACK, c: 'b', d: 'b', e: 'd' })
  })
  it('sends a missing parent, a non-bus parent and a self-parent to the master', () => {
    expect(eff(T('a', 'midi', 'gone'), T('m', 'midi'), T('b', 'audio', 'm'), T('s', 'bus', 's'))).toEqual({ a: MASTER_TRACK, m: MASTER_TRACK, b: MASTER_TRACK, s: MASTER_TRACK })
    expect(eff(T('a', 'midi', MASTER_TRACK))).toEqual({ a: MASTER_TRACK })
  })
  it('breaks a 2-cycle at the smallest id', () => {
    expect(eff(T('b', 'bus', 'a'), T('a', 'bus', 'b'))).toEqual({ a: MASTER_TRACK, b: 'a' })
  })
  it('breaks a 3-cycle at the smallest id and keeps what hangs off it', () => {
    const r = eff(T('c', 'bus', 'b'), T('a', 'bus', 'c'), T('b', 'bus', 'a'), T('x', 'midi', 'c'), T('y', 'bus', 'x'))
    expect(r).toEqual({ a: MASTER_TRACK, b: 'a', c: 'b', x: 'c', y: MASTER_TRACK }) // (y's parent x is not a bus)
  })
  it('breaks disjoint cycles independently, and a tail leading into a cycle', () => {
    const r = eff(T('a', 'bus', 'b'), T('b', 'bus', 'a'), T('p', 'bus', 'q'), T('q', 'bus', 'p'), T('t', 'midi', 'q'))
    expect(r).toEqual({ a: MASTER_TRACK, b: 'a', p: MASTER_TRACK, q: 'p', t: 'q' })
  })
  it('does not depend on input order', () => {
    const ts = [T('a', 'bus', 'c'), T('b', 'bus', 'a'), T('c', 'bus', 'b'), T('z', 'midi', 'b')]
    expect(effectiveParent([...ts].reverse())).toEqual(effectiveParent(ts))
  })
})

describe('buses', () => {
  it('addBus makes a bus with a mix device and no clips, loopers or pads', () => {
    const d = new Y.Doc()
    const b = addBus(d, 'drums')
    expect(getTracks(d)[0]).toMatchObject({ id: b, kind: 'bus', name: 'drums' })
    expect(getDevices(d).filter((x) => x.trackId === b).map((x) => x.type)).toEqual([MIX])
    expect(() => addMidiClip(d, { trackId: b, startTick: 0 })).toThrow('bus')
    expect(() => addAudioClip(d, { trackId: b, sourceHash: 'h', start: 0, length: 1 })).toThrow('bus')
    expect(() => addLooper(d, b, 0)).toThrow('bus')
    expect(() => addPad(d, b, 0, 1)).toThrow('bus')
  })
  it('setParent moves tracks, refuses non-buses and local loops, and clears with null', () => {
    const d = new Y.Doc()
    const b1 = addBus(d, 'b1'), b2 = addBus(d, 'b2'), t = addTrack(d, 't', 'midi')
    expect(setParent(d, t, b1, 7)).toBe(true)
    expect(getTracks(d).find((x) => x.id === t)).toMatchObject({ parent: b1, order: 7 })
    expect(setParent(d, t, b2)).toBe(true)
    expect(setParent(d, b2, b1)).toBe(true)
    expect(setParent(d, b1, b2)).toBe(false) // loop
    expect(setParent(d, b1, b1)).toBe(false)
    expect(setParent(d, b1, t)).toBe(false) // not a bus
    expect(setParent(d, 'nope', b1)).toBe(false)
    expect(setParent(d, t, null)).toBe(true)
    expect(tracksMap(d).get(t)!.has('parent')).toBe(false)
    expect(setParent(d, b2, MASTER_TRACK)).toBe(true)
    expect(tracksMap(d).get(b2)!.has('parent')).toBe(false)
  })
  it('trackTree and childrenOf group by effective parent in order', () => {
    const d = new Y.Doc()
    const b = addBus(d, 'b'), x = addTrack(d, 'x', 'midi'), y = addTrack(d, 'y', 'midi')
    setParent(d, y, b)
    setParent(d, x, b)
    updateTrack(d, x, { order: 0 })
    expect(childrenOf(d, b).map((t) => t.id)).toEqual([x, y])
    expect(childrenOf(d, MASTER_TRACK).map((t) => t.id)).toEqual([b])
    expect(trackTree(getTracks(d)).has(x)).toBe(false)
  })
  it('deleting a bus moves its children to its parent, in its place', () => {
    const d = new Y.Doc()
    const outer = addBus(d, 'outer'), inner = addBus(d, 'inner'), after = addTrack(d, 'after', 'midi')
    const k1 = addTrack(d, 'k1', 'midi'), k2 = addTrack(d, 'k2', 'midi')
    setParent(d, inner, outer)
    setParent(d, k1, inner)
    setParent(d, k2, inner)
    setParent(d, after, outer)
    deleteTrack(d, inner)
    expect(childrenOf(d, outer).map((t) => t.name)).toEqual(['k1', 'k2', 'after'])
    expect(getDevices(d).some((x) => x.trackId === inner)).toBe(false)
    deleteTrack(d, outer)
    expect(getTracks(d).every((t) => t.parent == null)).toBe(true)
    expect(childrenOf(d, MASTER_TRACK).map((t) => t.name).sort()).toEqual(['after', 'k1', 'k2'])
  })
})

describe('taps', () => {
  it('lists tracks, buses, sends and the master, and checks existence', () => {
    const d = new Y.Doc()
    const b = addBus(d, 'drums'), t = addTrack(d, 'kick', 'midi')
    const s1 = addDevice(d, t, FX_SEND), s2 = addDevice(d, MASTER_TRACK, FX_SEND, { name: 'verb' })
    const taps = getTaps(d)
    expect(taps).toEqual([
      { id: b, label: 'drums', kind: 'bus', owner: b },
      { id: t, label: 'kick', kind: 'track', owner: t },
      { id: s1, label: 'send 1', kind: 'send', owner: t },
      { id: s2, label: 'verb', kind: 'send', owner: MASTER_TRACK },
      { id: MASTER_TRACK, label: 'master', kind: 'master', owner: MASTER_TRACK },
    ])
    for (const x of taps) expect(tapExists(d, x.id)).toBe(true)
    expect(tapExists(d, 'nope')).toBe(false)
    expect(tapExists(d, getDevices(d).find((x) => x.type === MIX)!.id)).toBe(false) // a device that is not a send
    deleteTrack(d, t)
    expect(tapExists(d, s1)).toBe(false)
  })
  it('devices carry an input', () => {
    const d = new Y.Doc()
    const t = addTrack(d, 't', 'audio'), k = addTrack(d, 'k', 'midi')
    const c = addDevice(d, t, COMPRESSOR, { input: k })
    expect(getDevices(d).find((x) => x.id === c)!.input).toBe(k)
    updateDevice(d, c, { input: MASTER_TRACK })
    expect(getDevices(d).find((x) => x.id === c)!.input).toBe(MASTER_TRACK)
  })
})

describe('devices and schema', () => {
  it('send and recv are effects with a gain in dB', () => {
    for (const k of [FX_SEND, FX_RECV]) {
      expect(DEVICES[k].instrument).toBe(false)
      expect(DEVICES[k].params).toEqual([{ id: 0, name: 'gain', min: -60, max: 12, def: 0, scale: 'lin', unit: 'db' }])
      expect(EFFECTS).toContain(DEVICES[k])
    }
  })
  it('a v4 doc loads and is stamped v5; a newer doc is left alone', () => {
    expect(SCHEMA_VERSION).toBe(5)
    const d = new Y.Doc()
    metaMap(d).set('schemaVersion', 4)
    addTrack(d, 'a', 'midi')
    migrateToV5(d)
    expect(metaMap(d).get('schemaVersion')).toBe(5)
    const old = new Y.Doc()
    metaMap(old).set('schemaVersion', 2)
    metaMap(old).set('sampleRate', 48000)
    migrateToV3(old); migrateToV4(old); migrateToV5(old)
    expect(metaMap(old).get('schemaVersion')).toBe(5)
    const fut = new Y.Doc()
    metaMap(fut).set('schemaVersion', 6)
    migrateToV5(fut)
    expect(metaMap(fut).get('schemaVersion')).toBe(6)
    const v1 = new Y.Doc()
    migrateToV2(v1); migrateToV5(v1)
    expect(metaMap(v1).get('schemaVersion')).toBeDefined()
  })
})
