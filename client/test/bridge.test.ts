import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  DEVICES, addAudioClip, addDevice, MASTER_TRACK, devicesMap, addPad, deletePad, getPads, updatePad, addMidiClip, addNote, addSample, addTrack, addNextLooper, deleteLooper, clipsMap, deleteClip, deleteDevice, deleteTrack,
  addLane, addPoint, deleteLane, evalPoints, getLanes, getPoints, laneOf, setLaneEnabled, setLaneState, updateLaneLfo, updatePoint, resolveTarget,
  getClips, getLoopers, getSampleRate, getTracks, migrateToV2, notesMap, setParam, splitClip, stashLaneRanges, sweepOrphans, tracksMap,
  orderBetween, getDevices, updateDevice, updateClip, updateLooper, updateNote, updateTrack, type SampleMeta, setSampleStatus, discardSample, getSamples, undoScope,
} from '@mobdaw/shared'
import { Bridge } from '../src/audio/bridge'

const meta = (hash: string): SampleMeta => ({ hash, name: hash, duration: 1, size: 10, mime: 'audio/wav' })
const setup = (init?: (doc: Y.Doc) => void) => {
  const doc = new Y.Doc()
  init?.(doc)
  const calls: [string, ...number[]][] = []
  const sources: [number, number, number][] = []
  const loads: string[] = []
  const bridge = new Bridge(doc, {
    call: (fn, ...a) => void calls.push([fn, ...a]),
    source: (h, ch, frames) => void sources.push([h, ch.length, frames]),
  }, async (hash) => (loads.push(hash), [new Float32Array(4), new Float32Array(4)]), 48000, () => 0)
  const take = () => calls.splice(0)
  return { doc, bridge, calls, take, sources, loads }
}
const names = (c: [string, ...number[]][]) => c.map((x) => x[0])

