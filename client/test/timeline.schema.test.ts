// Schema v4 (docs/engine.md §3): regions and markers, the cached time map, migrateToV4 and collaboration rules.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  SCHEMA_VERSION, addAudioClip, addClickTrack, addMarker, addMidiClip, addNote, addPad, addPoint, addLane, addRegion, addTrack, chatLog, clipEnd, clipLength, clipStart,
  clipsMap, deleteMarker, deleteRegion, ensureTimeline, getClips, getMarkers, getNotes, getPpq, getRegions, getSampleRate, getTimeMap, getTracks,
  isFutureDoc, metaMap, midiClipEndSample, midiClipStartSample, migrateToV2, migrateToV3, migrateToV4, notesMap, padsMap, pointsMap, regionsMap, repairRegions,
  setRegion, sweepOrphans, timeMap, tracksMap, updateMarker, getPads, getPoints, undoScope, type Region,
} from '@mobdaw/shared'

const R = 48000
const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}
const fresh = () => {
  const d = new Y.Doc()
  metaMap(d).set('schemaVersion', SCHEMA_VERSION)
  metaMap(d).set('sampleRate', R)
  ensureTimeline(d)
  return d
}
const ym = (o: object) => new Y.Map<unknown>(Object.entries(o))

describe('regions and markers', () => {
  it('a fresh timeline has the default region and ppq, written once', () => {
    const d = fresh()
    expect(getRegions(d)).toEqual([{ id: 'default', bar: 1, kind: 'metered', bpm: 120, num: 4, den: 4 }])
    expect(getPpq(d)).toBe(960)
    const before = Y.encodeStateAsUpdate(d)
    ensureTimeline(d)
    expect(Y.encodeStateAsUpdate(d)).toEqual(before)
  })
  it('adds, edits and deletes (merging into the previous); bar 1 stays', () => {
    const d = fresh()
    const id = addRegion(d, { bar: 5, bpm: 90, num: 3, den: 4 })
    expect(getRegions(d).map((r) => r.bar)).toEqual([1, 5])
    // same bar replaces and keeps the id
    expect(addRegion(d, { bar: 5, bpm: 100, num: 6, den: 8 })).toBe(id)
    expect(getRegions(d)[1]).toMatchObject({ id, bpm: 100, num: 6, den: 8 })
    setRegion(d, id, { rampTo: 140 })
    expect(getRegions(d)[1]).toMatchObject({ rampTo: 140 })
    setRegion(d, id, { rampTo: undefined, num: 7, den: 8, groups: [2, 2, 3] })
    expect(getRegions(d)[1]).toMatchObject({ num: 7, groups: [2, 2, 3] })
    expect('rampTo' in getRegions(d)[1]).toBe(false)
    setRegion(d, id, { num: 5 }) // groups no longer sum: dropped
    expect('groups' in getRegions(d)[1]).toBe(false)
    expect(deleteRegion(d, 'default')).toBe(false)
    expect(deleteRegion(d, 'nope')).toBe(false)
    expect(deleteRegion(d, id)).toBe(true)
    expect(getRegions(d)).toHaveLength(1)
    // the map follows
    expect(getTimeMap(d).meterAt(5)).toMatchObject({ num: 4 })
  })
  it('a free region carries on with the meter that was in effect', () => {
    const d = fresh()
    addRegion(d, { bar: 3, bpm: 80, num: 3, den: 4 })
    addRegion(d, { bar: 6, kind: 'free', length: 2 * R })
    const rs = getRegions(d)
    expect(rs.map((r) => [r.bar, r.kind])).toEqual([[1, 'metered'], [3, 'metered'], [6, 'free'], [7, 'metered']])
    expect(rs[3]).toMatchObject({ bpm: 80, num: 3, den: 4 })
    // switching kind
    setRegion(d, rs[2].id, { kind: 'metered' })
    expect(getRegions(d)[2]).toMatchObject({ kind: 'metered', bpm: 80, num: 3 })
    expect('length' in getRegions(d)[2]).toBe(false)
  })
  it('markers', () => {
    const d = fresh()
    const a = addMarker(d, { bar: 9, label: 'B' })
    addMarker(d, { bar: 1, label: 'A', text: 'intro' })
    expect(getMarkers(d).map((m) => m.label)).toEqual(['A', 'B'])
    updateMarker(d, a, { bar: 2, text: 'x' })
    expect(getMarkers(d)[1]).toMatchObject({ bar: 2, text: 'x' })
    updateMarker(d, a, { text: '' })
    expect('text' in getMarkers(d)[1]).toBe(false)
    deleteMarker(d, a)
    expect(getMarkers(d)).toHaveLength(1)
  })
  it('regions and markers are in the undo scope', () => {
    const d = fresh()
    const um = new Y.UndoManager(undoScope(d))
    addRegion(d, { bar: 4, bpm: 70, num: 4, den: 4 })
    um.undo()
    expect(getRegions(d)).toHaveLength(1)
  })
  it('getTimeMap is cached and rebuilt on region, tempo and meta changes', () => {
    const d = fresh()
    const m1 = getTimeMap(d)
    expect(getTimeMap(d)).toBe(m1)
    const id = addRegion(d, { bar: 2, bpm: 60, num: 4, den: 4 })
    const m2 = getTimeMap(d)
    expect(m2).not.toBe(m1)
    expect(m2.barStartSample(3)).toBe(2 * R + 4 * R)
    setRegion(d, id, { bpm: 240 })
    expect(getTimeMap(d).barStartSample(3)).toBe(3 * R)
    metaMap(d).set('sampleRate', 44100)
    expect(getTimeMap(d).sampleRate).toBe(44100)
    // inside a transaction that has already written, the map is current too
    d.transact(() => {
      setRegion(d, id, { bpm: 120 })
      expect(getTimeMap(d).barStartSample(3)).toBe(4 * 44100)
    })
  })
  it('clip helpers go through the map', () => {
    const d = fresh()
    addRegion(d, { bar: 2, bpm: 60, num: 4, den: 4 })
    const t = addTrack(d, 'k', 'midi')
    const c = getClips(d)[0]
    expect(c).toBeUndefined()
    const id = addMidiClip(d, { trackId: t, startTick: 4 * 960, lengthTicks: 4 * 960 })
    const clip = getClips(d).find((x) => x.id === id)!
    if (clip.kind !== 'midi') throw new Error()
    expect(midiClipStartSample(d, clip)).toBe(2 * R)
    expect(midiClipEndSample(d, clip)).toBe(6 * R) // a bar at 60 bpm
    expect(clipStart(clip, d)).toBe(2 * R)
    expect(clipLength(clip, getTimeMap(d))).toBe(4 * R)
    expect(clipEnd(clip, d)).toBe(6 * R)
    const a = getClips(d).length
    expect(a).toBe(1)
  })
  it('the click track stores no clip (its beats come from the map)', () => {
    const d = fresh()
    const t = addClickTrack(d)
    expect(getClips(d).filter((c) => c.trackId === t)).toEqual([])
    expect(getNotes(d)).toHaveLength(0)
  })
})

