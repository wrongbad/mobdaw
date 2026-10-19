import {
  FINNWAVE, LOFI_DRUM, MIX, addMidiClip, addNote, addRegion, addTrack, ensureTimeline, getClips, getDevices, getNotes, getRegions, getTimeMap, getTracks, metaMap, setRegion, type MidiClip,
} from '@mobdaw/shared'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  clipToSong, exportProjectMidi, importSmf, isMidiFile, mapEvents, parseSmf, planImport, playedNotes, presetFor, projectToSong, smfRegions, smfSeconds, writeSmf, type SmfSong,
} from '../src/content/midifile'

const RATE = 48000
function blank() {
  const doc = new Y.Doc()
  metaMap(doc).set('sampleRate', RATE)
  ensureTimeline(doc)
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
  it('exports a clip and the project (click track and audio left out), notes at the project ppq and tempo from the map', () => {
    const doc = blank()
    setRegion(doc, 'default', { bpm: 100 })
    const piano = addTrack(doc, 'piano', 'midi')
    const click = addTrack(doc, 'click', 'midi', undefined, 'click')
    addTrack(doc, 'vox', 'audio')
    const c1 = addMidiClip(doc, { trackId: piano, startTick: 0, lengthTicks: 1920 })
    addNote(doc, { clipId: c1, tick: 0, durTicks: 480, pitch: 60, velocity: 0.5 })
    const c2 = addMidiClip(doc, { trackId: piano, startTick: 4 * 960, lengthTicks: 3840 })
    addNote(doc, { clipId: c2, tick: 960, durTicks: 960, pitch: 67, velocity: 1 })
    const ck = addMidiClip(doc, { trackId: click, startTick: 0, lengthTicks: 3840 })
    addNote(doc, { clipId: ck, tick: 0, durTicks: 100, pitch: 76, velocity: 1 })

    const clip = parseSmf(writeSmf(clipToSong(doc, c1)!))
    expect(clip.ppq).toBe(960)
    expect(clip.title).toBe('piano')
    expect(clip.parts[0].notes).toEqual([{ tick: 0, dur: 480, pitch: 60, velocity: 64, channel: 0 }])
    expect(clip.tempos).toEqual([{ tick: 0, bpm: expect.closeTo(100, 3) }])

    const all = parseSmf(writeSmf(projectToSong(doc, 'p')))
    expect(all.ppq).toBe(960)
    expect(all.tempos[0].bpm).toBeCloseTo(100, 3)
    expect(all.meters).toEqual([{ tick: 0, num: 4, den: 4 }])
    expect(all.parts.map((p) => p.name)).toEqual(['piano'])
    expect(all.parts[0].notes.map((n) => [n.tick, n.dur, n.pitch])).toEqual([[0, 480, 60], [4 * 960 + 960, 960, 67]])
  })
  it('writes the map: a meter change, a tempo change and a ramp as a tempo event per beat', () => {
    const doc = blank()
    setRegion(doc, 'default', { bpm: 100, rampTo: 140 })
    addRegion(doc, { bar: 3, bpm: 140, num: 7, den: 8 })
    const t = addTrack(doc, 'lead', 'midi')
    const c = addMidiClip(doc, { trackId: t, startTick: 0, lengthTicks: 3 * 3840 })
    addNote(doc, { clipId: c, tick: 3 * 3840 - 480, durTicks: 480, pitch: 60, velocity: 1 })
    const f = parseSmf(exportProjectMidi(doc, 'ramp'))
    expect(f.meters).toEqual([{ tick: 0, num: 4, den: 4 }, { tick: 7680, num: 7, den: 8 }])
    expect(f.tempos.filter((x) => x.tick < 7680)).toHaveLength(8) // one per beat across the two ramped bars
    expect(f.tempos[0].bpm).toBeCloseTo(100, 2)
    expect(f.tempos[7].bpm).toBeCloseTo(100 + (40 * 7) / 8, 2)
    expect(f.tempos.at(-1)).toEqual({ tick: 7680, bpm: expect.closeTo(140, 2) })
  })
})