describe('bridge', () => {
  it('sends the full state on load, with orphans ignored', () => {
    const { calls } = setup((doc) => {
      const t = addTrack(doc, 'a')
      const m = addTrack(doc, 'm', 'midi')
      const c = addMidiClip(doc, { trackId: m, start: 100 })
      addNote(doc, { clipId: c, tick: 0, durTicks: 960, pitch: 60, velocity: 0.8 })
      addDevice(doc, m, 2)
      addAudioClip(doc, { trackId: t, sourceHash: 'h', start: 0, length: 10 })
      addAudioClip(doc, { trackId: 'ghost', sourceHash: 'h', start: 0, length: 10 }) // orphan
      addNote(doc, { clipId: 'ghost', tick: 0, durTicks: 1, pitch: 60, velocity: 1 }) // orphan
    })
    const n = names(calls)
    expect(n.filter((x) => x === 'engine_track_upsert')).toHaveLength(2)
    expect(n.filter((x) => x === 'engine_clip_audio_upsert')).toHaveLength(1)
    expect(n.filter((x) => x === 'engine_clip_midi_upsert')).toHaveLength(1)
    expect(n.filter((x) => x === 'engine_note_upsert')).toHaveLength(1)
    expect(n.filter((x) => x === 'engine_device_upsert')).toHaveLength(1)
    expect(n.filter((x) => x === 'engine_param_set')).toHaveLength(7)
    const midi = calls.find((c) => c[0] === 'engine_clip_midi_upsert')!
    expect(midi.slice(3)).toEqual([100, 120, 960, 15360]) // start, bpm, ppq, lengthTicks
  })

  it('upserts, updates and removes through cascades with stable, never-reused handles', () => {
    const { doc, take } = setup()
    const t = addTrack(doc, 'a')
    const [[, th, kind]] = take().filter((c) => c[0] === 'engine_track_upsert')
    expect(kind).toBe(0)
    updateTrack(doc, t, { gain: 0.5, muted: true })
    expect(take()).toEqual([['engine_track_upsert', th, 0, 0.5, 0, 1, 0]])
    const c = addAudioClip(doc, { trackId: t, sourceHash: 'h', start: 5, length: 6 })
    const up = take()[0]
    expect(up.slice(0, 2)).toEqual(['engine_clip_audio_upsert', 2])
    updateClip(doc, c, { start: 7 })
    expect(take()[0].slice(4, 6)).toEqual([7, 6]) // start, length
    deleteTrack(doc, t)
    const rm = take()
    expect(rm).toContainEqual(['engine_clip_remove', 2])
    expect(rm).toContainEqual(['engine_track_remove', th])
    // undo-like re-creation gets a fresh handle
    const t2 = addTrack(doc, 'b')
    expect(take()[0][1]).not.toBe(th)
    expect(t2).toBeTruthy()
  })

  it('removes notes with their clip; edits notes', () => {
    const { doc, take } = setup()
    const t = addTrack(doc, 'm', 'midi')
    const c = addMidiClip(doc, { trackId: t, start: 0 })
    const n = addNote(doc, { clipId: c, tick: 0, durTicks: 10, pitch: 60, velocity: 1 })
    take()
    updateNote(doc, n, { pitch: 62 })
    expect(take()).toEqual([['engine_note_upsert', 3, 2, 0, 10, 62, 1]])
    deleteClip(doc, c)
    expect(take().map((x) => x[0]).sort()).toEqual(['engine_clip_remove', 'engine_note_remove'])
  })

  it('a concurrent orphan note appears in the doc but is ignored; sweeping cleans it', () => {
    const { doc, take } = setup()
    const t = addTrack(doc, 'm', 'midi')
    const c = addMidiClip(doc, { trackId: t, start: 0 })
    take()
    doc.transact(() => {
      clipsMap(doc).delete(c) // B deletes the clip...
      const m = new Y.Map<unknown>(Object.entries({ id: 'n1', clipId: c, tick: 0, durTicks: 1, pitch: 60, velocity: 1 }))
      notesMap(doc).set('n1', m) // ...A's note arrives for it
    })
    expect(names(take())).toEqual(['engine_clip_remove'])
    sweepOrphans(doc)
    expect(notesMap(doc).size).toBe(0)
  })

  it('device params: only changed params are sent; remote drags override and revert', () => {
    const { doc, bridge, take } = setup()
    const t = addTrack(doc, 'a')
    const d = addDevice(doc, t, 1)
    const calls = take()
    const dh = calls.find((c) => c[0] === 'engine_device_upsert')![1]
    setParam(doc, d, 1, 500)
    expect(take()).toEqual([['engine_param_set', dh, 1, 500]])
    bridge.setOverrides([{ deviceId: d, paramId: 1, value: 2000 }])
    expect(take()).toEqual([['engine_param_set', dh, 1, 2000]])
    setParam(doc, d, 1, 600) // committed doc value is withheld while overridden
    expect(take()).toEqual([])
    bridge.setOverrides([])
    expect(take()).toEqual([['engine_param_set', dh, 1, 600]])
    bridge.live(d, 2, 0.3)
    expect(take()).toEqual([['engine_param_set', dh, 2, 0.3]])
    deleteDevice(doc, d)
    expect(take()).toEqual([['engine_device_remove', dh]])
  })

  it('moving a device in its chain sends its new order, keeping its handle', () => {
    const { doc, take } = setup()
    const t = addTrack(doc, 'a')
    const a = addDevice(doc, t, 1)
    const b = addDevice(doc, t, 4)
    const ups = () => take().filter((c) => c[0] === 'engine_device_upsert') // [fn, handle, track, kind, order, bypass]
    const [ua, ub] = ups()
    expect(ua[4]).toBeLessThan(ub[4])
    updateDevice(doc, b, { order: orderBetween(undefined, getDevices(doc).find((d) => d.id === a)!.order) }) // b goes in front of a
    const after = ups()
    expect(after).toHaveLength(1)
    expect(after[0][1]).toBe(ub[1]) // same handle: the engine keeps its params and state
    expect(after[0][4]).toBeLessThan(ua[4])
  })

  it('global fx devices (on the master bus) reach the engine without a track and survive an orphan sweep', () => {
    const { doc, take } = setup()
    const d = addDevice(doc, MASTER_TRACK, 1)
    const up = take().find((c) => c[0] === 'engine_device_upsert')!
    expect(up[2]).toBe(0xffffffff)
    sweepOrphans(doc)
    expect(devicesMap(doc).has(d)).toBe(true)
    expect(take()).toEqual([])
  })

  it('loads each source once, after its metadata arrives, and transfers channels', async () => {
    const { doc, sources, loads } = setup()
    const t = addTrack(doc, 'a')
    addAudioClip(doc, { trackId: t, sourceHash: 'h', start: 0, length: 10 })
    addAudioClip(doc, { trackId: t, sourceHash: 'h', start: 10, length: 10 })
    expect(loads).toEqual([])
    addSample(doc, meta('h'))
    await new Promise((r) => setTimeout(r))
    expect(loads).toEqual(['h'])
    expect(sources).toEqual([[3, 2, 4]]) // handles: track 1, clip 2, source 3
  })

  it('does not request incoming or missing sources, except incoming ones of the local user', async () => {
    const loads: string[] = []
    const mk = (me?: number) => {
      const doc = new Y.Doc()
      const t = addTrack(doc, 'a')
      for (const h of ['mine', 'theirs', 'gone', 'plain']) addAudioClip(doc, { trackId: t, sourceHash: h, start: 0, length: 10 })
      addSample(doc, { ...meta('mine'), status: 'incoming', by: 1 })
      addSample(doc, { ...meta('theirs'), status: 'incoming', by: 2 })
      addSample(doc, { ...meta('gone'), status: 'missing' })
      addSample(doc, meta('plain'))
      const b = new Bridge(doc, { call() {}, source() {} }, async (hash) => (loads.push(hash), null), 48000, () => 0, me)
      return { doc, b }
    }
    mk(1)
    await new Promise((r) => setTimeout(r))
    expect(loads.sort()).toEqual(['mine', 'plain'])
    loads.length = 0
    const { doc } = mk(2)
    await new Promise((r) => setTimeout(r))
    expect(loads.sort()).toEqual(['plain', 'theirs'])
    // once uploaded (status cleared) everyone's engine fetches it
    loads.length = 0
    setSampleStatus(doc, 'mine', undefined)
    await new Promise((r) => setTimeout(r))
    expect(loads).toEqual(['mine'])
  })

  it('discardSample deletes the sample and every clip that plays it', () => {
    const { doc } = setup()
    const t = addTrack(doc, 'a')
    addSample(doc, { ...meta('x'), status: 'incoming', by: 1 })
    addAudioClip(doc, { trackId: t, sourceHash: 'x', start: 0, length: 10 })
    addAudioClip(doc, { trackId: t, sourceHash: 'x', start: 20, length: 10 })
    const keep = addAudioClip(doc, { trackId: t, sourceHash: 'y', start: 40, length: 10 })
    discardSample(doc, 'x')
    expect(getClips(doc).map((c) => c.id)).toEqual([keep])
    expect(getSamples(doc).x).toBeUndefined()
  })

  it('discardSample with an untracked origin is not undoable (the clips would come back without their audio)', () => {
    const doc = new Y.Doc()
    const undo = new Y.UndoManager(undoScope(doc))
    const t = addTrack(doc, 'a')
    addSample(doc, meta('x'))
    addAudioClip(doc, { trackId: t, sourceHash: 'x', start: 0, length: 10 })
    undo.stopCapturing()
    discardSample(doc, 'x', 'takes')
    undo.undo()
    expect(getClips(doc)).toEqual([])
  })

  it('setSampleStatus clears who recorded a take along with its status', () => {
    const doc = new Y.Doc()
    addSample(doc, { ...meta('x'), status: 'incoming', by: 1, byName: 'kyle', peaks: 'AA==' })
    setSampleStatus(doc, 'x', undefined)
    expect(getSamples(doc).x).toEqual({ ...meta('x'), peaks: 'AA==' })
  })

  it('transport extrapolates between engine position reports', () => {
    let now = 0
    const doc = new Y.Doc()
    const calls: unknown[][] = []
    const b = new Bridge(doc, { call: (...a) => void calls.push(a), source() {} }, async () => null, 48000, () => now)
    b.play(48000)
    now = 500
    expect(b.position()).toBe(72000)
    b.onPos({ pos: 80000, playing: true })
    now = 1000
    expect(b.position()).toBe(80000 + 24000)
    b.stop()
    expect(b.position()).toBe(104000)
    b.seek(5)
    expect(calls).toEqual([['engine_play', 48000], ['engine_stop'], ['engine_seek', 5]])
  })
})

