// Standard MIDI Files (.mid): a dependency-free reader and writer, and the mapping between them and mobdaw's MIDI clips.
//
// Reading: format 0, 1 (and 2, read like 1), running status, note on / off (a note-on at velocity 0 is a note-off),
// program changes, and the meta events tempo (FF 51), time signature (FF 58) and track name (FF 03). Everything else
// (sysex, controllers, pitch bend, other metas) is skipped. A track holding several channels is split per channel.
// SMPTE time division is read as if at 120 bpm.
// Writing: format 1. Track 0 is the conductor (song name, tempo, time signature); then one track per part.
//
// Importing keeps the music on its bars and beats: file ticks become clip ticks by the ratio of the resolutions
// (`ppq / file ppq`). The project plays at one tempo, so only the file's first tempo is used (adopted when the project
// has no clips yet); later tempo changes are dropped, which makes a file with tempo changes play at a steady tempo.
// Time signatures are read as quarter-note beats per bar (6/8 → 3, 12/8 → 6; odd eighths round).
import {
  DEFAULT_PPQ, FINNWAVE, addDevice, addMidiClip, addNote, addTrack, clampBpm, getClips, getDevices, getNotes, getSampleRate, getTempo, getTracks,
  patternTicks, samplesPerBar, setBeatsPerBar, setProjectTempo, tracksMap, type MidiClip, type Note,
} from '@mobdaw/shared'
import type * as Y from 'yjs'
import { isDrumTrack } from '../studio/arrange/kinds'
import { DRUM_KITS, GM, addDrumKit, addInstrument, instrumentPreset } from './presets'

/** A note in file ticks; velocity 1..127; channel 0..15 (9 is GM drums). */
export type SmfNote = { tick: number; dur: number; pitch: number; velocity: number; channel: number }
export type SmfPart = { name: string; channel: number; program: number | null; notes: SmfNote[] }
export type Smf = {
  format: number
  ppq: number
  /** Parts with notes, in file order (a multi-channel track gives one part per channel). */
  parts: SmfPart[]
  tempos: { tick: number; bpm: number }[]
  meters: { tick: number; num: number; den: number }[]
  /** Name of the first track when it holds no notes (format 1's conductor track: often the song's title). */
  title: string
}

export class SmfError extends Error {}

// ------------------------------------------------------------------------------------------------ reading

export function parseSmf(data: ArrayBuffer | Uint8Array): Smf {
  const b = data instanceof Uint8Array ? data : new Uint8Array(data)
  let p = 0
  const need = (n: number) => { if (p + n > b.length) throw new SmfError('the file ends too early') }
  const u32 = () => (need(4), ((b[p++] << 24) | (b[p++] << 16) | (b[p++] << 8) | b[p++]) >>> 0)
  const u16 = () => (need(2), (b[p++] << 8) | b[p++])
  const tag = () => (need(4), String.fromCharCode(b[p++], b[p++], b[p++], b[p++]))

  // RIFF-wrapped MIDI (.rmi): skip to the MThd chunk
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF') {
    const at = indexOf(b, [0x4d, 0x54, 0x68, 0x64])
    if (at < 0) throw new SmfError('not a MIDI file')
    p = at
  }
  if (tag() !== 'MThd') throw new SmfError('not a MIDI file')
  const hlen = u32()
  const format = u16(), ntracks = u16(), division = u16()
  p += Math.max(0, hlen - 6)
  let ppq = division
  if (division & 0x8000) { // SMPTE: frames per second × ticks per frame = ticks per second, read as 120 bpm
    const fps = 256 - (division >> 8)
    ppq = Math.max(1, Math.round((fps === 29 ? 29.97 : fps) * (division & 0xff) / 2))
  }
  if (!ppq) throw new SmfError('the file has no time division')

  const parts: SmfPart[] = []
  const tempos: Smf['tempos'] = []
  const meters: Smf['meters'] = []
  let title = ''
  for (let t = 0; t < ntracks && p + 8 <= b.length; t++) {
    const id = tag()
    const len = u32()
    const end = Math.min(b.length, p + len)
    if (id !== 'MTrk') { p = end; t--; continue } // (an unknown chunk: not a track)
    const r = readTrack(b, p, end, tempos, meters)
    p = end
    if (!r.notes.length) { if (t === 0 && r.name) title = r.name; continue }
    const channels = [...new Set(r.notes.map((n) => n.channel))]
    for (const ch of channels) {
      parts.push({
        name: channels.length > 1 ? `${r.name || 'channel'} ${ch + 1}`.trim() : r.name,
        channel: ch,
        program: r.programs.get(ch) ?? null,
        notes: r.notes.filter((n) => n.channel === ch),
      })
    }
  }
  tempos.sort((x, y) => x.tick - y.tick)
  meters.sort((x, y) => x.tick - y.tick)
  return { format, ppq, parts, tempos, meters, title }
}

