import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  addAudioClip, addMidiClip, addTrack, clipsMap, ensureTimeline, getMarkers, getRegions, notesMap, addNote, getNotes, timeMap, undoScope, type Moving, type AudioClip, type MidiClip, type Region,
} from '@mobdaw/shared'
import { BAR_PX, BEAT_PX, HALF_PX, divisionAt, gridSnap, gridSnapTick, pxPerBeatAt, snapDivision, softGrid } from '../src/ui/gridSnap'
import { labelStep, meterLabel, nearestBar, regionLabel, rulerBadges, rulerGrid, rulerMarkers, fmtFree } from '../src/ui/rulerModel'
import { offGrid } from '../src/ui/ghost'
import { commitMoving } from '../src/project/draft'
import { loopMidi, moveMidi, moveTick, passMidi, trimLeft, trimMidi } from '../src/ui/midiClipOps'
import { parseBpm, parseFreeSeconds, parseGroups, parseMeter, parseTempoForm, rampOption, setFreeHere, setTempoHere, toggleRamp } from '../src/ui/rulerEdit'

const RATE = 48000
const PPQ = 960
const m = (id: string, bar: number, bpm: number, num = 4, den = 4, extra: Partial<Extract<Region, { kind: 'metered' }>> = {}): Region => ({ id, bar, kind: 'metered', bpm, num, den, ...extra })
// 120 bpm 4/4 (a beat is 24000 samples, a bar 2 s), then 7/8 at 90 from bar 3, then a free 2 s bar at bar 5
const map = timeMap([m('a', 1, 120), m('b', 3, 90, 7, 8), { id: 'f', bar: 5, kind: 'free', length: 2 * RATE }], RATE, PPQ)

describe('snapDivision', () => {
  it('goes from bars to beats to half beats to quarter beats as the beats widen', () => {
    expect(snapDivision(BAR_PX - 1)).toBe('bar')
    expect(snapDivision(BAR_PX)).toBe('beat')
    expect(snapDivision(BEAT_PX - 1)).toBe('beat')
    expect(snapDivision(BEAT_PX)).toBe(2)
    expect(snapDivision(HALF_PX - 1)).toBe(2)
    expect(snapDivision(HALF_PX)).toBe(4)
    expect(snapDivision(NaN)).toBe('bar')
  })
})

describe('grid snapping on the map', () => {
  it('measures a beat in pixels from the tempo (a quarter at 120 bpm is half a second)', () => {
    expect(pxPerBeatAt(map, 1000, 80)).toBeCloseTo(40)
    expect(pxPerBeatAt(map, 4 * RATE + 5 * RATE, 80)).toBe(Infinity) // inside the free region
  })
  it('snaps to the nearest line of the zoom, and not at all in a free region', () => {
    // 80 px/s: 40 px a beat -> half beats (12000 samples)
    expect(gridSnap(map, 11000, 80)).toBe(12000)
    expect(gridSnap(map, 100, 20)).toBe(0) // 10 px a beat: beats
    expect(gridSnap(map, 20000, 20)).toBe(24000)
    expect(gridSnap(map, 9 * RATE, 20)).toBeNull() // free
    expect(divisionAt(map, 9 * RATE, 20)).toBeNull()
  })
  it('zoomed far out snaps to whole bars', () => {
    expect(gridSnap(map, 1.4 * RATE, 3)).toBe(2 * RATE)
  })
  it('follows the meter: bars of 7/8 snap on the eighth-note beats', () => {
    const bar3 = map.barStartSample(3)
    const beat = (map.barStartSample(4) - bar3) / 7
    expect(gridSnap(map, bar3 + beat * 2.2, 40)).toBeCloseTo(bar3 + beat * 2, -1)
  })
  it('ticks too', () => {
    expect(gridSnapTick(map, 1000, 20)).toBe(PPQ) // beats at this zoom
    expect(gridSnapTick(map, 700, 80)).toBe(PPQ / 2) // half beats
    expect(gridSnapTick(map, map.sampleToTick(9 * RATE), 80)).toBeNull() // free region
  })
  it('soft-snaps whichever edge is within reach, with the shift and the line', () => {
    const near = softGrid(map, [100, 30000], 20, 300)
    expect(near).toEqual({ shift: -100, at: 0 })
    expect(softGrid(map, [12000], 20, 300)).toBeNull() // halfway between beats at this zoom
    expect(softGrid(map, [9 * RATE], 20, 1e9)).toBeNull() // free region: no grid
  })
})

