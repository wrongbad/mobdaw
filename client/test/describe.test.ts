import { describe as suite, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  HISTORY_COLLS, REVERB, addDevice, addMarker, addMidiClip, addNote, addPad, addPoint, addLane, addRegion, addTrack, collMap, deleteClip, deleteTrack,
  describe, deepEqual, ensureTimeline, entityJson, metaMap, setKey, setParam, setRegion, updateClip, updateNote, updateTrack, updateMarker,
  type Json, type Patch,
} from '@mobdaw/shared'

/** Everything tracked, as the server's mirror would hold it. */
const snap = (doc: Y.Doc) => {
  const m = new Map<string, Json>()
  for (const c of HISTORY_COLLS) {
    if (c === 'meta') m.set('meta/meta', entityJson(doc, c, 'meta')!)
    else for (const id of collMap(doc, c).keys()) m.set(`${c}/${id}`, entityJson(doc, c, id)!)
  }
  return m
}
/** Run `fn` and return the patch it made, the way the server derives one. */
function patchOf(doc: Y.Doc, fn: () => void): { patch: Patch; lookup: (c: string, id: string) => Json | undefined } {
  const before = snap(doc)
  doc.transact(fn)
  const after = snap(doc)
  const patch: Patch = []
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const [coll, id] = k.split('/') as [(typeof HISTORY_COLLS)[number], string]
    const b = before.get(k) ?? null, a = after.get(k) ?? null
    if (!deepEqual(a, b)) patch.push({ coll, id, before: b, after: a })
  }
  return { patch, lookup: (c, id) => after.get(`${c}/${id}`) }
}

suite('describe', () => {
  const doc = new Y.Doc()
  metaMap(doc).set('schemaVersion', 4)
  ensureTimeline(doc)
  const say = (fn: () => void) => {
    const { patch, lookup } = patchOf(doc, fn)
    const s = describe(patch, lookup as never)
    expect(s.length).toBeLessThanOrEqual(40)
    return s
  }

  let bass = '', clip = ''
  it('tracks', () => {
    expect(say(() => { bass = addTrack(doc, 'Bass', 'midi') })).toBe('added track Bass')
    expect(say(() => updateTrack(doc, bass, { name: 'Keys' }))).toBe('renamed track Keys')
    expect(say(() => updateTrack(doc, bass, { muted: true }))).toBe('muted Keys')
    expect(say(() => updateTrack(doc, bass, { soloed: true }))).toBe('soloed Keys')
    expect(say(() => updateTrack(doc, bass, { name: 'Bass' }))).toBe('renamed track Bass')
  })
  it('clips and notes', () => {
    expect(say(() => { clip = addMidiClip(doc, { trackId: bass, startTick: 0 }) })).toBe('added clip to Bass')
    expect(say(() => { for (let i = 0; i < 16; i++) addNote(doc, { clipId: clip, tick: i * 10, durTicks: 5, pitch: 60, velocity: 90 }) })).toBe('added 16 notes to Bass')
    expect(say(() => updateClip(doc, clip, { startTick: 960 }))).toBe('moved clip on Bass')
    expect(say(() => updateClip(doc, clip, { lengthTicks: 480 }))).toBe('resized clip on Bass')
    const ids = [...collMap(doc, 'notes').keys()]
    expect(say(() => ids.slice(0, 3).forEach((id) => updateNote(doc, id, { tick: 1 })))).toBe('moved 3 notes')
    expect(say(() => ids.slice(0, 2).forEach((id) => updateNote(doc, id, { velocity: 10 })))).toBe('velocity of 2 notes')
    expect(say(() => deleteClip(doc, clip))).toBe('deleted clip from Bass')
  })
  it('devices and params', () => {
    let dev = ''
    expect(say(() => { dev = addDevice(doc, bass, REVERB) })).toBe('added reverb to Bass')
    expect(say(() => setParam(doc, dev, 0, 0.5))).toBe('reverb mix 0.30→0.50')
    expect(say(() => { setParam(doc, dev, 0, 0.6); setParam(doc, dev, 1, 0.1) })).toBe('edited reverb (2 params)')
    expect(say(() => setParam(doc, `mix:${bass}`, 0, 0.8))).toBe('Bass volume 1.00→0.80')
  })
  it('timeline and project', () => {
    const rid = [...collMap(doc, 'regions').keys()][0]
    expect(say(() => setRegion(doc, rid, { bpm: 128 }))).toBe('tempo 120→128 at bar 1')
    expect(say(() => addRegion(doc, { bar: 9, kind: 'metered', bpm: 90, num: 4, den: 4 }))).toBe('added tempo 90 at bar 9')
    expect(say(() => addRegion(doc, { bar: 20, kind: 'free', length: 48000 }))).toBe('added free bar at bar 20')
    let mk = ''
    expect(say(() => { mk = addMarker(doc, { bar: 3, label: 'Verse 2' }) })).toBe('added marker Verse 2 at bar 3')
    expect(say(() => updateMarker(doc, mk, { label: 'Chorus' }))).toBe('renamed marker Verse 2→Chorus')
    expect(say(() => setKey(doc, 'D minor'))).toBe('key D minor')
    expect(say(() => metaMap(doc).set('schemaVersion', 5))).toBe('migrated project')
  })
  it('automation, pads and the fallback', () => {
    const lane = addLane(doc, { scope: bass, kind: 'effect', owner: `mix:${bass}`, param: '0' })
    expect(say(() => { for (let i = 0; i < 4; i++) addPoint(doc, lane, i, 0.5) })).toBe('added 4 automation points')
    expect(say(() => { addPad(doc, bass, 0, 10); addPad(doc, bass, 20, 10) })).toBe('added 2 pads')
    expect(say(() => { addPad(doc, bass, 40, 10); updateTrack(doc, bass, { order: 7 }) })).toBe('moved track Bass')
    expect(describe([{ coll: 'devices', id: 'a', before: { id: 'a' }, after: { id: 'a', x: 1 } }, { coll: 'devices', id: 'b', before: { id: 'b' }, after: { id: 'b', x: 1 } }])).toBe('edited 2 devices')
    expect(say(() => deleteTrack(doc, bass))).toBe('deleted track Bass')
  })
  it('never exceeds 40 characters, with long names', () => {
    const long = 'A very long track name indeed, longer than forty'
    for (const f of [() => addTrack(doc, long, 'midi'), () => updateTrack(doc, [...collMap(doc, 'tracks').keys()][0], { name: long + '!' })]) say(f)
    expect(describe([{ coll: 'tracks', id: 'x', before: { name: 'a' }, after: { name: long } }])).toBe('renamed track A very long track name …')
  })
})
