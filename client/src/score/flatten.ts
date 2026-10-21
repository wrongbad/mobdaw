// Layer 1 of the score view: a track's MIDI notes as one flat list in absolute ticks (from bar 1), loop passes written out
// and clipped, same-pitch overlaps cut. Pure; the doc's notes are never changed.
import { isDrum, patternTicks, type Clip, type Device, type Marker, type Note, type Track, type TimeMap } from '@mobdaw/shared'

export type ScoreInput = { tracks: Track[]; clips: Clip[]; notes: Note[]; devices: Device[]; map: TimeMap; key?: string; markers: Marker[] }

export type FlatNote = {
  noteId: string
  tick: number
  dur: number
  pitch: number
  velocity: number
  /** Loop pass the note came from (0: the clip's own first pass; later passes are read-only copies). */
  repeat: number
}
export type FlatTrack = {
  id: string
  name: string
  drums: boolean
  /** Sorted by tick. */
  notes: FlatNote[]
  /** Drum key -> the drum's name (from the track's drum devices); empty for pitched tracks. */
  drumNames: Map<number, string>
}

/** A runaway guard: a 1-tick loop in a long clip would otherwise write out millions of passes. */
const MAX_PASSES = 4096

export function flattenTrack(track: Pick<Track, 'id' | 'name'>, drums: boolean, input: Pick<ScoreInput, 'clips' | 'notes' | 'devices'>): FlatTrack {
  const out: FlatNote[] = []
  const clips = new Map<string, Clip & { kind: 'midi' }>()
  for (const c of input.clips) if (c.kind === 'midi' && c.trackId === track.id) clips.set(c.id, c)
  for (const n of input.notes) {
    const c = clips.get(n.clipId)
    if (!c) continue
    const pattern = patternTicks(c)
    if (!(pattern > 0) || n.tick >= pattern || n.tick < 0) continue
    for (let k = 0; k < MAX_PASSES && k * pattern < c.lengthTicks; k++) {
      const local = k * pattern + n.tick
      const dur = Math.min(n.durTicks, pattern - n.tick, c.lengthTicks - local)
      if (dur > 0) out.push({ noteId: n.id, tick: c.startTick + local, dur, pitch: n.pitch, velocity: n.velocity, repeat: k })
    }
  }
  const drumNames = new Map<number, string>()
  if (drums) for (const d of input.devices) if (d.trackId === track.id && isDrum(d)) drumNames.set(d.keyLo ?? 0, d.name ?? '')
  return { id: track.id, name: track.name, drums, notes: cutOverlaps(out), drumNames }
}

/** Same-pitch notes that overlap: the earlier is cut at the later onset (a note cut to nothing is dropped). */
export function cutOverlaps(notes: FlatNote[]): FlatNote[] {
  const sorted = [...notes].sort((a, b) => a.pitch - b.pitch || a.tick - b.tick)
  const out: FlatNote[] = []
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]
    const next = sorted[i + 1]
    const dur = next && next.pitch === n.pitch ? Math.min(n.dur, next.tick - n.tick) : n.dur
    if (dur > 0) out.push(dur === n.dur ? n : { ...n, dur })
  }
  return out.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
}
