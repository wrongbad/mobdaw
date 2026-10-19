import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addRegion, addTrack, getClips, getLanes, getPoints, getPpq, getRegions, getTracks, setRegion, timeMap, undoScope, type AudioClip, type Region } from '@mobdaw/shared'
import { LoopPedal, applyRegionEdits, commitLoop, tempoFromLoop, cycleGrid, joinUndo, nextBoundary, toggleMute, volumeAt, type LoopIO, type LoopTake } from '../src/audio/loopPedal'

const RATE = 1000 // 1 sample = 1 ms
const LATENCY = 40
const TAIL = 50 // TAIL_S at this rate

/** A pedal over a doc with `n` audio tracks, a fake IO and a fake clock: the test says where on the timeline each thing happens. */
function rig(n = 2, regions: ((doc: Y.Doc) => void) | null = (doc) => void addRegion(doc, { bar: 1, kind: 'free', length: 1e6 })) {
  const doc = new Y.Doc()
  regions?.(doc) // (default: one big free region, so the cycle rules below apply; metered tests pass their own)
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
  const p = new LoopPedal({ doc, rate: RATE, io: fake, undo, latency: () => LATENCY, map: () => timeMap(getRegions(doc), RATE, getPpq(doc)) })
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
  return { doc, ids, undo, p, io, log, done, lives, loop, clips, map: () => timeMap(getRegions(doc), RATE, getPpq(doc)) }
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

  describe('cancelled before it begins', () => {
    const cancelled = () => {
      const r = rig(1)
      r.p.current = r.ids[0]
      r.loop(5000, 8200)
      const before = r.clips()[0]
      r.p.press('record', 12000) // starts at 14600, cutting the earlier loop there
      expect(r.p.recording).toBe(true)
      return { r, before }
    }
    it('gives the earlier loop back and leaves no stale undo step', () => {
      const { r, before } = cancelled()
      const depth = r.undo.undoStack.length
      r.p.press('record', 13000) // stopped before it began
      expect(r.p.recording).toBe(false)
      expect(r.clips()).toEqual([before])
      expect(r.undo.undoStack.length).toBe(depth - 1) // the cut's step went with it
      expect(r.undo.redoStack.length).toBe(0)
    })
    it('does not undo another edit that landed in between', () => {
      const { r, before } = cancelled()
      r.undo.stopCapturing()
      const t = addTrack(r.doc, 'later', 'audio') // an unrelated edit after the press
      r.undo.stopCapturing()
      r.p.press('record', 13000)
      expect(r.clips()).toEqual([before])
      expect(getTracks(r.doc).some((x) => x.id === t)).toBe(true) // still there
      r.undo.undo() // the user's own undo takes back their edit, as it should
      expect(getTracks(r.doc).some((x) => x.id === t)).toBe(false)
      expect(r.clips()).toEqual([before])
    })
    it('brings back a loop that was replaced outright', () => {
      const r = rig(1)
      r.p.current = r.ids[0]
      r.loop(5000, 8200)
      const before = r.clips()[0]
      r.p.press('record', 5000) // the same start: replaces it
      expect(r.clips()).toHaveLength(0)
      r.p.press('record', 5000 - 10) // stopped before it began
      expect(r.clips()).toHaveLength(1)
      expect(r.clips()[0]).toMatchObject({ start: before.start, length: before.length, loopLength: before.loopLength, forever: true })
    })
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

const at100 = (doc: Y.Doc) => void addRegion(doc, { bar: 1, bpm: 100, num: 4, den: 4 }) // 600 samples a beat at this rate: 2400 a 4/4 bar

describe('loop record on the bar grid (metered region)', () => {
  it('start and stop snap to bar lines, and the clip reads the audio that was played at the start', () => {
    const r = rig(1, at100)
    r.p.current = r.ids[0]
    const t = r.loop(5000, 12100) // start: next bar line at/after 5000 is 7200 (bar 4); stop 12100 -> nearest line 12000
    expect(t).toMatchObject({ start: 7200, pass: 4800 })
    const [c] = r.clips()
    expect(c).toMatchObject({ start: 7200, loopLength: 4800, forever: true })
    expect(c.sourceOffset).toBe(7200 - 5020 + LATENCY) // the take began at 5020: the pass starts where the performer played 7200
  })

  it('a press exactly on a bar line starts there', () => {
    const r = rig(1, at100)
    r.p.current = r.ids[0]
    expect(r.loop(4800, 9700).start).toBe(4800)
  })

  it('the stop press goes to the nearest bar line: a hair late or a hair early gives the same length, a whole bar is the minimum', () => {
    const run = (stop: number) => {
      const r = rig(1, at100)
      r.p.current = r.ids[0]
      return r.loop(2400, stop).pass
    }
    expect(run(9610)).toBe(7200) // late press at 3 bars + 10 ms past the line
    expect(run(9590)).toBe(7200) // early
    expect(run(9700)).toBe(7200)
    expect(run(9700 + 1200)).toBe(9600) // past the midpoint: next line
    expect(run(2400 + 100)).toBe(2400) // pressed again straight away: one bar
    expect(run(2400 + 700)).toBe(2400) // still the first bar line
  })

  it('a stop before the start cancels like the free loop does', () => {
    const r = rig(1, at100)
    r.p.current = r.ids[0]
    r.p.press('record', 5000)
    r.p.press('record', 6000) // start is 7200
    expect(r.p.recording).toBe(false)
    expect(r.log.at(-1)).toBe('cancel')
  })

  it('the status counts down to the next bar line', () => {
    const r = rig(1, at100)
    r.p.current = r.ids[0]
    r.p.press('record', 5000)
    expect(r.p.status(5500)).toMatchObject({ samples: 1700, free: false }) // to the start at 7200
    expect(r.p.status(8000)).toMatchObject({ samples: 1600, free: false }) // next line 9600
  })

  it('a 7/8 region: bars are 2100 samples', () => {
    const r = rig(1, (d) => void addRegion(d, { bar: 1, bpm: 100, num: 7, den: 8, groups: [2, 2, 3] }))
    r.p.current = r.ids[0]
    const t = r.loop(1000, 6500) // start 2100; nearest line to 6500 is 6300
    expect(t).toMatchObject({ start: 2100, pass: 4200 })
  })

  it('across a tempo ramp the lines are where the map puts them, and the pass is their distance', () => {
    const r = rig(1, (d) => {
      addRegion(d, { bar: 1, bpm: 100, num: 4, den: 4, rampTo: 200 })
      addRegion(d, { bar: 5, bpm: 200, num: 4, den: 4 })
    })
    r.p.current = r.ids[0]
    const m = r.map()
    const b2 = m.barStartSample(2), b3 = m.barStartSample(3), b4 = m.barStartSample(4)
    expect(b3 - b2).toBeLessThan(b2) // (it speeds up: each bar is shorter than the one before)
    const t = r.loop(b2 - 5, b4 + 3)
    expect(t).toMatchObject({ start: b2, pass: b4 - b2 })
  })

  it('a loop starting in a metered region ignores earlier free loops as a cycle; a free press after a free loop keeps its cycle', () => {
    const r = rig(1, (d) => {
      addRegion(d, { bar: 1, kind: 'free', length: 20000 }) // bars 2+ metered at 120 bpm: 2000 samples a bar
    })
    r.p.current = r.ids[0]
    r.loop(5000, 8200) // free: 3200
    const t = r.loop(30000, 36300) // metered now (after 20 s): bar lines every 2000 from 20000
    expect(t).toMatchObject({ start: 30000, pass: 6000 })
    const t2 = r.loop(8300, 13000) // a press in the free region again: the cycle (5000 + k*3200), not bars
    expect(t2).toMatchObject({ start: 11400, pass: 3200 })
  })
})

describe('tempo from loop', () => {
  const freeMap = (len = 1e6) => {
    const d = new Y.Doc()
    addRegion(d, { bar: 1, kind: 'free', length: len })
    return { d, map: timeMap(getRegions(d), RATE, getPpq(d)) }
  }
  const lenOf = (rs: Region[], bar: number) => rs.find((x) => x.bar === bar)

  it('picks 1, 2, 4 or 8 bars for the tempo nearest the sensible range (70-160)', () => {
    const { map } = freeMap()
    const pick = (len: number) => tempoFromLoop(map, { start: 5000, length: len })!
    expect(pick(2000)).toMatchObject({ bars: 1, bpm: 120 }) // 2 s: one bar of 4/4 at 120
    expect(pick(8000)).toMatchObject({ bars: 4, bpm: 120 }) // 8 s: 2 bars would be 60 bpm (out of range)
    expect(pick(16000)).toMatchObject({ bars: 8, bpm: 120 })
    expect(pick(1000).bars).toBe(1) // 240 bpm: none fit, 1 bar is closest
    expect(pick(60000).bars).toBe(8) // 32 bpm at best
    expect(pick(3200).bars).toBe(2) // 75 bpm (1 bar) and 150 (2 bars) both fit; 150 is nearer 110 on a log scale
  })

  it('anchors the pass on a bar line: a free lead-in, then 4/4 at the exact tempo; the pass is N bars', () => {
    const { d, map } = freeMap()
    const plan = tempoFromLoop(map, { start: 5000, length: 8000 })!
    applyRegionEdits(d, plan.edits)
    const m = timeMap(getRegions(d), RATE, getPpq(d))
    expect(m.snapSample(5000, 'bar')).toBe(5000)
    expect(m.barStartSample(2)).toBe(5000)
    expect(Math.abs(m.barStartSample(2 + plan.bars) - 13000)).toBeLessThanOrEqual(1)
    expect(m.regionAtSample(100).kind).toBe('free')
    expect(lenOf(getRegions(d), 2)).toMatchObject({ kind: 'metered', num: 4, den: 4 })
  })

  it('a pass at the very start of the timeline just sets the first region', () => {
    const { d, map } = freeMap()
    const plan = tempoFromLoop(map, { start: 0, length: 4000 })!
    applyRegionEdits(d, plan.edits)
    const rs = getRegions(d)
    expect(rs.every((x) => x.kind === 'metered' && x.num === 4 && x.bpm === plan.bpm)).toBe(true) // (the filler after the free bar carries the tempo too)
    expect(timeMap(rs, RATE, getPpq(d)).barStartSample(1 + plan.bars)).toBe(4000)
  })

  it('does nothing for a pass in a metered region', () => {
    const d = new Y.Doc()
    expect(tempoFromLoop(timeMap(getRegions(d), RATE, getPpq(d)), { start: 100, length: 2000 })).toBeNull()
  })
})
