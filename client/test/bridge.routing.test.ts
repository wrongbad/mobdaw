// The bridge's side of docs/routing.md: buses, effective parents and device inputs (taps) as engine commands.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  COMPRESSOR, FX_RECV, FX_SEND, MASTER_TRACK, addBus, addDevice, addTrack, deleteDevice, deleteTrack, devicesMap, effectiveParent, getTracks, newId, setParam, setParent, tracksMap,
  updateDevice, updateTrack,
} from '@mobdaw/shared'
import { Bridge } from '../src/audio/bridge'

type Call = [string, ...number[]]
const setup = (init?: (doc: Y.Doc) => void) => {
  const doc = new Y.Doc()
  init?.(doc)
  const calls: Call[] = []
  const bridge = new Bridge(doc, { call: (fn, ...a) => void calls.push([fn, ...a]), source: () => {} }, async () => [new Float32Array(4), new Float32Array(4)], 48000, () => 0)
  const take = () => calls.splice(0)
  return { doc, bridge, calls, take }
}
const MASTER_H = 0xffffffff
const fx = (c: Call[], fn: string) => c.filter((x) => x[0] === fn)

describe('bridge routing (docs/routing.md)', () => {
  it('sends a bus as track kind 3 and every track its effective parent, only when it changes', () => {
    const { doc, bridge, take } = setup()
    const a = addTrack(doc, 'a')
    const bus = addBus(doc, 'drums')
    const first = take()
    expect(fx(first, 'engine_track_upsert').map((c) => c[2])).toEqual([0, 3])
    expect(fx(first, 'engine_track_set_parent')).toEqual([]) // both on the master: the engine's default, nothing to say

    expect(setParent(doc, a, bus)).toBe(true)
    expect(fx(take(), 'engine_track_set_parent')).toEqual([['engine_track_set_parent', bridge.trackHandle(a), bridge.trackHandle(bus)]])
    updateTrack(doc, a, { muted: true })
    expect(fx(take(), 'engine_track_set_parent')).toEqual([]) // unchanged
    setParent(doc, a, null)
    expect(fx(take(), 'engine_track_set_parent')).toEqual([['engine_track_set_parent', bridge.trackHandle(a), MASTER_H]])
  })

  it('a bus appearing, changing kind or vanishing re-sends the tracks that name it', () => {
    const { doc, bridge, take } = setup()
    const a = addTrack(doc, 'a')
    const b = addTrack(doc, 'b') // starts as a plain track
    tracksMap(doc).get(a)!.set('parent', b) // a names b, which is not a bus: the master
    expect(fx(take(), 'engine_track_set_parent')).toEqual([])
    updateTrack(doc, b, { kind: 'bus' })
    expect(fx(take(), 'engine_track_set_parent')).toEqual([['engine_track_set_parent', bridge.trackHandle(a), bridge.trackHandle(b)]])
    updateTrack(doc, b, { kind: 'audio' })
    expect(fx(take(), 'engine_track_set_parent')).toEqual([['engine_track_set_parent', bridge.trackHandle(a), MASTER_H]])
    updateTrack(doc, b, { kind: 'bus' })
    take()
    deleteTrack(doc, b) // the doc moves a to b's parent (the master)
    const gone = take()
    expect(fx(gone, 'engine_track_remove')).toHaveLength(1)
    expect(fx(gone, 'engine_track_set_parent')).toEqual([['engine_track_set_parent', bridge.trackHandle(a), MASTER_H]])
  })

  it('breaks a parent loop the way effectiveParent does', () => {
    const { doc, bridge, take } = setup()
    const x = addBus(doc, 'x')
    const y = addBus(doc, 'y')
    take()
    doc.transact(() => {
      tracksMap(doc).get(x)!.set('parent', y)
      tracksMap(doc).get(y)!.set('parent', x)
    })
    const eff = effectiveParent(getTracks(doc))
    const sent = new Map(fx(take(), 'engine_track_set_parent').map((c) => [c[1], c[2]]))
    for (const id of [x, y]) {
      const want = eff.get(id) === MASTER_TRACK ? MASTER_H : bridge.trackHandle(eff.get(id)!)
      expect(sent.get(bridge.trackHandle(id)) ?? MASTER_H).toBe(want)
    }
    expect([...eff.values()].filter((v) => v === MASTER_TRACK)).toHaveLength(1)
  })

  it('resolves a device input to the handle of a track, the master or a send, and to silence when the tap is missing', () => {
    const { doc, bridge, take } = setup()
    const t = addTrack(doc, 'a')
    const r = addTrack(doc, 'ret')
    const send = addDevice(doc, t, FX_SEND)
    const sendH = fx(take(), 'engine_device_upsert').find((c) => c[3] === FX_SEND)![1]
    const recv = addDevice(doc, r, FX_RECV, { input: send })
    const created = take()
    const dh = fx(created, 'engine_device_upsert').find((c) => c[3] === FX_RECV)![1]
    expect(fx(created, 'engine_device_input')).toEqual([['engine_device_input', dh, 3, sendH]])

    updateDevice(doc, recv, { input: t })
    expect(fx(take(), 'engine_device_input')).toEqual([['engine_device_input', dh, 1, bridge.trackHandle(t)]])
    updateDevice(doc, recv, { input: MASTER_TRACK })
    expect(fx(take(), 'engine_device_input')).toEqual([['engine_device_input', dh, 2, 0]])
    updateDevice(doc, recv, { input: 'nonexistent' })
    expect(fx(take(), 'engine_device_input')).toEqual([['engine_device_input', dh, 4, 0]]) // named but gone: silence
    updateDevice(doc, recv, { input: undefined })
    expect(fx(take(), 'engine_device_input')).toEqual([['engine_device_input', dh, 0, 0]]) // no input
    updateDevice(doc, recv, { input: send })
    take()
    setParam(doc, recv, 0, -6) // a knob move says nothing about the tap
    expect(fx(take(), 'engine_device_input')).toEqual([])
    deleteDevice(doc, send) // the tap vanishes: the recv reads silence
    expect(fx(take(), 'engine_device_input')).toEqual([['engine_device_input', dh, 4, 0]])
  })

  it('a compressor key follows its track, and an input set before the tap exists resolves once it does', () => {
    const { doc, take } = setup()
    const t = addTrack(doc, 'pad')
    const k = addTrack(doc, 'kick')
    const kh = fx(take(), 'engine_track_upsert')[1][1]
    addDevice(doc, t, COMPRESSOR, { input: k })
    const made = take()
    const ch = fx(made, 'engine_device_upsert').find((c) => c[3] === COMPRESSOR)![1]
    expect(fx(made, 'engine_device_input')).toEqual([['engine_device_input', ch, 1, kh]])
    deleteTrack(doc, k)
    expect(fx(take(), 'engine_device_input')).toEqual([['engine_device_input', ch, 4, 0]])

    // a tap named before it exists: a send that arrives later under that id (peers' edits merge in any order)
    const comp = [...devicesMap(doc).keys()].find((id) => devicesMap(doc).get(id)!.get('type') === COMPRESSOR)!
    const late = newId()
    updateDevice(doc, comp, { input: late })
    expect(fx(take(), 'engine_device_input')).toEqual([]) // (still the missing tap it already had)
    doc.transact(() => {
      const m = new Y.Map<unknown>()
      for (const [key, v] of Object.entries({ id: late, trackId: t, type: FX_SEND, order: 5, bypass: false })) m.set(key, v)
      m.set('params', new Y.Map())
      devicesMap(doc).set(late, m)
    })
    const calls = take()
    const sendH = fx(calls, 'engine_device_upsert').find((c) => c[3] === FX_SEND)![1]
    expect(fx(calls, 'engine_device_input')).toEqual([['engine_device_input', ch, 3, sendH]])
  })

  it("sends the document's track order, which the engine breaks ties by, once and again when it changes", () => {
    const { doc, bridge, take } = setup()
    const a = addTrack(doc, 'a')
    const b = addTrack(doc, 'b')
    const first = fx(take(), 'engine_track_order')
    expect(first).toEqual([
      ['engine_track_order', bridge.trackHandle(a), getTracks(doc).find((t) => t.id === a)!.order],
      ['engine_track_order', bridge.trackHandle(b), getTracks(doc).find((t) => t.id === b)!.order],
    ])
    updateTrack(doc, a, { muted: true })
    expect(fx(take(), 'engine_track_order')).toEqual([])
    updateTrack(doc, a, { order: 99 })
    expect(fx(take(), 'engine_track_order')).toEqual([['engine_track_order', bridge.trackHandle(a), 99]])
  })

  it('a loaded project sends parents and inputs once', () => {
    const { calls } = setup((doc) => {
      const bus = addBus(doc, 'bus')
      const a = addTrack(doc, 'a')
      setParent(doc, a, bus)
      const ret = addTrack(doc, 'ret')
      addDevice(doc, ret, FX_RECV, { input: a })
    })
    expect(fx(calls, 'engine_track_set_parent')).toHaveLength(1)
    expect(fx(calls, 'engine_device_input')).toHaveLength(1)
  })
})
