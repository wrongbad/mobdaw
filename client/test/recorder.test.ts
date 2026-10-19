import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addAudioClip, addRegion, addTrack, getClips, getTracks, tracksMap, undoScope, type AudioClip } from '@mobdaw/shared'
import { createRecorder } from '../src/project/recorder'
import type { Playback } from '../src/audio/playback'

/** A recorder over a real doc, with a fake engine / microphone / journal that log what they were asked to do. */
function rig(opts: { micFails?: boolean } = {}) {
  const doc = new Y.Doc()
  addRegion(doc, { bar: 1, kind: 'free', length: 1e9 }) // one big free region: loops follow the cycle, not bar lines
  const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
  const log: string[] = []
  const said: string[] = []
  const local: Record<string, unknown>[] = []
  const state = { pos: 0, playing: false, armed: false, recording: false, changes: 0, halts: 0 }
  const stopped = Promise.resolve({ startPos: 0 } as never)
  const recorder = {
    get armed() { return state.armed },
    get recording() { return state.recording },
    info: { channels: 1, deviceId: 'd', label: 'mic' },
    async arm() { if (opts.micFails) throw new Error('no mic'); state.armed = true; log.push('arm') },
    disarm() { state.armed = false; log.push('disarm') },
    start() { state.recording = true; log.push('start') },
    stop() { state.recording = false; log.push('rec stop'); return stopped },
    latency: () => 0,
  }
  const pb = {
    recorder,
    get playing() { return state.playing },
    play(from?: number) { state.playing = true; log.push(`play ${from}`) },
    stop() { state.playing = false },
    monitor: (id: string | null) => void log.push(`monitor ${id}`),
    liveSource: () => 7,
    dropLiveSource: (h: number) => void log.push(`drop ${h}`),
    removeLiveClip: () => {},
    liveClip: () => 3,
    bindLiveSource: () => {},
    heard: (t: number) => t,
  } as unknown as Playback
  const journals: { discarded: boolean; released: boolean }[] = []
  const finished: unknown[] = []
  const r = createRecorder({
    s: { projectId: 'p', userId: null, user: { username: 'me', color: '#fff' }, setLocal: (patch) => void local.push(patch), snapshot: false },
    doc, undo, rate: () => 1000, pb: () => pb, position: () => state.pos,
    say: (m, bad) => void said.push(bad ? `!${m}` : m),
    onChange: () => void state.changes++,
    startTransport: (from) => { if (!state.playing) pb.play(from) },
    stop: () => r.stop(() => { pb.stop(); state.halts++ }),
    loopStatus: () => {},
    journal: (() => {
      const j = { discarded: false, released: false, chunk() {}, header() {}, release() { j.released = true }, discard() { j.discarded = true }, settled: async () => {} }
      journals.push(j)
      return j
    }) as never,
    finish: (async (_c: unknown, cap: unknown) => void finished.push(cap)) as never,
  })
  return { doc, undo, r, pb, log, said, local, state, journals, finished }
}

describe('arming', () => {
  it('arms a track (asking for the microphone once) and disarms it again', async () => {
    const x = rig()
    const t = addTrack(x.doc, 'a', 'audio')
    await x.r.arm(t)
    expect(x.r.armedTrack).toBe(t)
    expect(x.state.armed).toBe(true)
    await x.r.arm(t)
    expect(x.r.armedTrack).toBe(null)
    expect(x.log).toEqual(['arm', 'disarm'])
  })
  it('reports a microphone failure and arms nothing', async () => {
    const x = rig({ micFails: true })
    const t = addTrack(x.doc, 'a', 'audio')
    await x.r.arm(t)
    expect(x.r.armedTrack).toBe(null)
    expect(x.said).toEqual(['!record: no mic'])
  })
  it('sync drops a deleted armed track, and monitors the armed one only when asked', async () => {
    const x = rig()
    const t = addTrack(x.doc, 'a', 'audio')
    await x.r.arm(t)
    x.r.toggleMonitoring()
    x.r.sync(new Set([t]))
    expect(x.log.at(-1)).toBe(`monitor ${t}`)
    x.r.toggleMonitoring()
    x.r.sync(new Set([t]))
    expect(x.log.at(-1)).toBe('monitor null')
    x.r.sync(new Set())
    expect(x.r.armedTrack).toBe(null)
    expect(x.log).toContain('disarm')
  })
})