describe('files to clips', () => {
  it('keeps bars and beats across resolutions', () => {
    const parts = planImport(parseSmf(format0()), { ppq: 960 })
    expect(parts[0]).toMatchObject({ name: 'Solo 1', drums: false, preset: 'finger-bass', lengthTicks: 960 })
    expect(parts[0].notes[0]).toEqual({ tick: 0, durTicks: 960, pitch: 60, velocity: 0.787 })
    expect(parts[1]).toMatchObject({ drums: true, preset: null })
    expect(parts[1].notes[0]).toMatchObject({ tick: 960, durTicks: 480, pitch: 36 })
  })
  it('chooses presets', () => {
    expect(presetFor('Bass', null)).toBe('round-bass')
    expect(presetFor('Track 3', 48)).toBe('strings')
    expect(presetFor('Track 3', null)).toBe('soft-keys') // no name, no program: the first preset
    expect(presetFor('Track 3', 71)).toBe('clarinet')
    expect(presetFor('violin 1', 40)).toBe('fiddle') // the program beats the name
    expect(presetFor('cello', 42)).toBe('cello')
    expect(presetFor('Bass', 127)).toBe('round-bass') // a program no preset lists: the name decides
  })
  it('makes a track per part on an empty project, adopting the file tempo and meter', () => {
    const doc = blank()
    const f = parseSmf(writeSmf({
      ppq: 480, bpm: 90, beatsPerBar: 3, tracks: [
        { name: 'Strings', channel: 0, notes: [{ tick: 480, dur: 480, pitch: 60, velocity: 127 }] },
        { name: 'Drums', channel: 9, notes: [{ tick: 0, dur: 60, pitch: 49, velocity: 100 }] },
      ],
    }))
    const r = importSmf(doc, f, { at: 1000, base: 'song' })
    expect(r.adopted).toBe(true)
    expect(getTracks(doc).map((t) => t.name)).toEqual(['Strings', 'Drums'])
    expect(r.tracks).toHaveLength(2)
    const devs = getDevices(doc).filter((d) => d.type !== MIX)
    expect(devs.filter((d) => d.trackId === r.tracks[0]).map((d) => [d.type, d.name])).toEqual([[FINNWAVE, 'String section']])
    expect(devs.filter((d) => d.trackId === r.tracks[1]).every((d) => d.type === LOFI_DRUM)).toBe(true)
    const clips = getClips(doc) as MidiClip[]
    expect(clips.map((c) => [c.startTick, c.lengthTicks, c.view ?? null])).toEqual([[0, 2880, null], [0, 2880, 'drums']]) // whole 3/4 bars
    expect(getRegions(doc)).toMatchObject([{ bar: 1, kind: 'metered', bpm: 90, num: 3, den: 4 }])
    const notes = getNotes(doc)
    expect(notes.find((n) => n.clipId === clips[0].id)).toMatchObject({ tick: 960, durTicks: 960, pitch: 60, velocity: 1 })
    expect(notes.find((n) => n.clipId === clips[1].id)?.pitch).toBe(46) // a crash onto the open hat
  })
  it('drops onto a MIDI track as one clip at the nearest bar, keeping the project tempo', () => {
    const doc = blank()
    const keys = addTrack(doc, 'keys', 'midi')
    addMidiClip(doc, { trackId: keys, startTick: 0, lengthTicks: 3840 })
    const f = parseSmf(writeSmf({ ppq: 960, bpm: 70, beatsPerBar: 4, tracks: [
      { name: 'a', channel: 0, notes: [{ tick: 0, dur: 960, pitch: 60, velocity: 64 }] },
      { name: 'b', channel: 1, notes: [{ tick: 4 * 960, dur: 960, pitch: 48, velocity: 64 }] },
    ] }))
    const bar = (4 * 60 * RATE) / 120 // samples
    const r = importSmf(doc, f, { at: 1.6 * bar, trackId: keys, base: 'riff' })
    expect(r).toMatchObject({ adopted: false, into: keys, tracks: [] })
    const c = getClips(doc).find((x) => x.id === r.clips[0]) as MidiClip
    expect([c.trackId, c.startTick, c.lengthTicks]).toEqual([keys, 2 * 3840, 3 * 3840]) // (the file's 5 beats at 70 bpm take 8.6 beats at 120: three bars)
    expect(getRegions(doc)).toHaveLength(1) // the project's map is kept
    // the file runs at 70 bpm, the project at 120: the second note, 4 beats in at 70 bpm, is 4*60/70 s after the clip start
    const second = getNotes(doc).find((n) => n.clipId === c.id && n.pitch === 48)!
    expect(second.tick).toBeCloseTo((4 * 60 * 120 * 960) / (70 * 60), 1)
    expect(getNotes(doc).find((n) => n.clipId === c.id && n.pitch === 60)!.tick).toBe(0)
  })
})