describe('version guard', () => {
  it('a doc from the future is left alone', () => {
    const d = new Y.Doc()
    metaMap(d).set('schemaVersion', SCHEMA_VERSION + 1)
    expect(isFutureDoc(d)).toBe(true)
    const before = Y.encodeStateAsUpdate(d)
    migrateToV2(d)
    migrateToV3(d)
    migrateToV4(d)
    sweepOrphans(d)
    expect(Y.encodeStateAsUpdate(d)).toEqual(before)
    expect(metaMap(d).get('schemaVersion')).toBe(SCHEMA_VERSION + 1)
  })
  it('current and older docs are not', () => {
    const d = fresh()
    expect(isFutureDoc(d)).toBe(false)
    expect(isFutureDoc(new Y.Doc())).toBe(false)
  })
})

// --- migration

type Old = { id: string; trackId: string; start: number; bpm: number; ppq: number; lengthTicks: number; loopTicks?: number; forever?: boolean }
const oldNote = (d: Y.Doc, id: string, clipId: string, tick: number, durTicks: number) =>
  notesMap(d).set(id, ym({ id, clipId, tick, durTicks, pitch: 60, velocity: 1 }))
/** The v3 sample of a note boundary, by the old per-clip formula. */
const oldSample = (c: Old, tick: number) => c.start + Math.round((tick * 60 * R) / (c.bpm * c.ppq))

/** Notes inside the clip's extent (a note past the end could straddle the leading free region, which migration can't bend). */
const notesOf = (c: Old) =>
  [[0, c.ppq / 4], [c.ppq / 3, c.ppq / 2 + 1], [c.ppq * 1.5, 7], [(c.loopTicks ?? c.lengthTicks) - c.ppq / 8, c.ppq / 16]].filter(([t, d]) => t + d <= c.lengthTicks)