describe('schema v2', () => {
  it('migrates v1 to v2, idempotently, and converges across clients', () => {
    const v1 = new Y.Doc()
    const t = new Y.Map<unknown>(Object.entries({ id: 't1', name: 'x', order: 1, gain: 1, muted: false }))
    v1.getMap('tracks').set('t1', t)
    v1.getMap('clips').set('c1', new Y.Map<unknown>(Object.entries({ id: 'c1', trackId: 't1', sampleHash: 'h', start: 1.5, offset: 0.25, duration: 2.000011, gain: 0.8 })))
    const a = new Y.Doc(), b = new Y.Doc()
    Y.applyUpdate(a, Y.encodeStateAsUpdate(v1))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(v1))
    migrateToV2(a)
    migrateToV2(b)
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(getClips(a)).toEqual(getClips(b))
    expect(getClips(a)).toEqual([{
      id: 'c1', trackId: 't1', kind: 'audio', sourceHash: 'h', start: 72000, sourceOffset: 12000, length: 96001,
      gain: 0.8, fadeIn: 0, fadeOut: 0, fadeShape: 0,
    }])
    expect(getTracks(a)[0]).toMatchObject({ kind: 'audio', pan: 0, soloed: false })
    expect(getSampleRate(a)).toBe(48000)
    const before = Y.encodeStateAsUpdate(a)
    migrateToV2(a)
    expect(Y.encodeStateAsUpdate(a)).toEqual(before) // idempotent: no new writes
  })

  it('splits audio clips with adjusted offsets', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'a')
    const c = addAudioClip(doc, { trackId: t, sourceHash: 'h', start: 100, length: 1000, sourceOffset: 50, fadeOut: 20 })
    expect(splitClip(doc, c, 100)).toBeNull()
    const r = splitClip(doc, c, 400)!
    const [l, rr] = [clipsMap(doc).get(c)!.toJSON(), clipsMap(doc).get(r)!.toJSON()]
    expect(l).toMatchObject({ start: 100, length: 300, sourceOffset: 50, fadeOut: 0 })
    expect(rr).toMatchObject({ start: 400, length: 700, sourceOffset: 350, fadeOut: 20, sourceHash: 'h' })
  })

  it('cascades deletes in one transaction', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'm', 'midi')
    const c = addMidiClip(doc, { trackId: t, start: 0 })
    addNote(doc, { clipId: c, tick: 0, durTicks: 1, pitch: 60, velocity: 1 })
    addDevice(doc, t, 2)
    let txs = 0
    doc.on('afterTransaction', () => txs++)
    deleteTrack(doc, t)
    expect(txs).toBe(1)
    expect([tracksMap(doc).size, clipsMap(doc).size, notesMap(doc).size, doc.getMap('devices').size]).toEqual([0, 0, 0, 0])
  })

  it('soundscape tracks: kind 2, loopers add/remove, pads, updates and cleanup', () => {
    const { doc, take, calls } = setup()
    const t = addTrack(doc, 'scape', 'soundscape')
    expect(getLoopers(doc).map((l) => l.slot)).toEqual([0]) // starts with one
    for (let i = 0; i < 3; i++) addNextLooper(doc, t)
    const loopers = getLoopers(doc)
    expect(loopers.map((l) => l.slot)).toEqual([0, 1, 2, 3])
    deleteLooper(doc, loopers[2].id)
    addNextLooper(doc, t) // refills the freed slot
    expect(getLoopers(doc).map((l) => l.slot)).toEqual([0, 1, 2, 3])
    expect(calls.find((c) => c[0] === 'engine_track_upsert')![2]).toBe(2)
    expect(new Set(calls.filter((c) => c[0] === 'engine_looper_upsert').map((c) => c[1])).size).toBe(5) // 4 live + 1 removed (idempotent repeats are fine)
    expect(calls.filter((c) => c[0] === 'engine_looper_mix').every((c) => c[2] === 1 && c[3] === 0)).toBe(true) // full level, unmuted
    take()
    updateLooper(doc, loopers[0].id, { gain: 0.4, muted: true })
    expect(take().filter((c) => c[0] === 'engine_looper_mix').map((c) => c.slice(2))).toEqual([[0.4, 1]])
    updateLooper(doc, loopers[1].id, { speed: 2.5, start: 48000, length: 96000 })
    const up = take().filter((c) => c[0] === 'engine_looper_upsert')
    expect(up).toHaveLength(1)
    expect(up[0].slice(3)).toEqual([2.5, 48000, 96000]) // speed, start, length
    const pad = addPad(doc, t, 96000, 48000)
    const pc = take().filter((c) => c[0] === 'engine_pad_upsert')
    expect(pc[0].slice(3)).toEqual([96000, 48000]) // start, length (after the pad and track handles)
    updatePad(doc, pad, { start: 100000 })
    expect(take().filter((c) => c[0] === 'engine_pad_upsert')).toHaveLength(1)
    deletePad(doc, pad)
    expect(take().filter((c) => c[0] === 'engine_pad_remove')).toHaveLength(1)
    addPad(doc, t, 0, 10)
    take()
    deleteTrack(doc, t)
    expect(take().filter((c) => c[0] === 'engine_looper_remove')).toHaveLength(4)
    expect(getPads(doc)).toHaveLength(0)
    expect(getLoopers(doc)).toHaveLength(0)
  })

  it('previews: private transport and handle per (track, mode), reported separately, dropped with the track', () => {
    const { doc, bridge, take } = setup()
    const t = addTrack(doc, 'scape', 'soundscape')
    take()
    const src = bridge.preview(t, 'source')
    const loops = bridge.preview(t, 'loops')
    expect(bridge.preview(t, 'source').position()).toBe(src.position()) // cached, not recreated
    const ups = take().filter((c) => c[0] === 'engine_preview_upsert')
    expect(ups).toHaveLength(2)
    expect(ups.map((c) => c[3])).toEqual([0, 1]) // source, loops
    const [hs, hl] = ups.map((c) => c[1])
    expect(hs).not.toBe(hl)

    src.play(48000)
    expect(take()).toEqual([['engine_preview_play', hs, 48000]])
    bridge.onPreviewPos({ h: hs, pos: 50000, playing: true })
    expect([src.playing, src.position()]).toEqual([true, 50000]) // (clock is frozen at 0 in tests)
    expect([loops.playing, bridge.isPlaying]).toEqual([false, false]) // nothing else moved
    src.stop()
    expect(take()).toEqual([['engine_preview_stop', hs]])

    deleteTrack(doc, t)
    expect(take().filter((c) => c[0] === 'engine_preview_remove').map((c) => c[1]).sort()).toEqual([hs, hl].sort())
  })
})

