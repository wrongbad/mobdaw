import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addTrack, getClips, getLanes, getPoints, getTracks, undoScope, type AudioClip } from '@mobdaw/shared'
import { LoopPedal, commitLoop, cycleGrid, joinUndo, nextBoundary, toggleMute, volumeAt, type LoopIO, type LoopTake } from '../src/audio/loopPedal'

const RATE = 1000 // 1 sample = 1 ms
const LATENCY = 40
const TAIL = 50 // TAIL_S at this rate

/** A pedal over a doc with `n` audio tracks, a fake IO and a fake clock: the test says where on the timeline each thing happens. */
function rig(n = 2) {
  const doc = new Y.Doc()
  const ids = Array.from({ length: n }, (_, i) => addTrack(doc, `t${i + 1}`, 'audio'))
  const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
  const log: string[] = []
  const done: LoopTake[] = []
  const io = { on: true, canBegin: true }
  const lives: LoopTake[] = []
  const fake: LoopIO = {
    playing: () => io.on,
    play: () => ((io.on = true), void log.push('play')),
    beginTake: (t) => (log.push(`begin ${t}`), io.canBegin),
    liveLoop: (t) => void lives.push(t),
    endTake: (t) => void done.push(t),
    cancelTake: () => void log.push('cancel'),
    say: (m) => void log.push(`say ${m}`),
  }
  const p = new LoopPedal({ doc, rate: RATE, io: fake, undo, latency: () => LATENCY })
  /** A whole loop: record at `a`, stop at `b`, the take started `lag` after the first press; saved after the stop. */
  const loop = (a: number, b: number, lag = 20) => {
    p.press('record', a)
    p.tookAt(a + lag)
    p.press('record', b)
    const end = done.length
    p.tick(b + 100000) // (long after: the take has everything)
    expect(done.length).toBe(end + 1)
    const t = done[end]
    undo.stopCapturing()
    joinUndo(undo, t.undoDepth)
    commitLoop(doc, t, t.trackId, `hash${end}`)
    undo.stopCapturing()
    return t
  }
  const clips = () => getClips(doc).filter((c): c is AudioClip => c.kind === 'audio').sort((a, b) => a.start - b.start)
  return { doc, ids, undo, p, io, log, done, lives, loop, clips }
}

describe('nextBoundary', () => {
  it('is the first boundary at or after the time, and the origin before it', () => {
    const g = { origin: 5000, period: 3200 }
    expect(nextBoundary(100, g)).toBe(5000)
    expect(nextBoundary(5000, g)).toBe(5000)
    expect(nextBoundary(5001, g)).toBe(8200)
    expect(nextBoundary(30000, g)).toBe(30600)
  })
})