describe('moving MIDI clips on the grid', () => {
  const midi = (o: Partial<MidiClip> = {}): MidiClip => ({ id: 'c', trackId: 't', kind: 'midi', startTick: 2 * PPQ, lengthTicks: 4 * PPQ, ...o })
  it('a start snaps to the grid of the zoom unless snapping is off, never before bar 1', () => {
    expect(moveTick(map, 25000, 20)).toBe(PPQ) // a beat at 24000
    expect(moveTick(map, 25000, 20, false)).toBeCloseTo(map.sampleToTick(25000))
    expect(moveTick(map, -9000, 20)).toBe(0)
  })
  it('a start in a free region is not rounded (no grid there)', () => {
    const s = 9 * RATE + 123
    expect(moveTick(map, s, 20)).toBeCloseTo(map.sampleToTick(s))
  })
  it('the left edge keeps the end where it is and reports how far the notes move back', () => {
    const t = trimLeft(map, midi(), 24000 * 3, 20) // start at 3 beats
    expect(t).toEqual({ startTick: 3 * PPQ, lengthTicks: 3 * PPQ, d: PPQ })
    expect(trimLeft(map, midi(), 1e9, 20).lengthTicks).toBe(PPQ / 4) // keeps a 1/16 note
    expect(trimLeft(map, midi(), -1e6, 20).startTick).toBe(0)
  })
  it('writes ticks: move, trim (notes follow), loop and pass', () => {
    const doc = new Y.Doc()
    ensureTimeline(doc)
    const trackId = addTrack(doc, 't', 'midi')
    const id = addMidiClip(doc, { trackId, startTick: 2 * PPQ, lengthTicks: 4 * PPQ })
    const nid = addNote(doc, { clipId: id, pitch: 60, tick: PPQ * 2, durTicks: 100, velocity: 100 })
    const c = () => clipsMap(doc).get(id)!.toJSON() as MidiClip
    const doc0 = timeMap([], RATE, PPQ)
    const undo = new Y.UndoManager(undoScope(doc))
    const w = (m: Moving) => commitMoving(doc, undo, m)
    w(moveMidi(doc0, c(), 48000, 20, true))
    expect(c().startTick).toBe(2 * PPQ) // 1 s = 2 beats
    w(trimMidi(doc0, c(), 'l', 24000 * 3, 20, true, [{ id: nid, tick: PPQ * 2 }]))
    expect(c()).toMatchObject({ startTick: 3 * PPQ, lengthTicks: 3 * PPQ })
    expect(notesMap(doc).get(nid)!.get('tick')).toBe(PPQ) // the music stayed put
    w(trimMidi(doc0, c(), 'r', 24000 * 8, 20, true, []))
    expect(c().lengthTicks).toBe(5 * PPQ)
    w(loopMidi(doc0, c(), 24000 * 12, 20, true))
    expect(c()).toMatchObject({ lengthTicks: 9 * PPQ, loopTicks: 5 * PPQ })
    w(passMidi(doc0, c(), 24000 * 6, 20, true))
    expect(c().loopTicks).toBe(3 * PPQ)
    expect(getNotes(doc)).toHaveLength(1)
  })
})