describe('automation', () => {
  it('lanes and points reach the engine with the param range, and the static value comes back when the lane goes', () => {
    const { doc, take } = setup()
    const t = addTrack(doc, 'a')
    const dev = addDevice(doc, t, 1) // filter
    setParam(doc, dev, 1, 4000)
    const dh = take().find((c) => c[0] === 'engine_device_upsert')![1]

    const lane = addLane(doc, { scope: t, kind: 'effect', owner: dev, param: '1' })
    const up = take().find((c) => c[0] === 'engine_lane_upsert')!
    expect(up.slice(2)).toEqual([0, dh, 1, 1, 20, 20000, 1]) // device, handle, param, enabled, min, max, log
    const p1 = addPoint(doc, lane, 0, 0.25)
    addPoint(doc, lane, 48000, 0.75, 'hold')
    const pts = take().filter((c) => c[0] === 'engine_point_upsert')
    expect(pts.map((c) => c.slice(3))).toEqual([[0, 0.25, 0], [48000, 0.75, 1]])
    updatePoint(doc, p1, { value: 0.5 })
    expect(take()).toEqual([['engine_point_upsert', pts[0][1], up[1], 0, 0.5, 0]])

    setLaneEnabled(doc, lane, false)
    const off = take()
    expect(off[0].slice(0, 2)).toEqual(['engine_lane_upsert', up[1]])
    expect(off[0][5]).toBe(0) // enabled
    expect(off).toContainEqual(['engine_param_set', dh, 1, 4000]) // the static value is handed back

    setLaneEnabled(doc, lane, true)
    take()
    deleteLane(doc, lane)
    const gone = take()
    expect(gone.filter((c) => c[0] === 'engine_point_remove')).toHaveLength(2)
    expect(gone).toContainEqual(['engine_lane_remove', up[1]])
    expect(gone).toContainEqual(['engine_param_set', dh, 1, 4000])
  })

  it('a lane keeps the range its param had when it was made, even if the param is later redefined', () => {
    const cutoff = DEVICES[1].params[1]
    const was = { ...cutoff }
    const { doc, take } = setup()
    const t = addTrack(doc, 'a')
    const dev = addDevice(doc, t, 1)
    const target = { scope: t, kind: 'effect' as const, owner: dev, param: '1' }
    const stored = addLane(doc, target, cutoff) // made with the range it has now
    const legacy = addLane(doc, { ...target, param: '2' }) // made before ranges were stored: nothing on it
    expect(getLanes(doc).find((l) => l.id === stored)).toMatchObject({ min: 20, max: 20000, scale: 'log' })
    expect(getLanes(doc).find((l) => l.id === legacy)?.min).toBeUndefined()
    stashLaneRanges(doc) // the backfill: the legacy lane gets the current range
    expect(getLanes(doc).find((l) => l.id === legacy)).toMatchObject({ min: 0.05, max: 2, scale: 'lin' })
    try {
      Object.assign(cutoff, { min: 30, max: 10000 }) // a new version narrows the param
      const r = resolveTarget(doc, getLanes(doc).find((l) => l.id === stored)!)!
      expect(r.def).toMatchObject({ min: 20, max: 20000, scale: 'log' }) // the lane still maps over the old range
      expect(resolveTarget(doc, target)!.def).toMatchObject({ min: 30, max: 10000 }) // a fresh target sees the new one
      take()
      updateLaneLfo(doc, stored, { depth: 0.5 }) // re-upserts the lane
      const up = take().find((c) => c[0] === 'engine_lane_upsert')!
      expect(up.slice(6, 9)).toEqual([20, 20000, 1])
    } finally {
      Object.assign(cutoff, was)
    }
  })

  it('an LFO lane sends its wave with the knob as the centre, which follows the knob; leaving LFO mode says so once', () => {
    const { doc, bridge, take } = setup()
    const t = addTrack(doc, 'audio')
    const dev = addDevice(doc, t, 1)
    setParam(doc, dev, 1, 200) // cutoff 200 Hz on 20..20000 (log): a third of the way along
    const lane = addLane(doc, { scope: t, kind: 'effect', owner: dev, param: '1' })
    expect(take().map((c) => c[0])).not.toContain('engine_lane_lfo') // keyframes: nothing about LFOs
    const lh = take()
    setLaneState(doc, lane, 'lfo')
    const on = take().find((c) => c[0] === 'engine_lane_lfo')!
    expect(on.slice(2, 6)).toEqual([1, 0, 1, 0.25]) // lfo on, sine, 1 Hz, depth 0.25 (the defaults)
    expect(on[6]).toBeCloseTo(1 / 3, 5)
    expect(lh).toEqual([])

    updateLaneLfo(doc, lane, { shape: 1, rate: 4, depth: 0.5 })
    expect(take().find((c) => c[0] === 'engine_lane_lfo')!.slice(2, 6)).toEqual([1, 1, 4, 0.5])

    setParam(doc, dev, 1, 2000) // the knob moves: the centre goes with it
    expect(take().find((c) => c[0] === 'engine_lane_lfo')![6]).toBeCloseTo(2 / 3, 5)
    bridge.live(dev, 1, 20000) // a drag in progress
    expect(take().find((c) => c[0] === 'engine_lane_lfo')![6]).toBeCloseTo(1, 5)

    setLaneState(doc, lane, 'keyframes')
    expect(take().find((c) => c[0] === 'engine_lane_lfo')!.slice(2, 3)).toEqual([0])
    setParam(doc, dev, 1, 300)
    expect(take().map((c) => c[0])).not.toContain('engine_lane_lfo')
    bridge.destroy()
  })

  it('looper lanes use the looper param codes; deleting the looper takes its lanes along', () => {
    const { doc, take } = setup()
    const t = addTrack(doc, 'scape', 'soundscape')
    const lp = getLoopers(doc)[0].id
    const lh = take().find((c) => c[0] === 'engine_looper_upsert')![1]
    const lane = addLane(doc, { scope: t, kind: 'looper', owner: lp, param: 'cutoff' })
    expect(take().find((c) => c[0] === 'engine_lane_upsert')!.slice(2)).toEqual([1, lh, 3, 1, 200, 20000, 1])
    expect(addLane(doc, { scope: t, kind: 'looper', owner: lp, param: 'cutoff' })).toBe(lane) // one lane per param
    deleteLooper(doc, lp)
    expect(getLanes(doc)).toHaveLength(0)
    expect(take().map((c) => c[0])).toContain('engine_lane_remove')
  })

  it('points that arrive before their lane are sent once it exists; unresolvable targets are ignored', () => {
    const { doc, take } = setup()
    const t = addTrack(doc, 'a')
    const dev = addDevice(doc, t, 3) // reverb
    take()
    doc.transact(() => {
      addPoint(doc, 'L', 10, 0.5) // lane not created yet (a concurrent client's order)
      addLane(doc, { scope: t, kind: 'effect', owner: 'ghost', param: '0' })
    })
    expect(take().filter((c) => c[0].startsWith('engine_lane') || c[0] === 'engine_point_upsert')).toEqual([])
    sweepOrphans(doc)
    expect(getLanes(doc)).toHaveLength(0)
    expect(getPoints(doc)).toHaveLength(0)
    expect(resolveTarget(doc, { scope: t, kind: 'effect', owner: dev, param: '3' })?.def.name).toBe('predelay')
  })

  it('master (global) effects can be automated, and a track delete cascades through its devices', () => {
    const { doc, take } = setup()
    const fx = addDevice(doc, MASTER_TRACK, 3)
    take()
    const lane = addLane(doc, { scope: MASTER_TRACK, kind: 'effect', owner: fx, param: '0' })
    expect(laneOf(doc, { scope: MASTER_TRACK, kind: 'effect', owner: fx, param: '0' })?.id).toBe(lane)
    expect(take().find((c) => c[0] === 'engine_lane_upsert')).toBeTruthy()
    const t = addTrack(doc, 'a')
    const d2 = addDevice(doc, t, 1)
    addLane(doc, { scope: t, kind: 'effect', owner: d2, param: '1' })
    deleteTrack(doc, t)
    expect(getLanes(doc).map((l) => l.owner)).toEqual([fx])
  })

  it('evaluates like the engine: holds the ends, lerps, steps on hold', () => {
    const pts = [
      { pos: 100, value: 0.2, curve: 'linear' as const },
      { pos: 200, value: 1, curve: 'hold' as const },
      { pos: 300, value: 0, curve: 'linear' as const },
    ]
    expect(evalPoints([], 5)).toBeNull()
    expect(evalPoints(pts, 0)).toBe(0.2)
    expect(evalPoints(pts, 150)).toBeCloseTo(0.6)
    expect(evalPoints(pts, 250)).toBe(1)
    expect(evalPoints(pts, 300)).toBe(0)
    expect(evalPoints(pts, 999)).toBe(0)
  })
})