function indexOf(b: Uint8Array, pat: number[]) {
  outer: for (let i = 0; i + pat.length <= b.length; i++) {
    for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer
    return i
  }
  return -1
}

function readTrack(b: Uint8Array, start: number, end: number, tempos: Smf['tempos'], meters: Smf['meters']) {
  let p = start, tick = 0, status = 0
  let name = ''
  const notes: SmfNote[] = []
  const programs = new Map<number, number>()
  const open = new Map<number, { tick: number; velocity: number }[]>() // channel << 7 | pitch -> sounding notes (oldest first)
  const vlq = () => {
    let v = 0
    for (let i = 0; i < 4 && p < end; i++) {
      const c = b[p++]
      v = (v << 7) | (c & 0x7f)
      if (!(c & 0x80)) break
    }
    return v
  }
  const close = (ch: number, pitch: number, at: number) => {
    const q = open.get((ch << 7) | pitch)
    const on = q?.shift()
    if (on) notes.push({ tick: on.tick, dur: Math.max(1, at - on.tick), pitch, velocity: on.velocity, channel: ch })
  }
  while (p < end) {
    tick += vlq()
    if (p >= end) break
    let s = b[p]
    if (s & 0x80) p++
    else if (status) s = status // running status: reuse the last channel status, this byte is data
    else { p++; continue } // stray data byte
    if (s === 0xff) { // meta
      status = 0
      const type = b[p++]
      const len = vlq()
      const d = b.subarray(p, Math.min(end, p + len))
      p += len
      if (type === 0x51 && d.length >= 3) {
        const us = (d[0] << 16) | (d[1] << 8) | d[2]
        if (us > 0) tempos.push({ tick, bpm: 60e6 / us })
      } else if (type === 0x58 && d.length >= 2) meters.push({ tick, num: d[0], den: 2 ** d[1] })
      else if (type === 0x03 && !name) name = decodeText(d)
      else if (type === 0x2f) break
      continue
    }
    if (s === 0xf0 || s === 0xf7) { status = 0; const n = vlq(); p += n; continue } // sysex (n first: `p += vlq()` would read p before vlq moves it)
    if (s >= 0xf1) { status = 0; continue } // system common / realtime: not valid in a file, skip the byte
    status = s
    const kind = s & 0xf0, ch = s & 0x0f
    const d1 = b[p++] ?? 0
    const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : b[p++] ?? 0
    if (kind === 0x90 && d2 > 0) {
      const k = (ch << 7) | d1
      const q = open.get(k) ?? []
      q.push({ tick, velocity: d2 })
      open.set(k, q)
    } else if (kind === 0x80 || kind === 0x90) close(ch, d1, tick)
    else if (kind === 0xc0 && !programs.has(ch)) programs.set(ch, d1)
  }
  // notes never switched off end with the track
  for (const [k, q] of open) for (const on of q) notes.push({ tick: on.tick, dur: Math.max(1, tick - on.tick), pitch: k & 0x7f, velocity: on.velocity, channel: k >> 7 })
  notes.sort((x, y) => x.tick - y.tick || x.pitch - y.pitch)
  return { name, notes, programs }
}

