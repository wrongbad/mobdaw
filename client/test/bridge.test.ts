import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addAudioClip, addDevice, addMidiClip, addNote, addSample, addTrack, clipsMap, deleteClip, deleteDevice, deleteTrack,
  getClips, getSampleRate, getTracks, migrateToV2, notesMap, setParam, splitClip, sweepOrphans, tracksMap,
  updateClip, updateNote, updateTrack, type SampleMeta,
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
})
