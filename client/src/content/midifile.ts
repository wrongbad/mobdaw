// Standard MIDI Files (.mid): a dependency-free reader and writer, and the mapping between them and mobdaw's MIDI clips.
//
// Reading: format 0, 1 (and 2, read like 1), running status, note on / off (a note-on at velocity 0 is a note-off),
// program changes, and the meta events tempo (FF 51), time signature (FF 58) and track name (FF 03). Everything else
// (sysex, controllers, pitch bend, other metas) is skipped. A track holding several channels is split per channel.
// SMPTE time division is read as if at 120 bpm.
// Writing: format 1. Track 0 is the conductor (song name, tempo, time signature); then one track per part.
//
// Writing the project: the time map goes back as tempo (FF 51) and time-signature (FF 58) events on the conductor track (a ramp
// as one tempo event per beat; a free region as a bar of its nominal length at its nominal tempo), notes at the project's ppq.
//
// Importing (docs/engine.md §2): if the project has only the default timeline (one default region, no MIDI clips yet) the
// file's tempo and time-signature events become regions (a tempo change snaps to the nearest bar line, a meter change to the
// nearest whole bar; 6/8 is num 6 den 8 and gets its default 3+3 grouping), the clip starts at bar 1 and file ticks scale by
// `project ppq / file ppq`. Otherwise the project's map is kept and the music is placed by time: file ticks -> seconds (the
// file's own tempo map) -> project ticks, counted from the clip's start, so the notes sound where the file says even though
// the project's bars do not line up with the file's.
import {
  nextTrackColor, addMidiClip, addNote, addRegion, addTrack, getClips, getNotes, getPpq, getRegions, getSampleRate, getTimeMap, getTracks, setRegion,
  DEFAULT_MIDI_BPM, patternTicks, tracksMap, type MidiClip, type Note, type TimeMap,
} from '@mobdaw/shared'
import type * as Y from 'yjs'
import { DRUM_KITS, GM, INSTRUMENT_PRESETS, addDrumKit, addInstrument, instrumentPreset } from './presets'