function decodeText(d: Uint8Array) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(d).replace(/\0/g, '').trim()
  } catch {
    return String.fromCharCode(...d).replace(/\0/g, '').trim() // latin-1, as old files are
  }
}

// ------------------------------------------------------------------------------------------------ writing

export type SmfSong = {
  ppq: number
  bpm: number
  /** Quarter-note beats per bar (written as n/4). */
  beatsPerBar: number
  name?: string
  tracks: { name: string; channel: number; notes: Omit<SmfNote, 'channel'>[] }[]
}

export function writeSmf(song: SmfSong): Uint8Array {
  const out: number[] = []
  const ascii = (s: string) => { for (const c of s) out.push(c.charCodeAt(0)) }
  const u32 = (v: number, a = out) => a.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  const ppq = Math.max(1, Math.min(0x7fff, Math.round(song.ppq)))
  ascii('MThd'); u32(6)
  out.push(0, 1, ((song.tracks.length + 1) >> 8) & 0xff, (song.tracks.length + 1) & 0xff, ppq >> 8, ppq & 0xff)

  const chunk = (events: { tick: number; order: number; bytes: number[] }[]) => {
    events.sort((x, y) => x.tick - y.tick || x.order - y.order)
    const body: number[] = []
    let last = 0
    for (const e of events) {
      vlqTo(body, Math.max(0, e.tick - last))
      last = Math.max(last, e.tick)
      body.push(...e.bytes)
    }
    vlqTo(body, 0); body.push(0xff, 0x2f, 0x00)
    ascii('MTrk'); u32(body.length)
    for (const x of body) out.push(x)
  }
  const meta = (type: number, data: number[]) => { const m = [0xff, type]; vlqTo(m, data.length); return m.concat(data) }
  const text = (s: string) => [...new TextEncoder().encode(s)]

  const us = Math.round(60e6 / Math.max(1, song.bpm))
  const bpb = Math.max(1, Math.min(255, Math.round(song.beatsPerBar)))
  chunk([
    ...(song.name ? [{ tick: 0, order: 0, bytes: meta(0x03, text(song.name)) }] : []),
    { tick: 0, order: 1, bytes: meta(0x58, [bpb, 2, 24, 8]) },
    { tick: 0, order: 2, bytes: meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]) },
  ])
  for (const t of song.tracks) {
    const ch = t.channel & 0x0f
    const ev: { tick: number; order: number; bytes: number[] }[] = [{ tick: 0, order: 0, bytes: meta(0x03, text(t.name)) }]
    for (const n of t.notes) {
      const tick = Math.max(0, Math.round(n.tick)), dur = Math.max(1, Math.round(n.dur))
      const pitch = clamp(Math.round(n.pitch), 0, 127), vel = clamp(Math.round(n.velocity), 1, 127)
      ev.push({ tick, order: 2, bytes: [0x90 | ch, pitch, vel] })
      ev.push({ tick: tick + dur, order: 1, bytes: [0x80 | ch, pitch, 64] }) // (offs before ons at the same tick)
    }
    chunk(ev)
  }
  return new Uint8Array(out)
}

