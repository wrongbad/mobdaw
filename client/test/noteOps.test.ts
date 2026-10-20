import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addMidiClip, addNote, getNotes, timeMap, undoScope, updateNote, type Region } from '@mobdaw/shared'
import {
  applyPatches, barsToTicks, centrePitch, clampVelocity, gmDrum, gridTicks, hitOpacity, inMarquee, moveGroup, nextVelocity, nudgeVelocity, quantize,
  localSnap, resizeGroup, shift, snapGlobal, snapStep, snapTick, subPx, ticksToBars, transpose, velocityAt,
} from '../src/ui/noteOps'

const n = (id: string, tick: number, pitch = 60, durTicks = 480, velocity = 0.8) => ({ id, clipId: 'c', tick, pitch, durTicks, velocity })
const PPQ = 960

describe('grid maths', () => {
  it('turns grid sizes into ticks of the clip ppq, a bar being 4 beats', () => {
    expect(gridTicks(0.25, PPQ)).toBe(240)
    expect(gridTicks(1, 480)).toBe(480)
    expect(gridTicks('bar', PPQ)).toBe(3840)
    expect(gridTicks(1 / 3, PPQ)).toBe(320)
    expect(gridTicks(0, PPQ)).toBe(0)
  })
  it('snaps, and not while alt or ctrl is held', () => {
    expect(snapTick(119, 240)).toBe(0)
    expect(snapTick(121, 240)).toBe(240)
    expect(snapTick(121.4, 0)).toBe(121)
    expect(snapStep(240, { altKey: false, ctrlKey: false })).toBe(240)
    expect(snapStep(240, { altKey: true, ctrlKey: false })).toBe(0)
    expect(snapStep(240, { altKey: false, ctrlKey: true })).toBe(0)
  })
  it('draws sub-beat lines only with room for them', () => {
    expect(subPx(240, PPQ, 48)).toBe(12)
    expect(subPx(240, PPQ, 16)).toBe(0) // 4px apart: too tight
    expect(subPx(PPQ, PPQ, 400)).toBe(0) // the grid is the beat: beat lines already
    expect(subPx(0, PPQ, 400)).toBe(0)
  })
})

describe('quantize', () => {
  it('moves starts to the nearest line and keeps lengths', () => {
    expect(quantize([n('a', 250), n('b', 470, 60, 100), n('c', 480)], 240)).toEqual([{ id: 'a', tick: 240 }, { id: 'b', tick: 480 }])
  })
  it('goes part of the way with a strength, and can fix lengths', () => {
    expect(quantize([n('a', 300)], 240, 0.5)).toEqual([{ id: 'a', tick: 270 }])
    expect(quantize([n('a', 240, 60, 100)], 240, 1, true)).toEqual([{ id: 'a', durTicks: 240 }])
  })
  it('does nothing with the grid off', () => expect(quantize([n('a', 3)], 0)).toEqual([]))
})

describe('transpose, shift and group moves', () => {
  it('transposes, refusing the whole move at the range ends', () => {
    expect(transpose([n('a', 0, 60), n('b', 0, 64)], 12)).toEqual([{ id: 'a', pitch: 72 }, { id: 'b', pitch: 76 }])
    expect(transpose([n('a', 0, 60), n('b', 0, 108)], 1)).toBeNull()
  })
  it('shifts a group and stops it together at tick 0', () => {
    expect(shift([n('a', 100), n('b', 500)], -240)).toEqual([{ id: 'a', tick: 0 }, { id: 'b', tick: 400 }])
    expect(shift([n('a', 0)], -240)).toEqual([])
  })
  it('moves a group clamped as a whole', () => {
    expect(moveGroup([n('a', 100, 60), n('b', 300, 107)], -500, 5)).toEqual([{ id: 'a', tick: 0, pitch: 61 }, { id: 'b', tick: 200, pitch: 108 }])
  })
  it('resizes a group with a floor', () => {
    expect(resizeGroup([n('a', 0, 60, 480), n('b', 0, 60, 100)], -200, 60)).toEqual([{ id: 'a', durTicks: 280 }, { id: 'b', durTicks: 60 }])
  })
})

describe('velocity and drums', () => {
  it('maps lane height to velocity', () => {
    expect(velocityAt(0, 40)).toBe(1)
    expect(velocityAt(20, 40)).toBeCloseTo(0.5)
    expect(velocityAt(40, 40)).toBe(clampVelocity(0))
  })
  it('edits a group relatively, clamped', () => {
    expect(nudgeVelocity([n('a', 0, 60, 1, 0.5), n('b', 0, 60, 1, 0.9)], 0.3).map((p) => p.velocity)).toEqual([0.8, 1])
  })
  it('cycles alt-click velocity and keeps quiet hits visible', () => {
    expect([1, 0.75, 0.5, 0.25].map(nextVelocity)).toEqual([0.75, 0.5, 0.25, 1])
    expect(hitOpacity(0.05)).toBeGreaterThan(0.35)
    expect(hitOpacity(1)).toBe(1)
  })
  it('names GM drums', () => {
    expect(gmDrum(36)).toBe('bass drum')
    expect(gmDrum(38)).toBe('acoustic snare')
    expect(gmDrum(10)).toBeUndefined()
  })
})