/** A 480-ppq file: 2 bars of 6/8 at 90 bpm, then 4/4 at 140 bpm; one note on each bar's first beat. */
const tempoMeterFile = () => writeSmf({
  ppq: 480, bpm: 90, beatsPerBar: 3, name: 'swing',
  tempos: [{ tick: 0, bpm: 90 }, { tick: 2880, bpm: 140 }],
  meters: [{ tick: 0, num: 6, den: 8 }, { tick: 2880, num: 4, den: 4 }],
  tracks: [{ name: 'Lead', channel: 0, notes: [0, 1440, 2880, 2880 + 1920].map((tick) => ({ tick, dur: 240, pitch: 60, velocity: 100 })) }],
})

describe('importing tempo and meter changes', () => {
  it('reads the regions a file asks for', () => {
    const f = parseSmf(tempoMeterFile())
    expect(f.tempos).toHaveLength(2)
    expect(f.meters).toEqual([{ tick: 0, num: 6, den: 8 }, { tick: 2880, num: 4, den: 4 }])
    expect(smfRegions(f)).toEqual([{ bar: 1, bpm: 90, num: 6, den: 8 }, { bar: 3, bpm: 140, num: 4, den: 4 }])
    expect(smfSeconds(f)(2880)).toBeCloseTo(4, 4) // 6 quarters at 90 bpm (the tempo event is whole microseconds)
  })
  it('puts a tempo change in the middle of a bar on the nearest bar line, and merges equal neighbours', () => {
    const f = { ...parseSmf(tempoMeterFile()), meters: [], tempos: [{ tick: 0, bpm: 100 }, { tick: 1900, bpm: 100 }, { tick: 1920 * 2 + 100, bpm: 80 }] }
    expect(smfRegions(f)).toEqual([{ bar: 1, bpm: 100, num: 4, den: 4 }, { bar: 3, bpm: 80, num: 4, den: 4 }])
  })
  it('on a default project writes the tempo and 6/8 -> 4/4 changes into regions and the notes sound where they should', () => {
    const doc = blank()
    const r = importSmf(doc, parseSmf(tempoMeterFile()), { at: 123456, base: 'swing' })
    expect(r.adopted).toBe(true)
    expect(getRegions(doc)).toMatchObject([
      { bar: 1, kind: 'metered', bpm: 90, num: 6, den: 8 },
      { bar: 3, kind: 'metered', bpm: 140, num: 4, den: 4 },
    ])
    expect(getRegions(doc)[0].id).toBe('default') // the default region is edited in place
    const clip = getClips(doc).find((c) => c.id === r.clips[0]) as MidiClip
    expect(clip.startTick).toBe(0) // `at` is ignored: the file's bars are the project's
    const map = getTimeMap(doc)
    const at = getNotes(doc).filter((n) => n.clipId === clip.id).map((n) => map.tickToSampleExact(clip.startTick + n.tick)).sort((a, b) => a - b)
    const sec = (s: number) => s * RATE
    expect(at[0]).toBeCloseTo(0, 6)
    expect(at[1]).toBeCloseTo(sec(2), 3) // 3 quarters at 90 bpm
    expect(at[2]).toBeCloseTo(sec(4), 3)
    expect(at[3]).toBeCloseTo(sec(4 + (4 * 60) / 140), 3)
    expect(map.position(clip.startTick + clip.lengthTicks)).toMatchObject({ bar: 5, tickInBar: 0 }) // rounded up to whole bars
  })
  it('into a project that already has a map keeps it and places the notes by time', () => {
    const doc = blank()
    setRegion(doc, 'default', { bpm: 100 })
    addRegion(doc, { bar: 2, bpm: 100, num: 7, den: 8 })
    const keys = addTrack(doc, 'keys', 'midi')
    addMidiClip(doc, { trackId: keys, startTick: 0, lengthTicks: 3840 })
    const before = JSON.stringify(getRegions(doc))
    const map = getTimeMap(doc)
    const r = importSmf(doc, parseSmf(tempoMeterFile()), { at: map.barStartSample(2), base: 'swing' })
    expect(r.adopted).toBe(false)
    expect(JSON.stringify(getRegions(doc))).toBe(before)
    const clip = getClips(doc).find((c) => c.id === r.clips[0]) as MidiClip
    expect(clip.startTick).toBe(3840)
    const s0 = map.tickToSampleExact(3840)
    const at = getNotes(doc).filter((n) => n.clipId === clip.id).map((n) => map.tickToSampleExact(clip.startTick + n.tick) - s0).sort((a, b) => a - b)
    // the file's seconds: 0, 2, 4 and 4 + 4*60/140
    ;[0, 2, 4, 4 + 240 / 140].forEach((sec, i) => expect(at[i]).toBeCloseTo(sec * RATE, 0))
  })
})

