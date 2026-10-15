import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  SIMPLE_FILTER, addAudioClip, addDevice, addMidiClip, addNote, addTrack, getClips, getDevices, getNotes, getTracks, undoScope, type AudioClip, type MidiClip,
} from '@mobdaw/shared'
import {
  addImportedClip, commitParam, commitParams, deleteClips, loopClip, loopForever, passClip, reorderDevice, startPass, trimClip, unloopClip,
} from '../src/project/actions'

const RATE = 1000
const setup = () => {
  const doc = new Y.Doc()
  const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
  return { doc, undo, track: addTrack(doc, 't', 'audio') }
}
const audio = (doc: Y.Doc, c: Partial<AudioClip> = {}) => {
  const track = getTracks(doc)[0].id
  const id = addAudioClip(doc, { trackId: track, sourceHash: 'h', start: 1000, length: 2000, ...c })
  return () => getClips(doc).find((x) => x.id === id) as AudioClip
}
const midi = (doc: Y.Doc, c: Partial<MidiClip> = {}) => {
  const id = addMidiClip(doc, { trackId: getTracks(doc)[0].id, start: 0, ppq: 960, lengthTicks: 3840, ...c })
  return () => getClips(doc).find((x) => x.id === id) as MidiClip
}

describe('clip loops', () => {
  it('dragging a plain audio clip longer starts a loop whose pass is the old length', () => {
    const { doc } = setup()
    const c = audio(doc, { length: 2000 })
    loopClip(doc, RATE, c(), 5000, 10000)
    expect(c()).toMatchObject({ length: 5000, loopLength: 2000, loopPhase: 0, sourceOffset: 0 })
  })
  it('an already looping clip keeps its pass, and forever is cleared', () => {
    const { doc } = setup()
    const c = audio(doc, { length: 4000, loopLength: 1000, forever: true })
    loopClip(doc, RATE, c(), 6000, 10000)
    expect(c()).toMatchObject({ length: 6000, loopLength: 1000, forever: false })
  })
  it('the extent never goes below the minimum', () => {
    const { doc } = setup()
    const c = audio(doc)
    loopClip(doc, RATE, c(), 1, 10000)
    expect(c().length).toBe(50)
  })
  it('midi extents snap to sixteenths and start the pass at the old length', () => {
    const { doc } = setup()
    const c = midi(doc)
    // 120 bpm default? use the clip's own: ticks per sample = bpm*ppq/(60*rate)
    const k = (c().bpm * c().ppq) / (60 * RATE)
    loopClip(doc, RATE, c(), (3840 * 2 + 10) / k, 0)
    expect(c()).toMatchObject({ lengthTicks: 7680, loopTicks: 3840 })
  })
  it('startPass folds a stale pass phase into the source offset', () => {
    const { doc } = setup()
    const c = audio(doc, { sourceOffset: 100, loopLength: 500, loopPhase: 40, length: 2000 })
    expect(startPass(c(), 10000)).toEqual({ sourceOffset: 140, loopLength: 2000, loopPhase: 0 })
    expect(startPass(c(), 1000).loopLength).toBe(860) // limited by the source
  })
  it('passClip clamps the pass between the minimum and the clip', () => {
    const { doc } = setup()
    const c = audio(doc, { length: 4000, loopLength: 1000 })
    passClip(doc, RATE, c(), 2500, 10000)
    expect(c().loopLength).toBe(2500)
    passClip(doc, RATE, c(), 10, 10000)
    expect(c().loopLength).toBe(50)
    passClip(doc, RATE, c(), 99999, 3000)
    expect(c().loopLength).toBe(3000)
  })
  it('loopForever toggles on a looping clip and starts a doubled loop otherwise', () => {
    const { doc } = setup()
    const c = audio(doc, { length: 1000 })
    loopForever(doc, c(), 10000)
    expect(c()).toMatchObject({ length: 2000, loopLength: 1000, forever: true })
    loopForever(doc, c(), 10000)
    expect(c().forever).toBe(false)
    loopForever(doc, c(), 10000)
    expect(c().forever).toBe(true)
    const m = midi(doc)
    loopForever(doc, m(), 0)
    expect(m()).toMatchObject({ lengthTicks: 7680, loopTicks: 3840, forever: true })
  })
  it('unloopClip puts the extent back to the first pass', () => {
    const { doc } = setup()
    const c = audio(doc, { sourceOffset: 10, length: 4000, loopLength: 1000, loopPhase: 200, forever: true })
    unloopClip(doc, c())
    expect(c()).toMatchObject({ sourceOffset: 210, length: 800, loopLength: 0, loopPhase: 0, forever: false })
    const m = midi(doc, { loopTicks: 960, lengthTicks: 3840, forever: true })
    unloopClip(doc, m())
    expect(m()).toMatchObject({ lengthTicks: 960, loopTicks: 0, forever: false })
  })
})

