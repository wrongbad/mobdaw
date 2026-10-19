// The hidden mix device (docs/engine.md §3): every track and the master bus has one, pinned last in its chain.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  DELAY, EFFECTS, MASTER_TRACK, MIX, REVERB, SCHEMA_VERSION, addDevice, addTrack, deleteDevice, deleteTrack, devicesMap, ensureMixDevice,
  getDevices, getMix, getMixDevice, metaMap, migrateToV2, migrateToV3, setMixParam, tracksMap, updateDevice,
} from '@mobdaw/shared'
import { applyPreset, presetsFor } from '../src/content/presets'

const chain = (doc: Y.Doc, scope: string) => getDevices(doc).filter((d) => d.trackId === scope)
const lastIsMix = (doc: Y.Doc, scope: string) => expect(chain(doc, scope).at(-1)?.type).toBe(MIX)
const count = (doc: Y.Doc, scope: string) => chain(doc, scope).filter((d) => d.type === MIX).length

describe('mix device', () => {
  it('migrates tracks with gain and pan into a pinned mix device, idempotently', () => {
    const old = new Y.Doc()
    metaMap(old).set('schemaVersion', 2)
    metaMap(old).set('sampleRate', 48000)
    for (const [id, gain, pan] of [['a', 0.4, -0.3], ['b', 1, 0]] as const) {
      tracksMap(old).set(id, new Y.Map<unknown>(Object.entries({ id, name: id, kind: 'midi', order: id === 'a' ? 1 : 2, gain, pan, muted: false, soloed: false })))
    }
    // an effect already on track a, with a higher order than anything: the mix still ends up after it
    const fx = new Y.Map<unknown>(Object.entries({ id: 'fx', trackId: 'a', type: REVERB, order: 5, bypass: false }))
    fx.set('params', new Y.Map())
    devicesMap(old).set('fx', fx)
    migrateToV3(old)
    expect(metaMap(old).get('schemaVersion')).toBe(3) // (migrateToV4 takes it to SCHEMA_VERSION)
    expect(getMix(old, 'a')).toEqual({ gain: 0.4, pan: -0.3 })
    expect(getMix(old, 'b')).toEqual({ gain: 1, pan: 0 })
    expect(getMix(old, MASTER_TRACK)).toEqual({ gain: 1, pan: 0 })
    expect(tracksMap(old).get('a')!.has('gain') || tracksMap(old).get('a')!.has('pan')).toBe(false)
    for (const s of ['a', 'b', MASTER_TRACK]) {
      expect(count(old, s)).toBe(1)
      lastIsMix(old, s)
    }
    expect(chain(old, 'a').map((d) => d.id)).toEqual(['fx', 'mix:a'])
    const before = Y.encodeStateAsUpdate(old)
    migrateToV3(old)
    expect(Y.encodeStateAsUpdate(old)).toEqual(before) // no writes the second time
  })

  it('migrates a v1 doc through both steps and converges across clients', () => {
    const v1 = new Y.Doc()
    v1.getMap('tracks').set('t1', new Y.Map<unknown>(Object.entries({ id: 't1', name: 'x', order: 1, gain: 0.5, muted: false })))
    const a = new Y.Doc(), b = new Y.Doc()
    Y.applyUpdate(a, Y.encodeStateAsUpdate(v1))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(v1))
    for (const d of [a, b]) {
      migrateToV2(d)
      migrateToV3(d)
    }
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    for (const d of [a, b]) {
      expect(count(d, 't1')).toBe(1)
      expect(getMix(d, 't1')).toEqual({ gain: 0.5, pan: 0 })
    }
  })

  it('repairs duplicates and a displaced mix device', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'x')
    const extra = addDevice(doc, t, REVERB)
    const mix = getMixDevice(doc, t)!
    devicesMap(doc).get(mix.id)!.set('order', 99) // pushed ahead of the reverb
    const dup = new Y.Map<unknown>(Object.entries({ id: 'zz', trackId: t, type: MIX, order: 100, bypass: true }))
    dup.set('params', new Y.Map())
    devicesMap(doc).set('zz', dup)
    migrateToV3(doc)
    expect(count(doc, t)).toBe(1)
    expect(chain(doc, t).map((d) => d.id)).toEqual([extra, mix.id])
  })

  it('addTrack makes one, and setMixParam writes it', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'x')
    expect(getMix(doc, t)).toEqual({ gain: 1, pan: 0 })
    setMixParam(doc, t, 'gain', 0.7)
    setMixParam(doc, t, 'pan', -1)
    expect(getMix(doc, t)).toEqual({ gain: 0.7, pan: -1 })
    expect(ensureMixDevice(doc, t)).toBe(getMixDevice(doc, t)!.id)
    expect(count(doc, t)).toBe(1)
  })

  it('stays last when devices are added or reordered, and is out of the fx menu', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'x')
    const a = addDevice(doc, t, REVERB), b = addDevice(doc, t, DELAY)
    lastIsMix(doc, t)
    updateDevice(doc, a, { order: 1000 }) // dropped "at the end"
    lastIsMix(doc, t)
    expect(chain(doc, t).map((d) => d.id).slice(0, 2)).toEqual([b, a])
    const mix = getMixDevice(doc, t)!
    updateDevice(doc, mix.id, { order: -5, bypass: true, name: 'n' })
    expect(getMixDevice(doc, t)).toMatchObject({ order: mix.order, bypass: false })
    expect(addDevice(doc, t, MIX)).toBe(mix.id) // adding one is a no-op
    expect(count(doc, t)).toBe(1)
    expect(EFFECTS.some((d) => d.type === MIX)).toBe(false)
  })

  it('cannot be deleted alone, but goes with its track', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'x')
    ensureMixDevice(doc, MASTER_TRACK)
    deleteDevice(doc, getMixDevice(doc, t)!.id)
    deleteDevice(doc, getMixDevice(doc, MASTER_TRACK)!.id)
    expect(getMixDevice(doc, t)).toBeDefined()
    expect(getMixDevice(doc, MASTER_TRACK)).toBeDefined()
    deleteTrack(doc, t)
    expect(chain(doc, t)).toEqual([])
    expect(getMixDevice(doc, MASTER_TRACK)).toBeDefined()
  })

  it('survives applyPreset with its values', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'x', 'midi')
    setMixParam(doc, t, 'gain', 0.3)
    setMixParam(doc, t, 'pan', 0.5)
    const id = getMixDevice(doc, t)!.id
    let longest = 0
    for (const p of presetsFor(doc, t)) {
      applyPreset(doc, t, p.id)
      expect(getMixDevice(doc, t)!.id).toBe(id)
      expect(getMix(doc, t)).toEqual({ gain: 0.3, pan: 0.5 })
      expect(count(doc, t)).toBe(1)
      lastIsMix(doc, t)
      longest = Math.max(longest, chain(doc, t).length)
    }
    expect(longest).toBeGreaterThan(2) // an instrument and effects came in before it
  })
})