describe('loop record', () => {
  it('the first loop is free length, press to press, and anchors the cycle at its timeline start', () => {
    const r = rig()
    r.p.current = r.ids[0]
    const t = r.loop(5000, 8200)
    expect(t).toMatchObject({ trackId: r.ids[0], start: 5000, pass: 3200 })
    const [c] = r.clips()
    expect(c).toMatchObject({ trackId: r.ids[0], start: 5000, loopLength: 3200, forever: true })
    expect(c.sourceOffset).toBe(5000 - 5020 + LATENCY) // the pass starts where the performer played timeline 5000: recstart and latency shift it
    expect(cycleGrid(r.doc)).toEqual({ origin: 5000, period: 3200 })
  })

  it('a loop on track 2 starting at 30 s is placed there, snapped to the cycle (whole multiples, in phase)', () => {
    const r = rig()
    r.p.current = r.ids[0]
    r.loop(5000, 8200)
    r.p.press('next', 0)
    expect(r.p.current).toBe(r.ids[1])
    const t = r.loop(30000, 40000)
    expect(t.start).toBe(30600) // the next boundary after the press: 5000 + 8 * 3200
    expect(t.pass).toBe(9600) // the next boundary after the stop press (40200) less the start: three cycles
    const c = r.clips().find((x) => x.trackId === r.ids[1])!
    expect(c).toMatchObject({ start: 30600, loopLength: 9600, forever: true })
    expect((c.start - 5000) % 3200).toBe(0)
    expect(r.clips()).toHaveLength(2)
  })

  it('overwrite ends the earlier clip exactly at the new start and keeps its history; one undo step undoes both', () => {
    const r = rig(1)
    r.p.current = r.ids[0]
    r.loop(5000, 8200)
    r.loop(12000, 20000) // starts at 14600: 5000 + 3 * 3200
    const [old, fresh] = r.clips()
    expect(old).toMatchObject({ start: 5000, length: 9600, loopLength: 3200 }) // ends where the new one starts
    expect(old.forever).toBeFalsy()
    expect(fresh).toMatchObject({ start: 14600, forever: true })
    r.undo.undo()
    const after = r.clips()
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ start: 5000, forever: true })
    expect(after[0].length).toBe(6400) // as the first loop made it
  })

  it('a loop pressed at the very boundary starts there; a stop press at the start takes a whole cycle', () => {
    const r = rig(1)
    r.p.current = r.ids[0]
    r.loop(5000, 8200)
    r.p.press('record', 14600)
    r.p.tookAt(14610)
    r.p.press('record', 14600)
    r.p.tick(1e6)
    expect(r.done.at(-1)).toMatchObject({ start: 14600, pass: 3200 })
  })

  it('stopped transport: the first press starts it; a too-short first loop is dropped', () => {
    const r = rig()
    r.io.on = false
    r.p.current = r.ids[0]
    r.p.press('record', 700)
    expect(r.log).toEqual([`begin ${r.ids[0]}`, 'play'])
    r.p.tookAt(710)
    r.p.press('record', 800)
    expect(r.log.at(-1)).toBe('say loop: too short')
    expect(r.p.recording).toBe(false)
    expect(r.clips()).toHaveLength(0)
  })

  it('a recording that cannot begin changes nothing', () => {
    const r = rig(1)
    r.p.current = r.ids[0]
    r.loop(5000, 8200)
    r.io.canBegin = false
    r.p.press('record', 9000)
    expect(r.p.recording).toBe(false)
    expect(r.clips()[0].forever).toBe(true) // the earlier loop was not touched
  })

  it('the live loop is announced at the stop press, the take ends once it has the last frame (latency late)', () => {
    const r = rig()
    r.p.current = r.ids[0]
    r.p.press('record', 5000)
    r.p.tookAt(5020)
    r.p.press('record', 8200)
    expect(r.lives).toHaveLength(1)
    expect(r.lives[0]).toMatchObject({ start: 5000, pass: 3200, recstart: 5020, latency: LATENCY })
    r.p.tick(8200 + LATENCY + TAIL - 1)
    expect(r.done).toHaveLength(0)
    r.p.tick(8200 + LATENCY + TAIL)
    expect(r.done).toHaveLength(1)
    expect(r.p.recording).toBe(false)
  })
})

describe('tracks', () => {
  it('next past the last track creates one and makes it current; prev stops at the first', () => {
    const r = rig(2)
    r.p.press('next', 0)
    expect(r.p.current).toBe(r.ids[0])
    r.p.press('next', 0)
    expect(r.p.current).toBe(r.ids[1])
    r.p.press('next', 0)
    expect(getTracks(r.doc)).toHaveLength(3)
    expect(r.p.current).toBe(getTracks(r.doc)[2].id)
    r.undo.undo() // track creation is undoable like any edit
    expect(getTracks(r.doc)).toHaveLength(2)
    r.p.current = r.ids[1]
    r.p.press('prev', 0)
    r.p.press('prev', 0)
    r.p.press('prev', 0)
    expect(r.p.current).toBe(r.ids[0])
  })
})

