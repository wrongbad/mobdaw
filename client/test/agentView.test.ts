import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  REVERB, addDevice, addMarker, addMidiClip, addNote, addRegion, addTrack, agentText, agentView, formatDuration, formatPosition, getTimeMap, parseDuration,
  parsePosition, setKey, setParam, updateTrack, DEVICES, FINNWAVE,
} from '@mobdaw/shared'

function fixture() {
  const doc = new Y.Doc()
  const bass = addTrack(doc, 'Bass', 'midi')
  addDevice(doc, bass, FINNWAVE, { name: 'sub' })
  const clip = addMidiClip(doc, { trackId: bass, startTick: 3840, lengthTicks: 7680, loopTicks: 3840 })
  addNote(doc, { clipId: clip, tick: 960, durTicks: 480, pitch: 61, velocity: 1 })
  addNote(doc, { clipId: clip, tick: 0, durTicks: 240, pitch: 36, velocity: 50 / 127 })
  const fx = addDevice(doc, bass, REVERB)
  setParam(doc, fx, 0, 0.45)
  updateTrack(doc, bass, { muted: true })
  addRegion(doc, { bar: 3, kind: 'metered', bpm: 90, num: 7, den: 8 })
  addMarker(doc, { bar: 2, label: 'Verse' })
  setKey(doc, 'D minor')
  return { doc, bass, clip, fx }
}

describe('agentView', () => {
  it('describes tracks, devices by param name, clips, notes, regions and markers', () => {
    const { doc, bass, clip, fx } = fixture()
    const v = agentView(doc, 7)
    expect(v.rev).toBe(7)
    expect(v.meta).toEqual({ ppq: 960, sampleRate: 48000, key: 'D minor' })
    expect(v.regions.map((r) => r.kind === 'metered' && [r.bar, r.bpm, r.meter, r.beatTicks])).toEqual([[1, 120, '4/4', 960], [3, 90, '7/8', 480]])
    expect(v.markers).toEqual([{ id: expect.any(String), bar: 2, label: 'Verse' }])
    const t = v.tracks[0]
    expect(t).toMatchObject({ id: bass, name: 'Bass', kind: 'midi', muted: true, soloed: false })
    expect(t.devices.map((d) => d.type)).toEqual(['finnwave', 'reverb', 'mix'])
    expect(t.devices.find((d) => d.id === fx)!.params).toMatchObject({ mix: 0.45, size: 0.5 })
    expect(t.devices[0]).toMatchObject({ name: 'sub', params: expect.objectContaining({ rolloff: 0.3 }) })
    const c = t.clips[0]
    expect(c).toMatchObject({ id: clip, kind: 'midi', start: '2.1.0', startTick: 3840, lengthTicks: 7680, length: '2 bars 1 beat', loopTicks: 3840, end: '4.2.0' })
    if (c.kind !== 'midi') throw new Error()
    expect(c.notes).toEqual([
      { id: expect.any(String), p: 'C2', pitch: 36, t: 0, d: 240, v: 50 },
      { id: expect.any(String), p: 'C#4', pitch: 61, t: 960, d: 480, v: 127 },
    ])
    expect(v.master.devices).toEqual([])
  })

  it('has a text outline carrying the same facts', () => {
    const { doc } = fixture()
    const text = agentText(doc, 3)
    expect(text).toContain('project: ppq 960, 48000 Hz, key D minor, rev 3')
    expect(text).toContain('bar 3: 90 bpm 7/8')
    expect(text).toContain('markers: bar 2 "Verse"')
    expect(text).toContain('track "Bass"')
    expect(text).toContain('muted')
    expect(text).toContain('reverb')
    expect(text).toContain('mix=0.45')
    expect(text).toContain('2.1.0 to 4.2.0 (2 bars 1 beat, 7680 ticks), loop 3840 ticks')
    expect(text).toContain('C2 0+240 v50')
    expect(text).toContain('C#4 960+480 v127')
    expect(text.split('\n').length).toBeLessThan(40)
  })

  it('lists every device type with its param names', () => {
    expect(Object.keys(DEVICES).length).toBeGreaterThan(5)
  })
})

describe('positions', () => {
  const doc = fixture().doc
  const map = getTimeMap(doc)
  it('round trips bar.beat.tick, also in 7/8', () => {
    for (const p of ['1.1.0', '2.3.240', '3.1.0', '3.7.0', '3.5.120', '5.2.0']) expect(formatPosition(map, parsePosition(map, p))).toBe(p)
    expect(parsePosition(map, '2')).toBe(3840)
    expect(parsePosition(map, '3.2')).toBe(map.barStart(3) + 480)
    expect(parsePosition(map, 100)).toBe(100)
  })
  it('rejects what is not a position', () => {
    for (const p of ['0.1', '1.5', '3.8', 'x', '1.2.3.4.5', -1, null]) expect(() => parsePosition(map, p), String(p)).toThrow()
  })
  it('reads lengths in units and ticks', () => {
    expect(parseDuration(map, 0, '2 bars')).toBe(7680)
    expect(parseDuration(map, 0, '1 bar 2 beats')).toBe(3840 + 1920)
    expect(parseDuration(map, 0, '3 beats')).toBe(2880)
    expect(parseDuration(map, 0, '240 ticks')).toBe(240)
    expect(parseDuration(map, map.barStart(3), '2 beats')).toBe(960) // 7/8: a beat is an eighth
    expect(parseDuration(map, 0, 100)).toBe(100)
    expect(() => parseDuration(map, 0, 'soon')).toThrow()
    expect(() => parseDuration(map, 0, '2 bars of cake')).toThrow()
    expect(formatDuration(map, 0, 5760)).toBe('1 bar 2 beats')
    expect(formatDuration(map, 0, 100)).toBe('100 ticks')
  })
})