function v3Fixture({ click = true, clickStart = 24000 } = {}) {
  const d = new Y.Doc()
  metaMap(d).set('schemaVersion', 3)
  metaMap(d).set('sampleRate', R)
  const track = (id: string, name: string, kind: string, order: number, role?: string) =>
    tracksMap(d).set(id, ym({ id, name, kind, order, muted: false, soloed: false, ...(role ? { role } : {}) }))
  track('tc', 'click', 'midi', 0, click ? 'click' : undefined)
  track('tb', 'bass', 'midi', 1)
  track('ta', 'arp', 'midi', 2)
  track('tk', 'keys', 'midi', 3)
  track('tu', 'vox', 'audio', 4)
  track('ts', 'wash', 'soundscape', 5)
  const clips: Old[] = [
    { id: 'click', trackId: 'tc', start: clickStart, bpm: 100, ppq: 480, lengthTicks: 16 * 480, loopTicks: 4 * 480, forever: true },
    { id: 'bass', trackId: 'tb', start: 96000, bpm: 90, ppq: 960, lengthTicks: 8 * 960 },
    { id: 'arp', trackId: 'ta', start: 200001, bpm: 140, ppq: 1920, lengthTicks: 16 * 1920, loopTicks: 4 * 1920, forever: true },
    { id: 'keys', trackId: 'tk', start: clickStart + 5000, bpm: 100, ppq: 480, lengthTicks: 6 * 480 },
    { id: 'early', trackId: 'tk', start: 1000, bpm: 100, ppq: 480, lengthTicks: 240 }, // sits in the leading free region
  ]
  for (const c of clips) clipsMap(d).set(c.id, ym({ ...c, kind: 'midi' }))
  clipsMap(d).set('au', ym({ id: 'au', trackId: 'tu', kind: 'audio', start: 12345, length: 99999, sourceHash: 'h', sourceOffset: 7, gain: 1, fadeIn: 0, fadeOut: 0, fadeShape: 0 }))
  let n = 0
  for (const c of clips) for (const [tick, dur] of notesOf(c)) oldNote(d, `n${n++}`, c.id, tick, dur)
  padsMap(d).set('p', ym({ id: 'p', trackId: 'ts', start: 5000, length: 7000 }))
  const lane = addLane(d, { scope: 'tb', kind: 'synth', owner: 'x', param: '0' } as never)
  addPoint(d, lane, 4321, 0.5)
  return { d, clips }
}