describe('trimClip', () => {
  it('trims an audio clip from the left, moving the source offset with it, and back out restores', () => {
    const { doc } = setup()
    const c = audio(doc, { start: 1000, length: 2000, sourceOffset: 0 })
    trimClip(doc, RATE, c(), 'l', 300, 10000, [])
    expect(c()).toMatchObject({ start: 1300, length: 1700, sourceOffset: 300 })
  })
  it('trims the right edge but not past the source', () => {
    const { doc } = setup()
    const c = audio(doc, { length: 2000 })
    trimClip(doc, RATE, c(), 'r', 500, 2200, [])
    expect(c().length).toBe(2200)
    trimClip(doc, RATE, c(), 'r', -5000, 2200, [])
    expect(c().length).toBe(50)
  })
  it('a stale pass goes when trimming a non-looping clip', () => {
    const { doc } = setup()
    const c = audio(doc, { length: 800, loopLength: 1000, loopPhase: 100 })
    trimClip(doc, RATE, c(), 'r', 100, 10000, [])
    expect(c()).toMatchObject({ loopLength: 0, loopPhase: 0, sourceOffset: 100 })
  })
  it('a midi left trim moves the start and shifts every note back by the same ticks', () => {
    const { doc } = setup()
    const c = midi(doc, { start: 5000 })
    const n = addNote(doc, { clipId: c().id, tick: 960, pitch: 60, durTicks: 480, velocity: 0.8 })
    const k = (c().bpm * c().ppq) / (60 * RATE)
    trimClip(doc, RATE, c(), 'l', 480 / k, 0, getNotes(doc))
    const after = getNotes(doc).find((x) => x.id === n)!
    expect(after.tick).toBe(960 - (c().start - 5000) * k)
    expect(c().start).toBeGreaterThan(5000)
  })
  it('a midi right trim snaps to sixteenths and clears a stale pass', () => {
    const { doc } = setup()
    const c = midi(doc, { loopTicks: 99999 })
    const k = (c().bpm * c().ppq) / (60 * RATE)
    trimClip(doc, RATE, c(), 'r', (960 + 50) / k, 0, [])
    expect(c()).toMatchObject({ lengthTicks: 3840 + 960, loopTicks: 0 })
  })
})

describe('device writes', () => {
  it('commitParam and commitParams close an undo step on both sides', () => {
    const { doc, undo, track } = setup()
    const d = addDevice(doc, track, SIMPLE_FILTER)
    undo.clear()
    commitParam(doc, undo, d, 0, 0.25)
    commitParams(doc, undo, d, { 0: 0.5, 1: 0.75 })
    expect(undo.undoStack.length).toBe(2)
    expect(getDevices(doc)[0].params).toMatchObject({ 0: 0.5, 1: 0.75 })
  })
  it('reorderDevice drops a card before another, or at the end', () => {
    const { doc, undo, track } = setup()
    const [a, b, c] = [1, 2, 3].map(() => addDevice(doc, track, SIMPLE_FILTER))
    const order = () => getDevices(doc).map((d) => d.id).filter((id) => [a, b, c].includes(id))
    expect(order()).toEqual([a, b, c])
    reorderDevice(doc, undo, c, a)
    expect(order()).toEqual([c, a, b])
    reorderDevice(doc, undo, c, null)
    expect(order()).toEqual([a, b, c])
    reorderDevice(doc, undo, a, 'nope')
    expect(order()).toEqual([a, b, c])
  })
})

describe('clip creation and deletion', () => {
  it('deleteClips removes several clips in one transaction', () => {
    const { doc } = setup()
    const a = audio(doc), b = audio(doc), keep = audio(doc)
    deleteClips(doc, [a().id, b().id])
    expect(getClips(doc).map((c) => c.id)).toEqual([keep().id])
  })
  it('addImportedClip makes a track named for the file when none is given, else reuses the track', () => {
    const { doc, track } = setup()
    const t = addImportedClip(doc, null, { name: 'kick.drum.wav', hash: 'x', length: 500 }, 100)
    expect(getTracks(doc).find((x) => x.id === t)?.name).toBe('kick.drum')
    expect(addImportedClip(doc, track, { name: 'b.wav', hash: 'y', length: 5 }, 700)).toBe(track)
    expect(getClips(doc).map((c) => [c.trackId, (c as AudioClip).start])).toEqual(expect.arrayContaining([[t, 100], [track, 700]]))
  })
})