describe('takes', () => {
  it('● on an empty project makes a track, records into it, and stopping saves the take', async () => {
    const x = rig()
    x.state.pos = 2500
    await x.r.toggleRecord()
    expect(getTracks(x.doc)).toHaveLength(1)
    expect(x.r.take).toMatchObject({ trackId: getTracks(x.doc)[0].id, start: 2500 })
    expect(x.local.at(-1)).toEqual({ recording: { trackId: getTracks(x.doc)[0].id, start: 2500 } })
    expect(x.log).toContain('play 2500')
    await x.r.toggleRecord() // again: stops
    expect(x.r.take).toBe(null)
    expect(x.state.halts).toBe(1)
    expect(x.local.at(-1)).toEqual({ playhead: null, recording: null })
    await new Promise((r) => setTimeout(r, 0))
    expect(x.finished).toHaveLength(1)
    expect(x.journals[0]).toMatchObject({ discarded: true, released: true })
  })
  it('records into the armed track, and ● while a take runs does not arm again', async () => {
    const x = rig()
    const t = addTrack(x.doc, 'a', 'audio')
    await x.r.arm(t)
    await x.r.toggleRecord()
    expect(getTracks(x.doc)).toHaveLength(1)
    expect(x.r.take?.trackId).toBe(t)
    await x.r.arm(t) // arming is ignored mid-take
    expect(x.r.armedTrack).toBe(t)
  })
  it('a microphone that will not open leaves nothing behind', async () => {
    const x = rig({ micFails: true })
    await x.r.toggleRecord()
    expect(x.r.take).toBe(null)
    expect(getTracks(x.doc)).toHaveLength(0)
    expect(x.said).toEqual(['!record: no mic'])
  })
  it('destroy lets go of a running take', async () => {
    const x = rig()
    await x.r.toggleRecord()
    x.r.destroy()
    expect(x.journals[0].released).toBe(true)
    expect(x.local.at(-1)).toEqual({ recording: null })
  })
})

describe('loop commands', () => {
  it('a loop recording cancelled before it begins gives the earlier loop back and leaves the undo history alone', async () => {
    const x = rig()
    const t = addTrack(x.doc, 'a', 'audio')
    x.state.playing = true
    // an earlier loop, as a finished loop take leaves it
    const id = addAudioClip(x.doc, { trackId: t, sourceHash: 'h', start: 1000, length: 12800, loopLength: 3200, forever: true })
    x.undo.stopCapturing()
    await x.r.arm(t)
    const depth = x.undo.undoStack.length
    await x.r.command('record', 5000) // starts at the next boundary, 1000 + 2 * 3200 = 7400: cuts the earlier loop there
    expect(x.r.loops?.recording).toBe(true)
    const clip = () => getClips(x.doc).find((c) => c.id === id) as AudioClip
    expect(clip()).toMatchObject({ length: 6400, forever: false }) // cut where the new one starts
    await x.r.command('record', 6000) // stopped before it began
    expect(x.r.loops?.recording).toBe(false)
    expect(x.r.take).toBe(null)
    expect(clip()).toMatchObject({ length: 12800, forever: true })
    expect(x.undo.undoStack.length).toBe(depth)
    expect(tracksMap(x.doc).has(t)).toBe(true)
    x.r.destroy()
  })
  it('a loop command with no microphone asks for it once', async () => {
    const x = rig()
    addTrack(x.doc, 'a', 'audio')
    await x.r.command('record', 100)
    expect(x.log.filter((l) => l === 'arm')).toHaveLength(1)
    expect(x.r.loops?.recording).toBe(true)
    expect(x.r.take).not.toBe(null)
    x.r.destroy()
  })
})