describe('migrateToV4', () => {
  const run = (d: Y.Doc) => (migrateToV2(d), migrateToV3(d), migrateToV4(d))

  it('keeps every note on the same samples (+-1), with a leading free region for a click that starts late', () => {
    const { d, clips } = v3Fixture()
    run(d)
    expect(metaMap(d).get('schemaVersion')).toBe(4)
    expect(getPpq(d)).toBe(960)
    const regs = getRegions(d)
    expect(regs.map((r) => [r.bar, r.kind])).toEqual([[1, 'free'], [2, 'metered']])
    expect(regs[0]).toMatchObject({ kind: 'free', length: 24000 })
    expect(regs[1]).toMatchObject({ bpm: 100, num: 4, den: 4 })
    const map = getTimeMap(d)
    // the click's first bar sits on bar 2
    expect(map.barStartSample(2)).toBe(24000)
    const notes = getNotes(d)
    // the click's stored pattern is gone (its beats are generated from the map); every other note stays put
    expect(getClips(d).find((x) => x.id === 'click')).toBeUndefined()
    const kept = clips.filter((c) => c.id !== 'click')
    expect(notes.length).toBe(kept.reduce((a, c) => a + notesOf(c).length, 0))
    for (const c of kept) {
      const clip = getClips(d).find((x) => x.id === c.id)!
      if (clip.kind !== 'midi') throw new Error()
      expect('start' in clip || 'bpm' in clip || 'ppq' in clip).toBe(false)
      expect(midiClipStartSample(map, clip)).toBe(c.start)
      expect(Math.abs(midiClipEndSample(map, clip) - oldSample(c, c.lengthTicks))).toBeLessThanOrEqual(1)
      if (c.loopTicks) expect(clip.loopTicks).toBeGreaterThan(0)
      expect(clip.forever).toBe(c.forever)
      // all notes' starts and ends
      const mine = notes.filter((n) => n.clipId === c.id)
      const orig = notesOf(c)
      expect(mine).toHaveLength(orig.length)
      mine.sort((a, b) => a.tick - b.tick)
      orig.forEach(([tick, dur], i) => {
        const n = mine[i]
        expect(Math.abs(map.tickToSample(clip.startTick + n.tick) - oldSample(c, tick))).toBeLessThanOrEqual(1)
        expect(Math.abs(map.tickToSample(clip.startTick + n.tick + n.durTicks) - oldSample(c, tick + dur))).toBeLessThanOrEqual(1)
      })
    }
  })

  it('leaves audio, pads and automation points untouched', () => {
    const { d } = v3Fixture()
    const audioBefore = clipsMap(d).get('au')!.toJSON()
    const padBefore = getPads(d)
    const ptsBefore = getPoints(d)
    run(d)
    expect(clipsMap(d).get('au')!.toJSON()).toEqual(audioBefore)
    expect(getPads(d)).toEqual(padBefore)
    expect(getPoints(d)).toEqual(ptsBefore)
    expect(getTracks(d)).toHaveLength(6)
  })

  it('is idempotent and writes nothing the second time', () => {
    const { d } = v3Fixture()
    run(d)
    const before = Y.encodeStateAsUpdate(d)
    run(d)
    migrateToV4(d)
    expect(Y.encodeStateAsUpdate(d)).toEqual(before)
    expect(chatLog(d).length).toBe(1)
  })

  it('does not undo (origin migrate)', () => {
    const { d } = v3Fixture()
    migrateToV2(d)
    migrateToV3(d)
    const um = new Y.UndoManager(undoScope(d), { trackedOrigins: new Set([null]) })
    migrateToV4(d)
    expect(um.undoStack).toHaveLength(0)
  })

  it('writes one system chat message naming the map and the clips off the grid', () => {
    const { d } = v3Fixture()
    run(d)
    const log = chatLog(d).toArray()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ system: true, id: 'migrate-v4', username: 'mobdaw' })
    expect(log[0].text).toContain('migrated to a shared timeline at 100 bpm 4/4')
    expect(log[0].text).toContain('free region')
    expect(log[0].text).toContain("'bass' at bar")
    expect(log[0].text).toContain("'arp' at bar")
    expect(log[0].text).not.toContain("'keys'")
    expect(log[0].text).toContain('2 MIDI clips had their own tempo') // bass and arp; 'early' sits in the free region
  })

  it('a click at 0 gives one region; its meter comes from the loop length', () => {
    const { d } = v3Fixture({ clickStart: 0 })
    clipsMap(d).get('click')!.set('loopTicks', 6 * 480)
    run(d)
    expect(getRegions(d)).toEqual([{ id: 'default', bar: 1, kind: 'metered', bpm: 100, num: 6, den: 4 }])
  })

  it('without a click: the bpm carrying most MIDI time, else 120; no message with no MIDI', () => {
    const { d } = v3Fixture({ click: false })
    run(d)
    // totals (seconds): click 16 beats@100 = 9.6 + keys/early at 100 = 3.6+... vs bass 8@90 = 5.33 vs arp 16@140 = 6.86
    expect(getRegions(d)).toMatchObject([{ bpm: 100, num: 4 }])
    const empty = new Y.Doc()
    metaMap(empty).set('schemaVersion', 3)
    metaMap(empty).set('sampleRate', R)
    run(empty)
    expect(getRegions(empty)).toMatchObject([{ bpm: 120, num: 4, den: 4 }])
    expect(chatLog(empty).length).toBe(0)
    expect(metaMap(empty).get('schemaVersion')).toBe(4)
  })

  it('also repairs a fresh v4 doc that has no timeline yet and v3-shaped clips', () => {
    const d = new Y.Doc()
    metaMap(d).set('schemaVersion', 4)
    metaMap(d).set('sampleRate', R)
    tracksMap(d).set('t', ym({ id: 't', name: 't', kind: 'midi', order: 1, muted: false, soloed: false }))
    migrateToV4(d)
    expect(getRegions(d)).toHaveLength(1)
    expect(getPpq(d)).toBe(960)
    expect(regionsMap(d).size).toBe(1)
  })

  it('converts a v3-shaped clip an old client wrote into a v4 doc, using the existing map', () => {
    const d = fresh()
    addRegion(d, { bar: 1, bpm: 60, num: 4, den: 4 })
    clipsMap(d).set('old', ym({ id: 'old', trackId: 't', kind: 'midi', start: R, bpm: 120, ppq: 960, lengthTicks: 960 * 4 }))
    oldNote(d, 'on', 'old', 960, 480)
    migrateToV4(d)
    const c = getClips(d).find((x) => x.id === 'old')!
    if (c.kind !== 'midi') throw new Error()
    expect(midiClipStartSample(d, c)).toBe(R)
    expect(midiClipEndSample(d, c)).toBe(R + 2 * R)
    expect(chatLog(d).length).toBe(0)
    const n = getNotes(d)[0]
    expect(getTimeMap(d).tickToSample(c.startTick + n.tick)).toBe(R + R / 2) // one beat at the clip's old 120 bpm = 0.5 s
  })

  it('two clients migrating the same doc converge to one state', () => {
    const { d } = v3Fixture()
    const a = new Y.Doc(), b = new Y.Doc()
    Y.applyUpdate(a, Y.encodeStateAsUpdate(d))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(d))
    run(a)
    run(b)
    sync(a, b)
    expect(getRegions(a)).toEqual(getRegions(b))
    expect(regionsMap(a).size).toBe(2)
    expect(getClips(a)).toEqual(getClips(b))
    expect(getNotes(a).sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual(getNotes(b).sort((x, y) => (x.id < y.id ? -1 : 1)))
    // the message id is fixed; concurrent writers may each add one before syncing (documented), never more
    expect(chatLog(a).length).toBeLessThanOrEqual(2)
  })
})

