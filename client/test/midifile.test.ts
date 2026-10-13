import {
  FINNWAVE, LOFI_DRUM, addMidiClip, addNote, addTrack, getClips, getDevices, getNotes, getTempo, getTracks, metaMap, samplesPerBar, type MidiClip,
} from '@mobdaw/shared'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  beatsPerBarOf, clipToSong, importSmf, isMidiFile, parseSmf, planImport, playedNotes, presetFor, projectToSong, writeSmf, type SmfSong,
} from '../src/content/midifile'

const RATE = 48000
function blank(bpm = 120) {
  const doc = new Y.Doc()
  metaMap(doc).set('sampleRate', RATE)
  metaMap(doc).set('bpm', bpm)
  return doc
}

/** A hand-built format-0 file: header, one track, running status and velocity-0 note-offs. */
function format0(): Uint8Array {
  const trk = [
    0x00, 0xff, 0x03, 0x04, ...[...'Solo'].map((c) => c.charCodeAt(0)),
    0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20, // 500000 us = 120 bpm
    0x00, 0xff, 0x58, 0x04, 0x03, 0x02, 0x18, 0x08, // 3/4
    0x00, 0xf0, 0x03, 0x7e, 0x09, 0xf7, // a sysex, ignored
    0x00, 0xc0, 0x21, // program 33 (finger bass)
    0x00, 0x90, 0x3c, 0x64, // C4 on, vel 100
    0x00, 0x40, 0x50, // running status: E4 on, vel 80
    0x83, 0x60, 0x3c, 0x00, // +480: C4 off (vel 0)
    0x00, 0x40, 0x00, // E4 off
    0x00, 0xb0, 0x07, 0x64, // a controller, ignored
    0x00, 0x99, 0x24, 0x7f, // channel 10 kick on
    0x81, 0x70, 0x89, 0x24, 0x40, // +240: kick off (0x89)
    0x00, 0xff, 0x2f, 0x00,
  ]
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0] // format 0, 1 track, 480 ppq
  return new Uint8Array([...head, 0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, trk.length, ...trk])
}

describe('reading', () => {
  it('reads a format-0 file with running status and velocity-0 note-offs, split per channel', () => {
    const f = parseSmf(format0())
    expect(f.format).toBe(0)
    expect(f.ppq).toBe(480)
    expect(f.tempos).toEqual([{ tick: 0, bpm: 120 }])
    expect(f.meters).toEqual([{ tick: 0, num: 3, den: 4 }])
    expect(f.parts.map((p) => [p.name, p.channel, p.program])).toEqual([['Solo 1', 0, 33], ['Solo 10', 9, null]])
    expect(f.parts[0].notes).toEqual([
      { tick: 0, dur: 480, pitch: 60, velocity: 100, channel: 0 },
      { tick: 0, dur: 480, pitch: 64, velocity: 80, channel: 0 },
    ])
    expect(f.parts[1].notes).toEqual([{ tick: 480, dur: 240, pitch: 36, velocity: 127, channel: 9 }])
  })
  it('refuses what is not a MIDI file', () => {
    expect(() => parseSmf(new TextEncoder().encode('RIFF....WAVE'))).toThrow()
    expect(() => parseSmf(new Uint8Array([0x4d, 0x54]))).toThrow()
  })
  it('knows MIDI files by name or type', () => {
    expect(isMidiFile({ name: 'a.MID', type: '' })).toBe(true)
    expect(isMidiFile({ name: 'x', type: 'audio/midi' })).toBe(true)
    expect(isMidiFile({ name: 'a.wav', type: 'audio/wav' })).toBe(false)
  })
})