function vlqTo(a: number[], v: number) {
  v = Math.max(0, Math.min(0x0fffffff, Math.floor(v)))
  const bytes = [v & 0x7f]
  while ((v >>= 7)) bytes.unshift((v & 0x7f) | 0x80)
  a.push(...bytes)
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// ------------------------------------------------------------------------------------------------ mobdaw → file

type ClipNote = Pick<Note, 'tick' | 'durTicks' | 'pitch' | 'velocity'>

/**
 * The notes a MIDI clip plays, in its own ticks from its start: a looping pattern is written out up to the clip's end
 * (`lengthTicks`; a clip that loops forever is written to that length too), and notes are cut at the end.
 */
export function playedNotes(c: Pick<MidiClip, 'lengthTicks' | 'loopTicks'>, notes: ClipNote[]): ClipNote[] {
  const pattern = patternTicks(c)
  const out: ClipNote[] = []
  const src = notes.filter((n) => n.tick < pattern && n.tick >= 0).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
  for (let off = 0; off < c.lengthTicks; off += pattern) {
    for (const n of src) {
      const tick = off + n.tick
      if (tick >= c.lengthTicks) break
      out.push({ ...n, tick, durTicks: Math.max(1, Math.min(n.durTicks, c.lengthTicks - tick, pattern < c.lengthTicks ? pattern - n.tick : Infinity)) })
    }
    if (pattern <= 0) break
  }
  return out
}

const fileVelocity = (v: number) => clamp(Math.round(v * 127), 1, 127)
const drumChannel = (doc: Y.Doc, trackId: string) => (isDrumTrack(trackId, getDevices(doc), getClips(doc)) ? 9 : 0)

const trackName = (doc: Y.Doc, id: string) => (tracksMap(doc).get(id)?.get('name') as string | undefined) ?? 'track'
/** The name a clip goes by: its own, else its track's. */
export const clipName = (doc: Y.Doc, c: MidiClip) => c.name?.trim() || trackName(doc, c.trackId)

/** One MIDI clip as a song: the clip's ppq and bpm, the project's meter, one track. */
export function clipToSong(doc: Y.Doc, clipId: string): SmfSong | null {
  const c = getClips(doc).find((x) => x.id === clipId)
  if (!c || c.kind !== 'midi') return null
  const notes = playedNotes(c, getNotes(doc).filter((n) => n.clipId === c.id))
  const name = clipName(doc, c)
  return {
    ppq: c.ppq, bpm: c.bpm, beatsPerBar: getTempo(doc).beatsPerBar, name,
    tracks: [{ name, channel: drumChannel(doc, c.trackId), notes: notes.map((n) => ({ tick: n.tick, dur: n.durTicks, pitch: n.pitch, velocity: fileVelocity(n.velocity) })) }],
  }
}

/**
 * The whole project as a song at PPQ 960 and the project tempo: one track per MIDI track that has notes (not the click
 * track), clips placed where they start on the timeline. Audio and soundscape tracks are left out.
 */
export function projectToSong(doc: Y.Doc, name: string): SmfSong {
  const rate = getSampleRate(doc)
  const { bpm, beatsPerBar } = getTempo(doc)
  const ppq = DEFAULT_PPQ
  const clips = getClips(doc)
  const notes = getNotes(doc)
  const tracks: SmfSong['tracks'] = []
  for (const t of getTracks(doc).sort((a, b) => a.order - b.order)) {
    if (t.kind !== 'midi' || t.role === 'click') continue
    const out: SmfSong['tracks'][number]['notes'] = []
    for (const c of clips) {
      if (c.trackId !== t.id || c.kind !== 'midi') continue
      const k = (ppq / c.ppq) * (bpm / c.bpm) // clip ticks → song ticks
      const at = (c.start / rate) * (bpm / 60) * ppq
      for (const n of playedNotes(c, notes.filter((x) => x.clipId === c.id))) {
        out.push({ tick: Math.round(at + n.tick * k), dur: Math.max(1, Math.round(n.durTicks * k)), pitch: n.pitch, velocity: fileVelocity(n.velocity) })
      }
    }
    if (out.length) tracks.push({ name: t.name, channel: drumChannel(doc, t.id), notes: out.sort((a, b) => a.tick - b.tick) })
  }
  return { ppq, bpm, beatsPerBar, name, tracks }
}

// ------------------------------------------------------------------------------------------------ file → mobdaw

/** A file's meter as quarter-note beats per bar (6/8 → 3). */
export const beatsPerBarOf = (m: { num: number; den: number }) => clamp(Math.round((m.num * 4) / (m.den || 4)) || m.num || 4, 1, 12)

const DRUM_NAME = /drum|perc|kit\b|beat|kick|snare|hat|cymbal|tom\b/i
export const isDrumPart = (p: Pick<SmfPart, 'channel' | 'name'>) => p.channel === 9 || DRUM_NAME.test(p.name)

/** An INSTRUMENT_PRESETS id for a part, by its name, else its General MIDI program; null: the plain synth. */
export function presetFor(name: string, program: number | null): string | null {
  const byName: [RegExp, string][] = [
    [/sub\s*bass/i, 'sub-bass'], [/finger|electric bass|e\.?\s*bass/i, 'finger-bass'], [/bass/i, 'round-bass'],
    [/rhodes|wurli|e\.?\s*piano|electric piano|\bep\b/i, 'electric-piano'], [/organ/i, 'organ'], [/piano|keys|clav/i, 'soft-keys'],
    [/string|violin|viola|cello|orch/i, 'strings'], [/glass|bell|celest|vibra/i, 'glass-pad'], [/pad|choir|voice|vox/i, 'warm-pad'],
    [/brass|horn|trumpet|trombone|tuba/i, 'brass'], [/flute|pipe|recorder|whistle/i, 'flute-lead'],
    [/sax|reed|oboe|clarinet|lead|melody|synth/i, 'reed-lead'], [/music\s*box/i, 'music-box'], [/kalimba|marimba|xylo/i, 'kalimba'],
    [/guitar|pluck|harp|banjo|koto|sitar/i, 'pluck'], [/drone|fx|sfx|noise/i, 'drone'], [/riser|sweep/i, 'buzz-riser'],
  ]
  for (const [re, id] of byName) if (re.test(name)) return id
  if (program == null) return null
  const fam = program >> 3
  const byFamily = ['soft-keys', 'music-box', 'organ', 'pluck', 'finger-bass', 'strings', 'warm-pad', 'brass', 'reed-lead', 'flute-lead', 'reed-lead', 'warm-pad', 'glass-pad', 'kalimba', 'pluck', 'drone']
  if (program === 4 || program === 5) return 'electric-piano'
  if (program === 38 || program === 39) return 'round-bass'
  if (program === 108) return 'kalimba'
  if (program >= 48 && program <= 51) return 'strings'
  if (program === 10) return 'music-box'
  return byFamily[fam] ?? null
}

/** GM drum keys the kits lack, moved to the nearest drum they have (a crash becomes the open hat). */
const DRUM_MAP: Record<number, number> = {
  35: GM.kick, 40: GM.snare, 44: GM.closedHat, 41: GM.lowTom, 43: GM.lowTom, 48: GM.midTom, 50: GM.midTom,
  49: GM.openHat, 51: GM.openHat, 52: GM.openHat, 53: GM.openHat, 55: GM.openHat, 57: GM.openHat, 59: GM.openHat,
  54: GM.closedHat, 69: GM.closedHat, 82: GM.closedHat, 56: GM.rim, 75: GM.rim, 76: GM.rim, 77: GM.rim,
}
export const kitKey = (pitch: number, keys: Set<number>) => (keys.has(pitch) ? pitch : keys.has(DRUM_MAP[pitch]) ? DRUM_MAP[pitch] : pitch)

export type ImportPart = { name: string; drums: boolean; preset: string | null; lengthTicks: number; notes: ClipNote[] }

/**
 * A file's parts as clips (pure): ticks at `ppq` (bars and beats kept), velocities 0..1, lengths rounded up to whole bars
 * of `beatsPerBar`. Drum parts have their keys moved onto the first kit's drums where it lacks them.
 */
export function planImport(smf: Smf, o: { ppq: number; beatsPerBar: number }): ImportPart[] {
  const k = o.ppq / smf.ppq
  const bar = o.beatsPerBar * o.ppq
  const keys = new Set(DRUM_KITS[0].drums.map((d) => d.key))
  return smf.parts.filter((p) => p.notes.length).map((p) => {
    const drums = isDrumPart(p)
    const notes = p.notes.map((n) => {
      const tick = Math.round(n.tick * k)
      return { tick, durTicks: Math.max(1, Math.round((n.tick + n.dur) * k) - tick), pitch: drums ? kitKey(n.pitch, keys) : n.pitch, velocity: Math.round((n.velocity / 127) * 1000) / 1000 }
    })
    const end = Math.max(...notes.map((n) => n.tick + n.durTicks))
    return { name: p.name, drums, preset: drums ? null : presetFor(p.name, p.program), lengthTicks: Math.max(1, Math.ceil(end / bar)) * bar, notes }
  })
}

export type ImportResult = { tracks: string[]; clips: string[]; adopted: boolean; into: string | null }

/**
 * Put a parsed file into the project, in one transaction. With `trackId` a MIDI track (not the click), all of its parts go
 * into one clip on that track; otherwise each part gets a new instrument track (a drum part the first drum kit; others a
 * finnwave with a preset chosen by name or program). Clips start at `at`, snapped to the nearest bar, at the project bpm.
 * A project without clips (the click track's aside) takes the file's first tempo and time signature first.
 */
export function importSmf(doc: Y.Doc, smf: Smf, o: { at: number; trackId?: string | null; base: string }): ImportResult {
  const res: ImportResult = { tracks: [], clips: [], adopted: false, into: null }
  const click = new Set(getTracks(doc).filter((t) => t.role === 'click').map((t) => t.id))
  const target = o.trackId && tracksMap(doc).get(o.trackId)?.get('kind') === 'midi' && !click.has(o.trackId) ? o.trackId : null
  doc.transact(() => {
    if (!getClips(doc).some((c) => !click.has(c.trackId))) {
      const t0 = smf.tempos.find((t) => t.tick === 0) ?? smf.tempos[0]
      const m0 = smf.meters.find((m) => m.tick === 0) ?? smf.meters[0]
      if (t0) setProjectTempo(doc, clampBpm(t0.bpm))
      if (m0) setBeatsPerBar(doc, beatsPerBarOf(m0))
      res.adopted = !!(t0 || m0)
    }
    const tempo = getTempo(doc)
    const rate = getSampleRate(doc)
    const bar = samplesPerBar(tempo, rate)
    const start = Math.max(0, Math.round(Math.round(o.at / bar) * bar))
    const ppq = DEFAULT_PPQ
    const parts = planImport(smf, { ppq, beatsPerBar: tempo.beatsPerBar })
    if (!parts.length) return
    const clip = (trackId: string, p: Pick<ImportPart, 'name' | 'lengthTicks' | 'notes'>, drums: boolean) => {
      const id = addMidiClip(doc, { trackId, start, bpm: tempo.bpm, ppq, lengthTicks: p.lengthTicks, name: p.name, ...(drums ? { view: 'drums' as const } : {}) })
      for (const n of p.notes) addNote(doc, { clipId: id, ...n })
      res.clips.push(id)
    }
    if (target) {
      res.into = target
      const notes = parts.flatMap((p) => p.notes).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
      const drums = isDrumTrack(target, getDevices(doc), getClips(doc))
      clip(target, { name: o.base, lengthTicks: Math.max(...parts.map((p) => p.lengthTicks)), notes }, drums && parts.every((p) => p.drums))
      return
    }
    parts.forEach((p, i) => {
      const name = p.name || (parts.length > 1 ? `${o.base} ${i + 1}` : o.base)
      const id = addTrack(doc, name, 'midi', undefined, undefined, getTracks(doc).length % 8)
      if (p.drums) addDrumKit(doc, id, DRUM_KITS[0])
      else {
        const pre = p.preset ? instrumentPreset(p.preset) : undefined
        if (pre) addInstrument(doc, id, pre)
        else addDevice(doc, id, FINNWAVE)
      }
      res.tracks.push(id)
      clip(id, { ...p, name }, p.drums)
    })
  })
  return res
}

/** Whether a dropped or picked file is a MIDI file. */
export const isMidiFile = (f: Pick<File, 'name' | 'type'>) => /\.(midi?|kar|rmi)$/i.test(f.name) || /^audio\/(x-)?midi$/.test(f.type)

/** A window event asking the open studio to download the whole project as MIDI (`detail: { name }`; sent by the export dialog). */
export const EXPORT_MIDI_EVENT = 'mobdaw:export-midi'