describe('export round trip', () => {
  it('gives the same regions and note ticks back', () => {
    const src = blank()
    setRegion(src, 'default', { bpm: 96 })
    addRegion(src, { bar: 3, bpm: 96, num: 7, den: 8 })
    addRegion(src, { bar: 5, bpm: 132, num: 6, den: 8 })
    addRegion(src, { bar: 7, bpm: 132, num: 4, den: 4 })
    const t = addTrack(src, 'lead', 'midi')
    const c = addMidiClip(src, { trackId: t, startTick: 0, lengthTicks: 9 * 3840 })
    const ticks = [0, 480, 7680, 7680 + 1440, 2 * 7680 + 2 * 3360 + 480, 3840 * 6 + 3840, 3840 * 7 + 120]
    for (const tick of ticks) addNote(src, { clipId: c, tick, durTicks: 240, pitch: 62, velocity: 0.7 })
    const bytes = exportProjectMidi(src, 'song')

    const dst = blank()
    const r = importSmf(dst, parseSmf(bytes), { at: 0, base: 'song' })
    const strip = (doc: Y.Doc) => getRegions(doc).map(({ bar, kind, ...r }) => ({ bar, kind, ...('bpm' in r ? { bpm: r.bpm, num: r.num, den: r.den } : {}) }))
    expect(strip(dst)).toEqual(strip(src).map((x) => ({ ...x }))) // (no ramps in this song)
    const clip = getClips(dst).find((x) => x.id === r.clips[0]) as MidiClip
    expect(getNotes(dst).filter((n) => n.clipId === clip.id).map((n) => clip.startTick + n.tick).sort((a, b) => a - b)).toEqual(ticks)
    // and the same time map: every note starts on the same sample
    const a = getTimeMap(src), b = getTimeMap(dst)
    for (const tick of ticks) expect(b.tickToSample(tick)).toBeCloseTo(a.tickToSample(tick), 0)
  })
  it('maps events for a window of the timeline', () => {
    const doc = blank()
    addRegion(doc, { bar: 2, bpm: 90, num: 3, den: 4 })
    const ev = mapEvents(getTimeMap(doc), 3840 + 960, 3840 * 2)
    expect(ev.tempos).toEqual([{ tick: 0, bpm: 90 }])
    expect(ev.meters).toEqual([{ tick: 0, num: 3, den: 4 }])
  })
})