describe('mute', () => {
  it('writes volume automation: a step to 0 at the press and back to the prior volume at the unmute', () => {
    const r = rig(1)
    r.p.current = r.ids[0]
    r.p.press('mute', 1234)
    const lane = getLanes(r.doc)[0]
    expect(lane.param).toBe('0')
    expect(getPoints(r.doc).map((p) => [p.pos, p.value, p.curve]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[0, 0.5, 'hold'], [1234, 0.5, 'linear'], [1239, 0, 'hold']]) // seeded at unity (0.5 of 0..2), then a 5 ms ramp
    r.p.press('mute', 4321)
    expect(volumeAt(r.doc, r.ids[0], 1233)).toBe(1)
    expect(volumeAt(r.doc, r.ids[0], 1234)).toBe(1)
    expect(volumeAt(r.doc, r.ids[0], 1236.5)).toBeCloseTo(0.5, 6) // mid-ramp
    expect(volumeAt(r.doc, r.ids[0], 1239)).toBe(0)
    expect(volumeAt(r.doc, r.ids[0], 4320)).toBe(0)
    expect(volumeAt(r.doc, r.ids[0], 4321)).toBe(0)
    expect(volumeAt(r.doc, r.ids[0], 4326)).toBe(1)
  })

  it('many toggles at fractional loop offsets replay exactly, each one undo step', () => {
    const r = rig(1)
    r.p.current = r.ids[0]
    const times = [1234, 2000, 2345, 7777, 7901, 12345]
    times.forEach((t, i) => (r.p.press('mute', t), expect(r.undo.undoStack.length).toBe(i + 1)))
    times.forEach((t, i) => {
      const muted = i % 2 === 0
      expect(volumeAt(r.doc, r.ids[0], t - 1)).toBe(muted ? 1 : 0)
      expect(volumeAt(r.doc, r.ids[0], t + 5)).toBe(muted ? 0 : 1)
    })
    r.undo.undo()
    expect(volumeAt(r.doc, r.ids[0], 12350)).toBe(0) // the last unmute is gone
  })

  it('restores the volume the track had, and only overrides after the press', () => {
    const r = rig(1)
    r.p.current = r.ids[0]
    toggleMute(r.doc, r.ids[0], 500, RATE) // (lane seeded at unity)
    toggleMute(r.doc, r.ids[0], 600, RATE)
    toggleMute(r.doc, r.ids[0], 900, RATE)
    expect([100, 550, 650, 950].map((t) => volumeAt(r.doc, r.ids[0], t))).toEqual([1, 0, 1, 0])
  })

  it('with the transport stopped it is the track\'s plain mute', () => {
    const r = rig(1)
    r.io.on = false
    r.p.current = r.ids[0]
    r.p.press('mute', 0)
    expect(getTracks(r.doc)[0].muted).toBe(true)
    expect(getLanes(r.doc)).toHaveLength(0)
    r.p.press('mute', 0)
    expect(getTracks(r.doc)[0].muted).toBe(false)
  })
})

describe('replay', () => {
  it('playing from 0 reproduces the performance: a fresh doc made from the saved one has the same clips and automation', () => {
    const r = rig(2)
    r.p.current = r.ids[0]
    r.loop(5000, 8200)
    r.p.press('mute', 9100)
    r.p.press('mute', 11111)
    r.loop(12000, 20000)
    r.p.press('next', 0)
    r.loop(30000, 40000)
    r.p.press('mute', 41234)
    const copy = new Y.Doc()
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(r.doc))
    const layout = (d: Y.Doc) => ({
      clips: getClips(d).map((c) => (c.kind === 'audio' ? [c.trackId, c.start, c.length, c.loopLength, !!c.forever, c.sourceOffset] : [])).sort(),
      auto: getPoints(d).map((p) => [p.pos, p.value, p.curve]).sort(),
    })
    expect(layout(copy)).toEqual(layout(r.doc))
    // what is heard at a time: the first loop's old part still plays at 9000 (before the 14600 overwrite), the mute holds in between
    const [first, second, third] = r.clips()
    expect(first).toMatchObject({ start: 5000, length: 9600, forever: false })
    expect(second).toMatchObject({ start: 14600, forever: true })
    expect(third).toMatchObject({ start: 30600, forever: true })
    expect([9000, 9105, 11110, 11116].map((t) => volumeAt(copy, r.ids[0], t))).toEqual([1, 0, 0, 1])
    expect(volumeAt(copy, r.ids[1], 41240)).toBe(0)
  })
})