// --- collaboration

describe('collaboration', () => {
  const pair = () => {
    const a = fresh()
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    return [a, b] as const
  }
  it('concurrent edits to different regions converge', () => {
    const [a, b] = pair()
    const r1 = addRegion(a, { bar: 5, bpm: 90, num: 4, den: 4 })
    const r2 = addRegion(a, { bar: 9, bpm: 100, num: 3, den: 4 })
    sync(a, b)
    setRegion(a, r1, { bpm: 60 })
    setRegion(b, r2, { num: 6, den: 8 })
    setRegion(b, 'default', { bpm: 130 })
    sync(a, b)
    expect(getRegions(a)).toEqual(getRegions(b))
    expect(getRegions(a).map((r) => r.kind === 'metered' && [r.bpm, r.num])).toEqual([[130, 4], [60, 4], [100, 6]])
    expect(getTimeMap(a).barStartSample(9)).toBe(getTimeMap(b).barStartSample(9))
  })
  it('deleting a region while another client edits it keeps a valid partition', () => {
    const [a, b] = pair()
    const r = addRegion(a, { bar: 5, bpm: 90, num: 4, den: 4 })
    addRegion(a, { bar: 9, bpm: 100, num: 4, den: 4 })
    sync(a, b)
    deleteRegion(a, r)
    setRegion(b, r, { bpm: 70 }) // edits the deleted entry's map
    sync(a, b)
    for (const d of [a, b]) {
      sweepOrphans(d)
      const rs = getRegions(d)
      expect(rs[0].bar).toBe(1)
      expect(new Set(rs.map((x) => x.bar)).size).toBe(rs.length)
      expect(rs.map((x) => x.bar)).toEqual([1, 9])
    }
    sync(a, b)
    expect(getRegions(a)).toEqual(getRegions(b))
  })
  it('deleting the region at bar 1 from raw state is repaired', () => {
    const [a, b] = pair()
    regionsMap(a).delete('default') // an old or buggy client
    sync(a, b)
    repairRegions(b)
    sync(a, b)
    expect(getRegions(a)[0]).toMatchObject({ id: 'default', bar: 1 })
    expect(regionsMap(b).has('default')).toBe(true)
  })
  it('same-bar duplicates resolve to the smallest id on every client, and repair writes it back', () => {
    const [a, b] = pair()
    addRegion(a, { bar: 4, bpm: 90, num: 4, den: 4 })
    sync(a, b)
    // both add a region at bar 6 concurrently (different ids)
    const x = addRegion(a, { bar: 6, bpm: 70, num: 4, den: 4 })
    const y = addRegion(b, { bar: 6, bpm: 80, num: 3, den: 4 })
    expect(x).not.toBe(y)
    sync(a, b)
    const winner = x < y ? x : y
    for (const d of [a, b]) expect(getRegions(d).find((r) => r.bar === 6)!.id).toBe(winner)
    repairRegions(a)
    repairRegions(b)
    sync(a, b)
    expect(regionsMap(a).size).toBe(3)
    expect([...regionsMap(a).keys()].sort()).toEqual([...regionsMap(b).keys()].sort())
    expect(timeMap(getRegions(a), R, 960).barStartSample(7)).toBe(getTimeMap(b).barStartSample(7))
  })
})