const roundBpm = (bpm: number) => Math.max(0.01, Math.round(bpm * 100) / 100)

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
  /** Quarter-note beats per bar (written as n/4); used when `meters` is not given. */
  beatsPerBar: number
  name?: string
  /** The conductor's tempo and time-signature events in ticks at `ppq` (the project's map). Replace `bpm` / `beatsPerBar` when given. */
  tempos?: { tick: number; bpm: number }[]
  meters?: { tick: number; num: number; den: number }[]
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

  const tempoBytes = (bpm: number) => {
    const us = Math.min(0xffffff, Math.max(1, Math.round(60e6 / Math.max(0.01, bpm))))
    return meta(0x51, [(us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff])
  }
  const meterBytes = (num: number, den: number) => meta(0x58, [Math.max(1, Math.min(255, Math.round(num))), clamp(Math.round(Math.log2(Math.max(1, den))), 0, 7), 24, 8])
  const meters = song.meters?.length ? song.meters : [{ tick: 0, num: song.beatsPerBar, den: 4 }]
  const tempos = song.tempos?.length ? song.tempos : [{ tick: 0, bpm: song.bpm }]
  chunk([
    ...(song.name ? [{ tick: 0, order: 0, bytes: meta(0x03, text(song.name)) }] : []),
    ...meters.map((m) => ({ tick: Math.max(0, Math.round(m.tick)), order: 1, bytes: meterBytes(m.num, m.den) })),
    ...tempos.map((t) => ({ tick: Math.max(0, Math.round(t.tick)), order: 2, bytes: tempoBytes(t.bpm) })),
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
const drumChannel = (c: MidiClip) => (c.view === 'drums' ? 9 : 0) // GM drums are channel 10 (index 9)

const trackName = (doc: Y.Doc, id: string) => (tracksMap(doc).get(id)?.get('name') as string | undefined) ?? 'track'
/** The name a clip goes by: its track's. */
export const clipName = (doc: Y.Doc, c: MidiClip) => trackName(doc, c.trackId)

/**
 * The map's tempo and meter events for the ticks `[from, to)`, relative to `from` (the state at `from` is an event at 0). A ramp is
 * one tempo event per beat (the tempo at that beat's start); a free region is a bar of its nominal length (`N/4`, N the nearest whole
 * number of quarters) at its nominal tempo. Ticks are rounded when written.
 */
export function mapEvents(map: TimeMap, from: number, to: number): Pick<SmfSong, 'tempos' | 'meters'> {
  const tempos: { tick: number; bpm: number }[] = []
  const meters: { tick: number; num: number; den: number }[] = []
  const tempo = (tick: number, bpm: number) => {
    if (tempos.length && Math.abs(tempos[tempos.length - 1].bpm - bpm) < 1e-9) return
    tempos.push({ tick: tick - from, bpm })
  }
  const meter = (tick: number, num: number, den: number) => {
    const last = meters[meters.length - 1]
    if (last && last.num === num && last.den === den) return
    meters.push({ tick: tick - from, num, den })
  }
  for (const sp of map.spans) {
    if (sp.endTick <= from) continue
    if (sp.startTick >= to && sp.startTick > from) break
    const at = Math.max(sp.startTick, from)
    const total = sp.endTick - sp.startTick
    const m = map.meterAt(sp.startBar)
    if (m.free) meter(at, Math.max(1, Math.round(m.barTicks / map.ppq)), 4)
    else meter(at, m.num, m.den)
    const bpmAt = (t: number) => (sp.bpm0 === sp.bpm1 || !Number.isFinite(total) ? sp.bpm0 : sp.bpm0 + ((sp.bpm1 - sp.bpm0) * (t - sp.startTick)) / total)
    tempo(at, bpmAt(at))
    if (sp.bpm0 !== sp.bpm1 && Number.isFinite(total)) {
      const first = Math.floor((at - sp.startTick) / m.beatTicks + 1e-9) + 1
      for (let k = first; ; k++) {
        const t = sp.startTick + k * m.beatTicks
        if (t >= sp.endTick - 1e-6 || t >= to) break
        tempo(t, bpmAt(t))
      }
    }
  }
  return { tempos, meters }
}

/** One MIDI clip as a song: project ppq, the tempo and meter in effect where it starts (and any change inside it), one track. */
export function clipToSong(doc: Y.Doc, clipId: string): SmfSong | null {
  const c = getClips(doc).find((x) => x.id === clipId)
  if (!c || c.kind !== 'midi') return null
  const map = getTimeMap(doc)
  const notes = playedNotes(c, getNotes(doc).filter((n) => n.clipId === c.id))
  const name = clipName(doc, c)
  const ev = mapEvents(map, c.startTick, c.startTick + c.lengthTicks)
  return {
    ppq: map.ppq, bpm: ev.tempos![0]?.bpm ?? DEFAULT_MIDI_BPM, beatsPerBar: 4, name, ...ev,
    tracks: [{ name, channel: drumChannel(c), notes: notes.map((n) => ({ tick: n.tick, dur: n.durTicks, pitch: n.pitch, velocity: fileVelocity(n.velocity) })) }],
  }
}

/**
 * The whole project as a song at the project's ppq with its tempo / meter map on the conductor track: one track per MIDI track that
 * has notes (not the click track), notes at `clip.startTick + note.tick`. Audio and soundscape tracks are left out.
 */
export function projectToSong(doc: Y.Doc, name: string): SmfSong {
  const map = getTimeMap(doc)
  const ppq = map.ppq
  const clips = getClips(doc)
  const notes = getNotes(doc)
  const tracks: SmfSong['tracks'] = []
  let end = 0
  for (const t of getTracks(doc).sort((a, b) => a.order - b.order)) {
    if (t.kind !== 'midi' || t.role === 'click') continue
    const out: SmfSong['tracks'][number]['notes'][] = [[], []] // per channel: melodic, drum grids
    for (const c of clips) {
      if (c.trackId !== t.id || c.kind !== 'midi') continue
      for (const n of playedNotes(c, notes.filter((x) => x.clipId === c.id))) {
        const tick = Math.round(c.startTick + n.tick), dur = Math.max(1, Math.round(n.durTicks))
        end = Math.max(end, tick + dur)
        out[c.view === 'drums' ? 1 : 0].push({ tick, dur, pitch: n.pitch, velocity: fileVelocity(n.velocity) })
      }
    }
    out.forEach((o, i) => o.length && tracks.push({ name: t.name, channel: i ? 9 : 0, notes: o.sort((a, b) => a.tick - b.tick) }))
  }
  const ev = mapEvents(map, 0, end)
  return { ppq, bpm: ev.tempos![0]?.bpm ?? DEFAULT_MIDI_BPM, beatsPerBar: 4, name, ...ev, tracks }
}

/** The project as a Standard MIDI File (format 1): what the export dialog saves. */
export const exportProjectMidi = (doc: Y.Doc, name: string): Uint8Array => writeSmf(projectToSong(doc, name))

// ------------------------------------------------------------------------------------------------ file → mobdaw

const DRUM_NAME = /drum|perc|kit\b|beat|kick|snare|hat|cymbal|tom\b/i
export const isDrumPart = (p: Pick<SmfPart, 'channel' | 'name'>) => p.channel === 9 || DRUM_NAME.test(p.name)

/** An INSTRUMENT_PRESETS id for a part, by its General MIDI program (`gm` on the preset), else its name, else the first preset. */
export function presetFor(name: string, program: number | null): string {
  const byName: [RegExp, string][] = [
    [/sub\s*bass/i, 'sub-bass'], [/finger|electric bass|e\.?\s*bass/i, 'finger-bass'], [/bass/i, 'round-bass'],
    [/rhodes|wurli|e\.?\s*piano|electric piano|\bep\b/i, 'electric-piano'], [/organ/i, 'organ'], [/piano|keys|clav/i, 'soft-keys'],
    [/string|violin|viola|cello|orch/i, 'strings'], [/glass|bell|celest|vibra/i, 'glass-pad'], [/pad|choir|voice|vox/i, 'warm-pad'],
    [/brass|horn|trumpet|trombone|tuba/i, 'brass'], [/flute|pipe|recorder|whistle/i, 'flute-lead'],
    [/sax|reed|oboe|clarinet|lead|melody|synth/i, 'reed-lead'], [/music\s*box/i, 'music-box'], [/kalimba|marimba|xylo/i, 'kalimba'],
    [/guitar|pluck|harp|banjo|koto|sitar/i, 'pluck'], [/drone|fx|sfx|noise/i, 'drone'], [/riser|sweep/i, 'buzz-riser'],
  ]
  const byProgram = program == null ? undefined : INSTRUMENT_PRESETS.find((p) => p.gm?.includes(program))?.id
  if (byProgram) return byProgram
  for (const [re, id] of byName) if (re.test(name)) return id
  return INSTRUMENT_PRESETS[0].id
}

/** GM drum keys the kits lack, moved to the nearest drum they have (a crash becomes the open hat). */
const DRUM_MAP: Record<number, number> = {
  35: GM.kick, 40: GM.snare, 44: GM.closedHat, 41: GM.lowTom, 43: GM.lowTom, 48: GM.midTom, 50: GM.midTom,
  49: GM.openHat, 51: GM.openHat, 52: GM.openHat, 53: GM.openHat, 55: GM.openHat, 57: GM.openHat, 59: GM.openHat,
  54: GM.closedHat, 69: GM.closedHat, 82: GM.closedHat, 56: GM.rim, 75: GM.rim, 76: GM.rim, 77: GM.rim,
}
export const kitKey = (pitch: number, keys: Set<number>) => (keys.has(pitch) ? pitch : keys.has(DRUM_MAP[pitch]) ? DRUM_MAP[pitch] : pitch)

export type ImportPart = { name: string; drums: boolean; preset: string | null; lengthTicks: number; notes: ClipNote[] }

/** A region the file asks for: from `bar` on, at `bpm` in num/den. */
export type FileRegion = { bar: number; bpm: number; num: number; den: number }

/**
 * The file's tempo and time-signature events as regions (pure). Bars are counted from the meter events (a change lands on the
 * nearest whole bar); a tempo event lands on the nearest bar line, the last one winning when several land together; the tempo is 120
 * until the first event. Neighbouring regions with the same tempo and meter are merged. Always starts at bar 1.
 */
export function smfRegions(smf: Smf): FileRegion[] {
  const meters = new Map<number, { num: number; den: number }>()
  for (const m of smf.meters) if (m.num >= 1 && m.den >= 1) meters.set(m.tick, m)
  const ms = [...meters.entries()].sort((a, b) => a[0] - b[0]).map(([tick, m]) => ({ tick, num: m.num, den: m.den }))
  if (!ms.length || ms[0].tick > 0) ms.unshift({ tick: 0, num: 4, den: 4 })
  const segs: { tick: number; bar: number; num: number; den: number; barTicks: number }[] = []
  let bar = 1
  ms.forEach((m, i) => {
    const barTicks = (m.num * 4 * smf.ppq) / m.den
    segs.push({ ...m, bar, barTicks })
    if (ms[i + 1]) bar += Math.max(1, Math.round((ms[i + 1].tick - m.tick) / barTicks))
  })
  const segAt = (f: (s: (typeof segs)[number]) => boolean) => segs.filter(f).at(-1) ?? segs[0]
  const barOfTick = (tick: number) => { const sg = segAt((x) => x.tick <= tick); return sg.bar + Math.max(0, Math.round((tick - sg.tick) / sg.barTicks)) }
  const tempoAt = new Map<number, number>() // bar -> bpm
  for (const t of [...smf.tempos].sort((a, b) => a.tick - b.tick)) if (t.bpm > 0) tempoAt.set(barOfTick(t.tick), t.bpm)
  const bars = [...new Set([...segs.map((x) => x.bar), ...tempoAt.keys(), 1])].sort((a, b) => a - b)
  const out: FileRegion[] = []
  let bpm = DEFAULT_MIDI_BPM
  for (const b of bars) {
    if (tempoAt.has(b)) bpm = roundBpm(tempoAt.get(b)!)
    const sg = segAt((x) => x.bar <= b)
    const last = out[out.length - 1]
    if (last && last.bpm === bpm && last.num === sg.num && last.den === sg.den) continue
    out.push({ bar: b, bpm, num: sg.num, den: sg.den })
  }
  return out
}

/** File ticks -> seconds through the file's tempo events (120 bpm until the first). */
export function smfSeconds(smf: Smf): (tick: number) => number {
  const ts: { tick: number; sec: number; bpm: number }[] = [{ tick: 0, sec: 0, bpm: DEFAULT_MIDI_BPM }]
  for (const t of [...smf.tempos].sort((a, b) => a.tick - b.tick)) {
    if (!(t.bpm > 0)) continue
    const last = ts[ts.length - 1]
    const sec = last.sec + ((t.tick - last.tick) * 60) / (last.bpm * smf.ppq)
    if (t.tick === last.tick) last.bpm = t.bpm
    else ts.push({ tick: t.tick, sec, bpm: t.bpm })
  }
  return (tick) => {
    let lo = 0, hi = ts.length - 1
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ts[mid].tick <= tick) lo = mid; else hi = mid - 1 }
    const e = ts[lo]
    return e.sec + ((tick - e.tick) * 60) / (e.bpm * smf.ppq)
  }
}

/**
 * A file's parts as clip contents (pure): `toTick` maps a file tick to a clip-local project tick (default: the ratio of the
 * resolutions, `ppq / file ppq`, which keeps bars and beats), velocities 0..1. `lengthTicks` is where the last note ends (the
 * caller rounds clips up to whole bars of the map). Drum parts have their keys moved onto the first kit's drums where it lacks them.
 */
export function planImport(smf: Smf, o: { ppq: number; toTick?: (fileTick: number) => number }): ImportPart[] {
  const toTick = o.toTick ?? ((t: number) => Math.round(t * (o.ppq / smf.ppq)))
  const keys = new Set(DRUM_KITS[0].drums.map((d) => d.key))
  return smf.parts.filter((p) => p.notes.length).map((p) => {
    const drums = isDrumPart(p)
    const notes = p.notes.map((n) => {
      const tick = Math.max(0, toTick(n.tick))
      return { tick, durTicks: Math.max(1, toTick(n.tick + n.dur) - tick), pitch: drums ? kitKey(n.pitch, keys) : n.pitch, velocity: Math.round((n.velocity / 127) * 1000) / 1000 }
    })
    const end = Math.max(...notes.map((n) => n.tick + n.durTicks))
    return { name: p.name, drums, preset: drums ? null : presetFor(p.name, p.program), lengthTicks: Math.max(1, end), notes }
  })
}

export type ImportResult = { tracks: string[]; clips: string[]; adopted: boolean; into: string | null }

/** Whether the project still has just the default timeline and no MIDI clips (the click track's aside): a file may then set its map. */
export function hasDefaultTimeline(doc: Y.Doc): boolean {
  const click = new Set(getTracks(doc).filter((t) => t.role === 'click').map((t) => t.id))
  const rs = getRegions(doc)
  const r = rs[0]
  const plain = rs.length === 1 && r.kind === 'metered' && r.bpm === DEFAULT_MIDI_BPM && r.num === 4 && r.den === 4 && !r.groups && r.rampTo == null
  return plain && !getClips(doc).some((c) => c.kind === 'midi' && !click.has(c.trackId))
}

/** `ticks` long from `startTick`, rounded up to whole bars of the map (at least one); unchanged when it ends in a free region. */
export function wholeBars(map: TimeMap, startTick: number, ticks: number): number {
  const p0 = map.position(startTick), p1 = map.position(startTick + ticks)
  if (p0.free || p1.free) return ticks
  const bar = Math.max(p1.tickInBar < 1e-6 ? p1.bar : p1.bar + 1, p0.bar + 1)
  return map.barStart(bar) - startTick
}

/**
 * Put a parsed file into the project, in one transaction. With `trackId` a MIDI track (not the click), all of its parts go
 * into one clip on that track; otherwise each part gets a new instrument track (a drum part the first drum kit; others a
 * finnwave with a preset chosen by name or program).
 *  - A project with just the default timeline (`hasDefaultTimeline`) takes the file's tempo and time-signature events as regions
 *    (`smfRegions`), and the clips start at bar 1 (`at` is ignored) with file ticks scaled to the project ppq.
 *  - Otherwise the project's map stays: the clips start at the bar nearest `at` (samples), and the notes are placed by time:
 *    file tick -> seconds in the file's tempo map -> project ticks from there, so they sound where the file says.
 * Clips are rounded up to whole bars of the map.
 */
export function importSmf(doc: Y.Doc, smf: Smf, o: { at: number; trackId?: string | null; base: string }): ImportResult {
  const res: ImportResult = { tracks: [], clips: [], adopted: false, into: null }
  const click = new Set(getTracks(doc).filter((t) => t.role === 'click').map((t) => t.id))
  const target = o.trackId && tracksMap(doc).get(o.trackId)?.get('kind') === 'midi' && !click.has(o.trackId) ? o.trackId : null
  let adopted = false
  doc.transact(() => {
    const ppq = getPpq(doc)
    const fresh = smf.parts.some((p) => p.notes.length) && hasDefaultTimeline(doc)
    let startTick = 0
    let toTick: ((t: number) => number) | undefined
    if (fresh && (smf.tempos.length || smf.meters.length)) {
      const regions = smfRegions(smf)
      const first = getRegions(doc)[0]
      regions.forEach((r, i) => {
        if (i === 0) setRegion(doc, first.id, { bpm: r.bpm, num: r.num, den: r.den, groups: undefined, rampTo: undefined })
        else addRegion(doc, { bar: r.bar, bpm: r.bpm, num: r.num, den: r.den })
      })
      adopted = true
    } else if (!fresh) {
      const m = getTimeMap(doc)
      const raw = m.sampleToTick(Math.max(0, o.at))
      startTick = Math.max(0, m.snapTick(raw, 'bar') ?? raw)
      const sec = smfSeconds(smf)
      const s0 = m.tickToSampleExact(startTick), rate = getSampleRate(doc)
      toTick = (f) => Math.round((m.sampleToTick(s0 + sec(f) * rate) - startTick) * 1000) / 1000
    }
    const map = getTimeMap(doc)
    const parts = planImport(smf, { ppq, toTick })
    if (!parts.length) return
    const clip = (trackId: string, p: Pick<ImportPart, 'lengthTicks' | 'notes'>, drums: boolean) => {
      const id = addMidiClip(doc, { trackId, startTick, lengthTicks: wholeBars(map, startTick, p.lengthTicks), ...(drums ? { view: 'drums' as const } : {}) })
      for (const n of p.notes) addNote(doc, { clipId: id, ...n })
      res.clips.push(id)
    }
    if (target) {
      res.into = target
      const notes = parts.flatMap((p) => p.notes).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
      clip(target, { lengthTicks: Math.max(...parts.map((p) => p.lengthTicks)), notes }, parts.every((p) => p.drums))
      return
    }
    parts.forEach((p, i) => {
      const name = p.name || (parts.length > 1 ? `${o.base} ${i + 1}` : o.base)
      const id = addTrack(doc, name, 'midi', undefined, undefined, nextTrackColor(getTracks(doc)))
      if (p.drums) addDrumKit(doc, id, DRUM_KITS[0])
      else addInstrument(doc, id, (p.preset ? instrumentPreset(p.preset) : undefined) ?? INSTRUMENT_PRESETS[0])
      res.tracks.push(id)
      clip(id, p, p.drums)
    })
  })
  res.adopted = adopted
  return res
}

/** Whether a dropped or picked file is a MIDI file. */
export const isMidiFile = (f: Pick<File, 'name' | 'type'>) => /\.(midi?|kar|rmi)$/i.test(f.name) || /^audio\/(x-)?midi$/.test(f.type)

/** A window event asking the open studio to download the whole project as MIDI (`detail: { name }`; sent by the export dialog). */
export const EXPORT_MIDI_EVENT = 'mobdaw:export-midi'