describe('writing and reading back', () => {
  it('keeps notes, durations, velocities, tempo and meter', () => {
    const song: SmfSong = {
      ppq: 960, bpm: 93.5, beatsPerBar: 3, name: 'song',
      tracks: [
        { name: 'piano', channel: 0, notes: [{ tick: 0, dur: 960, pitch: 60, velocity: 100 }, { tick: 0, dur: 480, pitch: 64, velocity: 1 }, { tick: 960, dur: 960, pitch: 60, velocity: 127 }] },
        { name: 'drums', channel: 9, notes: [{ tick: 200000, dur: 120, pitch: 36, velocity: 90 }] },
      ],
    }
    const f = parseSmf(writeSmf(song))
    expect(f.format).toBe(1)
    expect(f.ppq).toBe(960)
    expect(f.title).toBe('song')
    expect(f.tempos[0].bpm).toBeCloseTo(93.5, 3)
    expect(f.meters[0]).toEqual({ tick: 0, num: 3, den: 4 })
    expect(f.parts.map((p) => [p.name, p.channel])).toEqual([['piano', 0], ['drums', 9]])
    for (let i = 0; i < 2; i++) {
      expect(f.parts[i].notes.map(({ channel: _c, ...n }) => n)).toEqual([...song.tracks[i].notes].sort((a, b) => a.tick - b.tick || a.pitch - b.pitch))
    }
  })
  it('a note re-struck where the last one ends stays two notes', () => {
    const f = parseSmf(writeSmf({ ppq: 96, bpm: 120, beatsPerBar: 4, tracks: [{ name: 'x', channel: 0, notes: [{ tick: 0, dur: 96, pitch: 60, velocity: 64 }, { tick: 96, dur: 96, pitch: 60, velocity: 64 }] }] }))
    expect(f.parts[0].notes.map((n) => [n.tick, n.dur])).toEqual([[0, 96], [96, 96]])
  })
})

describe('clips to files', () => {
  it('writes a looping pattern out to the clip end', () => {
    const notes = playedNotes({ lengthTicks: 4 * 960, loopTicks: 960 }, [{ tick: 0, durTicks: 2000, pitch: 36, velocity: 1 }, { tick: 1000, durTicks: 10, pitch: 1, velocity: 1 }])
    expect(notes.map((n) => [n.tick, n.durTicks])).toEqual([[0, 960], [960, 960], [1920, 960], [2880, 960]])
  })
  it('exports a clip and the project (click track and audio left out)', () => {
    const doc = blank(100)
    const piano = addTrack(doc, 'piano', 'midi')
    const click = addTrack(doc, 'click', 'midi', undefined, 'click')
    addTrack(doc, 'vox', 'audio')
    const c1 = addMidiClip(doc, { trackId: piano, start: 0, bpm: 100, ppq: 480, lengthTicks: 1920, name: 'intro' })
    addNote(doc, { clipId: c1, tick: 0, durTicks: 480, pitch: 60, velocity: 0.5 })
    const c2 = addMidiClip(doc, { trackId: piano, start: Math.round(samplesPerBar(getTempo(doc), RATE)), bpm: 100, ppq: 960, lengthTicks: 3840 })
    addNote(doc, { clipId: c2, tick: 960, durTicks: 960, pitch: 67, velocity: 1 })
    const ck = addMidiClip(doc, { trackId: click, start: 0, bpm: 100, ppq: 960, lengthTicks: 3840 })
    addNote(doc, { clipId: ck, tick: 0, durTicks: 100, pitch: 76, velocity: 1 })

    const clip = parseSmf(writeSmf(clipToSong(doc, c1)!))
    expect(clip.ppq).toBe(480)
    expect(clip.title).toBe('intro')
    expect(clip.parts[0].notes).toEqual([{ tick: 0, dur: 480, pitch: 60, velocity: 64, channel: 0 }])

    const all = parseSmf(writeSmf(projectToSong(doc, 'p')))
    expect(all.ppq).toBe(960)
    expect(all.tempos[0].bpm).toBeCloseTo(100, 3)
    expect(all.parts.map((p) => p.name)).toEqual(['piano'])
    expect(all.parts[0].notes.map((n) => [n.tick, n.dur, n.pitch])).toEqual([[0, 960, 60], [4 * 960 + 960, 960, 67]])
  })
})