describe('marquee and centring', () => {
  it('finds overlapping notes in either corner order', () => {
    const list = [n('a', 0, 60, 100), n('b', 500, 64), n('c', 500, 80)]
    expect(inMarquee(list, 600, 50, 66, 58).map((x) => x.id)).toEqual(['a', 'b'])
  })
  it('centres on the notes, c4 when empty', () => {
    expect(centrePitch([])).toBe(60)
    expect(centrePitch([{ pitch: 40 }, { pitch: 50 }])).toBe(45)
  })
})

describe('a group edit is one undo step', () => {
  it('undoes a multi-note quantize in one go', () => {
    const doc = new Y.Doc()
    const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
    const clip = addMidiClip(doc, { trackId: 't', startTick: 0 })
    undo.stopCapturing()
    for (const t of [10, 250, 490]) addNote(doc, { clipId: clip, tick: t, durTicks: 100, pitch: 60, velocity: 1 })
    undo.stopCapturing()
    applyPatches(doc, undo, quantize(getNotes(doc), 240))
    expect(getNotes(doc).map((x) => x.tick).sort((a, b) => a - b)).toEqual([0, 240, 480])
    undo.undo()
    expect(getNotes(doc).map((x) => x.tick).sort((a, b) => a - b)).toEqual([10, 250, 490])
  })
})

describe('the project grid', () => {
  // bar 1-2: 4/4 at 120; bar 3-4: 7/8 (2+2+3); bar 5: a free bar of 2 s; then 4/4 again
  const regions: Region[] = [
    { id: 'a', bar: 1, kind: 'metered', bpm: 120, num: 4, den: 4 },
    { id: 'b', bar: 3, kind: 'metered', bpm: 120, num: 7, den: 8, groups: [2, 2, 3] },
    { id: 'c', bar: 5, kind: 'free', length: 96000 },
  ]
  const map = timeMap(regions, 48000, PPQ)
  const bar3 = 2 * 3840
  it('snaps to the beat grid counted from each bar line, 7/8 bars being 3.5 quarters', () => {
    expect(snapGlobal(map, bar3 + 3300, 1)).toBe(bar3 + 3360) // beats of the bar: 0, 960, 1920, 2880, then the bar line at 3360
    expect(snapGlobal(map, bar3 + 3000, 1)).toBe(bar3 + 2880)
    expect(snapGlobal(map, bar3 + 3000, 'bar')).toBe(bar3 + 3360)
    expect(snapGlobal(map, bar3 + 3350, 0.25)).toBe(bar3 + 3360)
    expect(snapGlobal(map, bar3 + 3200, 1, 'floor')).toBe(bar3 + 2880)
    expect(snapGlobal(map, 100, 0)).toBeNull()
  })
  it('has no grid in a free region', () => {
    const free = bar3 + 3360 * 2 + 1000
    expect(map.position(free).free).toBe(true)
    expect(snapGlobal(map, free, 0.25)).toBeNull()
    expect(localSnap(map, free - 10, 0.25)(3.4)).toBe(3)
  })
  it('snaps clip-local ticks through the clip start', () => {
    const snap = localSnap(map, bar3, 0.25) // a clip starting on bar 3
    expect(snap(250)).toBe(240)
    expect(snap(3340)).toBe(3360)
    expect(localSnap(map, bar3 + 100, 0.25)(250)).toBe(140) // a clip off the grid: notes land on global lines
  })
  it('counts patterns in bars of the map', () => {
    expect(barsToTicks(map, 0, 2)).toBe(7680)
    expect(barsToTicks(map, 0, 3)).toBe(7680 + 3360)
    expect(ticksToBars(map, 0, 7680 + 3360)).toBeCloseTo(3, 6)
    expect(ticksToBars(map, bar3, 3360 * 2)).toBeCloseTo(2, 6)
  })
  it('quantizes to a snapper function', () => {
    const snap = localSnap(map, bar3, 1)
    expect(quantize([n('a', 2800), n('b', 960)], snap, 1, false, 240)).toEqual([{ id: 'a', tick: 2880 }])
    expect(quantize([n('a', 0, 60, 1300)], snap, 1, true, 240)).toEqual([{ id: 'a', durTicks: 960 }])
  })
})