describe('ruler labels', () => {
  const metered = (r: Region) => r as Extract<Region, { kind: 'metered' }>
  it('writes tempo and meter, the groups only when they are not the default', () => {
    expect(meterLabel(metered(m('x', 1, 92, 7, 8)))).toBe('7/8')
    expect(meterLabel(metered(m('x', 1, 92, 7, 8, { groups: [2, 2, 3] })))).toBe('7/8 2+2+3')
    expect(meterLabel(metered(m('x', 1, 92, 6, 8, { groups: [3, 3] })), [3, 3])).toBe('6/8')
    expect(regionLabel(m('x', 7, 92, 7, 8), RATE)).toBe('♩=92 7/8')
    expect(regionLabel(m('x', 7, 92.5, 4, 4, { rampTo: 70 }), RATE)).toBe('♩=92.5→70 4/4')
    expect(regionLabel({ id: 'f', bar: 5, kind: 'free', length: 3.5 * RATE }, RATE)).toBe('free 3.5s')
    expect(fmtFree(65 * RATE, RATE)).toBe('1:05')
  })
  it('thins the bar numbers by the narrowest bar on screen', () => {
    expect(labelStep(100)).toBe(1)
    expect(labelStep(30)).toBe(2)
    expect(labelStep(9)).toBe(8)
  })
  it('draws bar lines, group starts and beats of a window, thinned by zoom', () => {
    const g = rulerGrid(map, 0, 4 * RATE, 80) // 2 bars of 4/4: 160 px a bar, 40 px a beat
    expect(g.lines.filter((l) => l.kind === 'bar').map((l) => l.label)).toEqual(['1', '2'])
    expect(g.lines.filter((l) => l.kind === 'beat')).toHaveLength(6)
    const far = rulerGrid(map, 0, 4 * RATE, 4) // 8 px a bar: no beats
    expect(far.lines.every((l) => l.kind === 'bar')).toBe(true)
    expect(far.lines.map((l) => l.label)).toEqual(['1', undefined].slice(0, far.lines.length))
  })
  it('marks the group starts of 7/8 grouped 2+2+3', () => {
    const mm = timeMap([m('a', 1, 120, 7, 8, { groups: [2, 2, 3] })], RATE, PPQ)
    const g = rulerGrid(mm, 0, 2 * RATE, 200)
    expect(g.lines.slice(0, 7).map((l) => l.kind)).toEqual(['bar', 'beat', 'group', 'beat', 'group', 'beat', 'beat'])
  })
  it('puts seconds in a free region, not beats', () => {
    const g = rulerGrid(map, map.barStartSample(5) - 1, map.barStartSample(5) + 3 * RATE, 80)
    expect(g.free).toHaveLength(1)
    expect(g.free[0].ticks.map((t) => t.label)).toEqual(['1s'])
    expect(g.lines.filter((l) => l.free)).toHaveLength(1) // just the bar line
  })
  it('has a badge per region, with a ramp as a slope to the next, and the markers at their bars', () => {
    const rm = timeMap([m('a', 1, 120, 4, 4, { rampTo: 60 }), m('b', 3, 60)], RATE, PPQ)
    const b = rulerBadges(rm)
    expect(b.map((x) => x.label)).toEqual(['♩=120→60 4/4', '♩=60 4/4'])
    expect(b[0].ramp).toMatchObject({ bpm0: 120, bpm1: 60, toSample: rm.barStartSample(3) })
    expect(b[1].ramp).toBeUndefined()
    expect(rulerMarkers(rm, [{ id: 'k', bar: 3, label: 'A', text: 'verse' }])).toEqual([{ id: 'k', bar: 3, sample: rm.barStartSample(3), label: 'A', title: 'A: verse' }])
  })
  it('knows the bar a click means', () => {
    expect(nearestBar(map, 0)).toBe(1)
    expect(nearestBar(map, 1.2 * RATE)).toBe(2) // past the middle of bar 1
    expect(nearestBar(map, 0.5 * RATE)).toBe(1)
    expect(nearestBar(map, 9 * RATE)).toBe(5)
  })
})

describe('ghosting audio a tempo edit moved the bars away from', () => {
  const audio = (id: string, start: number): AudioClip => ({ id, trackId: 't', kind: 'audio', start, length: RATE, sourceHash: 'h', sourceOffset: 0, gain: 1, fadeIn: 0, fadeOut: 0, fadeShape: 0 })
  it('lists the clips that were on a beat line and are not now', () => {
    const before = timeMap([m('a', 1, 120)], RATE, PPQ)
    const after = timeMap([m('a', 1, 90)], RATE, PPQ)
    const clips = [audio('bar1', 0), audio('beat', 24000), audio('off', 24001 + 5000), audio('both', 24000 * 3)]
    // 90 bpm: a beat is 32000 samples. 0 stays on a line; 24000 and 72000 (3 beats) leave it; 72000 = 2.25 beats of 90 bpm
    expect(offGrid(before, after, clips)).toEqual(['beat', 'both'])
  })
  it('lists none when nothing changed, and ignores MIDI clips', () => {
    const t = timeMap([m('a', 1, 120)], RATE, PPQ)
    expect(offGrid(t, t, [audio('x', 24000)])).toEqual([])
    const mid: MidiClip = { id: 'm', trackId: 't', kind: 'midi', startTick: 960, lengthTicks: 960 }
    expect(offGrid(t, timeMap([m('a', 1, 60)], RATE, PPQ), [mid])).toEqual([])
  })
  it('a clip that falls into a free region has lost its line', () => {
    const before = timeMap([m('a', 1, 120)], RATE, PPQ)
    const after = timeMap([{ id: 'A', bar: 1, kind: 'free', length: 10 * RATE }], RATE, PPQ)
    expect(offGrid(before, after, [audio('x', 24000)])).toEqual(['x'])
  })
  it('works from a doc edit end to end', () => {
    const doc = new Y.Doc()
    ensureTimeline(doc)
    const trackId = addTrack(doc, 'a', 'audio')
    addAudioClip(doc, { trackId, sourceHash: 'h', start: 24000, length: RATE })
    const before = timeMap(getRegions(doc), RATE, PPQ)
    setTempoHere(doc, 1, { bpm: 100, num: 4, den: 4 })
    const after = timeMap(getRegions(doc), RATE, PPQ)
    expect(offGrid(before, after, [...clipsMap(doc).values()].map((c) => c.toJSON() as AudioClip))).toHaveLength(1)
  })
})