describe('files to clips', () => {
  it('keeps bars and beats across resolutions and rounds clip lengths up to whole bars', () => {
    const parts = planImport(parseSmf(format0()), { ppq: 960, beatsPerBar: 3 })
    expect(parts[0]).toMatchObject({ name: 'Solo 1', drums: false, preset: 'finger-bass', lengthTicks: 3 * 960 })
    expect(parts[0].notes[0]).toEqual({ tick: 0, durTicks: 960, pitch: 60, velocity: 0.787 })
    expect(parts[1]).toMatchObject({ drums: true, preset: null })
    expect(parts[1].notes[0]).toMatchObject({ tick: 960, durTicks: 480, pitch: 36 })
  })
  it('chooses presets and meters', () => {
    expect(presetFor('Bass', null)).toBe('round-bass')
    expect(presetFor('Track 3', 48)).toBe('strings')
    expect(presetFor('Track 3', null)).toBeNull()
    expect(beatsPerBarOf({ num: 6, den: 8 })).toBe(3)
    expect(beatsPerBarOf({ num: 7, den: 4 })).toBe(7)
  })
  it('makes a track per part on an empty project, adopting the file tempo and meter', () => {
    const doc = blank(120)
    const f = parseSmf(writeSmf({
      ppq: 480, bpm: 90, beatsPerBar: 3, tracks: [
        { name: 'Strings', channel: 0, notes: [{ tick: 480, dur: 480, pitch: 60, velocity: 127 }] },
        { name: 'Drums', channel: 9, notes: [{ tick: 0, dur: 60, pitch: 49, velocity: 100 }] },
      ],
    }))
    const r = importSmf(doc, f, { at: 1000, base: 'song' })
    expect(r.adopted).toBe(true)
    expect(getTempo(doc)).toEqual({ bpm: 90, beatsPerBar: 3 })
    expect(getTracks(doc).map((t) => t.name)).toEqual(['Strings', 'Drums'])
    expect(r.tracks).toHaveLength(2)
    const devs = getDevices(doc)
    expect(devs.filter((d) => d.trackId === r.tracks[0]).map((d) => [d.type, d.name])).toEqual([[FINNWAVE, 'String section']])
    expect(devs.filter((d) => d.trackId === r.tracks[1]).every((d) => d.type === LOFI_DRUM)).toBe(true)
    const clips = getClips(doc) as MidiClip[]
    expect(clips.map((c) => [c.start, c.bpm, c.ppq, c.lengthTicks, c.view ?? null])).toEqual([[0, 90, 960, 2880, null], [0, 90, 960, 2880, 'drums']])
    const notes = getNotes(doc)
    expect(notes.find((n) => n.clipId === clips[0].id)).toMatchObject({ tick: 960, durTicks: 960, pitch: 60, velocity: 1 })
    expect(notes.find((n) => n.clipId === clips[1].id)?.pitch).toBe(46) // a crash onto the open hat
  })
  it('drops onto a MIDI track as one clip at the nearest bar, keeping the project tempo', () => {
    const doc = blank(120)
    const keys = addTrack(doc, 'keys', 'midi')
    addMidiClip(doc, { trackId: keys, start: 0, bpm: 120, ppq: 960, lengthTicks: 3840 })
    const f = parseSmf(writeSmf({ ppq: 960, bpm: 70, beatsPerBar: 4, tracks: [
      { name: 'a', channel: 0, notes: [{ tick: 0, dur: 960, pitch: 60, velocity: 64 }] },
      { name: 'b', channel: 1, notes: [{ tick: 4 * 960, dur: 960, pitch: 48, velocity: 64 }] },
    ] }))
    const bar = samplesPerBar(getTempo(doc), RATE)
    const r = importSmf(doc, f, { at: 1.6 * bar, trackId: keys, base: 'riff' })
    expect(r).toMatchObject({ adopted: false, into: keys, tracks: [] })
    expect(getTempo(doc).bpm).toBe(120)
    const c = getClips(doc).find((x) => x.id === r.clips[0]) as MidiClip
    expect([c.trackId, c.start, c.lengthTicks, c.name]).toEqual([keys, 2 * bar, 8 * 960, 'riff'])
    expect(getNotes(doc).filter((n) => n.clipId === c.id).map((n) => [n.tick, n.pitch])).toEqual([[0, 60], [3840, 48]])
  })
})
