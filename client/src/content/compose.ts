// Small helpers for writing project content in code: the project's meta, tracks with colours, and MIDI clips placed by
// bar and written in beats. Shared by the templates and the demo song.
import type * as Y from 'yjs'
import {
  DEFAULT_PPQ, DEFAULT_SAMPLE_RATE, DEVICES, MASTER_TRACK, SCHEMA_VERSION,
  addLane, addMidiClip, addNote, addPoint, addTrack, metaMap, paramToPos, samplesPerBar, setTrackColor, updateTrack,
  type ParamKind, type TrackKind, type TrackRole,
} from '@mobdaw/shared'

export type Song = { doc: Y.Doc; bpm: number; beatsPerBar: number; rate: number; ppq: number }

/** Set the meta every new project carries, and return the context the other helpers take. */
export function initProject(doc: Y.Doc, bpm: number, beatsPerBar = 4): Song {
  const rate = DEFAULT_SAMPLE_RATE
  doc.transact(() => {
    const meta = metaMap(doc)
    meta.set('schemaVersion', SCHEMA_VERSION)
    meta.set('sampleRate', rate)
    meta.set('bpm', bpm)
    meta.set('beatsPerBar', beatsPerBar)
  })
  return { doc, bpm, beatsPerBar, rate, ppq: DEFAULT_PPQ }
}

/** Timeline sample of the start of `bar` (counted from 0). */
export const barPos = (s: Song, bar: number) => Math.round(bar * samplesPerBar(s, s.rate))

export type TrackOpts = { color: number; gain?: number; pan?: number; muted?: boolean; role?: TrackRole }
export function track(s: Song, name: string, kind: TrackKind, o: TrackOpts): string {
  const id = addTrack(s.doc, name, kind, undefined, o.role)
  setTrackColor(s.doc, id, o.color)
  const patch = { ...(o.gain != null ? { gain: o.gain } : {}), ...(o.pan != null ? { pan: o.pan } : {}), ...(o.muted ? { muted: true } : {}) }
  if (Object.keys(patch).length) updateTrack(s.doc, id, patch)
  return id
}

export type ClipWriter = {
  id: string
  /** Add a note `beat` beats into the clip (fractional beats fine), lasting `dur` beats; it is kept inside the pattern. */
  note(beat: number, pitch: number, dur: number, velocity: number): void
}
export type ClipOpts = { bar: number; bars: number; /** a pattern this many bars long repeats to fill `bars` */ loopBars?: number; drums?: boolean; forever?: boolean }

export function clip(s: Song, trackId: string, o: ClipOpts): ClipWriter {
  const barTicks = s.beatsPerBar * s.ppq
  const lengthTicks = o.bars * barTicks
  const loopTicks = o.loopBars && o.loopBars < o.bars ? o.loopBars * barTicks : undefined
  const id = addMidiClip(s.doc, {
    trackId, start: barPos(s, o.bar), bpm: s.bpm, ppq: s.ppq, lengthTicks,
    ...(loopTicks ? { loopTicks } : {}), ...(o.forever && loopTicks ? { forever: true } : {}), ...(o.drums ? { view: 'drums' as const } : {}),
  })
  const end = loopTicks ?? lengthTicks
  return {
    id,
    note(beat, pitch, dur, velocity) {
      const tick = Math.max(0, Math.round(beat * s.ppq))
      if (tick >= end) return
      const durTicks = Math.max(1, Math.min(Math.round(dur * s.ppq), end - tick))
      addNote(s.doc, { clipId: id, tick, durTicks, pitch, velocity: Math.min(1, Math.max(0.05, velocity)) })
    },
  }
}

/** A deterministic pseudo-random source in [0, 1) (mulberry32), so content builds the same every time. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * An automation lane on a device param (`scope` is the device's track, or MASTER_TRACK) with keyframes given in real
 * values at bar positions. The lane stores the param's range, as lanes made in the UI do.
 */
export function automate(s: Song, scope: string, kind: ParamKind, deviceId: string, type: number, param: number, points: [bar: number, value: number][]) {
  const def = DEVICES[type].params.find((p) => p.id === param)!
  const lane = addLane(s.doc, { scope, kind, owner: deviceId, param: String(param) }, { min: def.min, max: def.max, scale: def.scale })
  for (const [bar, v] of points) addPoint(s.doc, lane, barPos(s, bar), paramToPos(def, v))
  return lane
}
export { MASTER_TRACK }