describe('ruler edit parsing', () => {
  it('tempo and meter', () => {
    expect(parseBpm('92')).toEqual({ ok: true, value: 92 })
    expect(parseBpm('')).toMatchObject({ ok: false })
    expect(parseBpm('5')).toMatchObject({ ok: false })
    expect(parseMeter(' 7 / 8 ')).toEqual({ ok: true, value: { num: 7, den: 8 } })
    expect(parseMeter('4/5')).toMatchObject({ ok: false })
    expect(parseMeter('x')).toMatchObject({ ok: false })
  })
  it('groups must add up to the beats', () => {
    expect(parseGroups('2+2+3', 7)).toEqual({ ok: true, value: [2, 2, 3] })
    expect(parseGroups('', 7)).toEqual({ ok: true, value: undefined })
    expect(parseGroups('2+2', 7)).toMatchObject({ ok: false })
    expect(parseGroups('a+b', 7)).toMatchObject({ ok: false })
    expect(parseTempoForm('100', '7/8', '3+2+2')).toEqual({ ok: true, value: { bpm: 100, num: 7, den: 8, groups: [3, 2, 2] } })
    expect(parseTempoForm('100', '7/8', '3+3')).toMatchObject({ ok: false })
  })
  it('free length in seconds becomes samples', () => {
    expect(parseFreeSeconds('2.5', RATE)).toEqual({ ok: true, value: 120000 })
    expect(parseFreeSeconds('0', RATE)).toMatchObject({ ok: false })
  })
})

describe('ruler edits are one undo step each', () => {
  const setup = () => {
    const doc = new Y.Doc()
    ensureTimeline(doc)
    const undo = new Y.UndoManager([doc.getMap('regions'), doc.getMap('markers')], { captureTimeout: 0 })
    return { doc, undo }
  }
  it('tempo / meter from a bar adds a region, again at the same bar changes it, keeping a ramp', () => {
    const { doc, undo } = setup()
    setTempoHere(doc, 9, { bpm: 90, num: 7, den: 8, groups: [2, 2, 3] })
    expect(getRegions(doc).map((r) => [r.bar, r.kind])).toEqual([[1, 'metered'], [9, 'metered']])
    undo.stopCapturing()
    toggleRamp(doc, 1)
    expect(getRegions(doc)[0]).toMatchObject({ rampTo: 90 })
    setTempoHere(doc, 1, { bpm: 130, num: 4, den: 4 })
    expect(getRegions(doc)[0]).toMatchObject({ bpm: 130, rampTo: 90 })
    undo.stopCapturing()
    undo.undo()
    expect(getRegions(doc)[0]).toMatchObject({ bpm: 120, rampTo: 90 })
  })
  it('a free region also carries on after it, in one step', () => {
    const { doc, undo } = setup()
    setFreeHere(doc, 3, 4 * RATE)
    expect(getRegions(doc).map((r) => r.bar)).toEqual([1, 3, 4])
    undo.undo()
    expect(getRegions(doc)).toHaveLength(1)
  })
  it('ramp to next needs a metered region with a different tempo after it', () => {
    const { doc } = setup()
    expect(rampOption(getRegions(doc), 1)).toMatchObject({ kind: 'none' })
    setTempoHere(doc, 5, { bpm: 120, num: 4, den: 4 })
    expect(rampOption(getRegions(doc), 1)).toMatchObject({ kind: 'none', reason: expect.stringContaining('same tempo') })
    setTempoHere(doc, 5, { bpm: 80, num: 4, den: 4 })
    expect(rampOption(getRegions(doc), 2)).toMatchObject({ kind: 'add', to: 80 })
    toggleRamp(doc, 3)
    expect(rampOption(getRegions(doc), 3)).toMatchObject({ kind: 'remove' })
    toggleRamp(doc, 3)
    expect(getRegions(doc)[0].kind === 'metered' && getRegions(doc)[0].rampTo).toBeFalsy()
  })
  it('the markers map is ready for the menu', () => {
    const { doc } = setup()
    expect(getMarkers(doc)).toEqual([])
  })
})
