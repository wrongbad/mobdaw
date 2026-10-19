// A tiny picture of a project for the project list: one row per track, one span per clip (or per pad on a
// soundscape track), positioned as fractions of the project's length. No audio, no engine, no screenshots.
import type * as Y from 'yjs'
import { DEFAULT_SAMPLE_RATE, clipEnd, clipStart, getClips, getPads, getTimeMap, getTracks, metaMap, type TrackKind } from './schema.ts'

export type PreviewRow = { kind: TrackKind; spans: [start: number, end: number][] }
export type ProjectPreview = { rows: PreviewRow[] }

const MAX_ROWS = 10
const MAX_SPANS = 200
const round = (n: number) => Math.round(n * 1000) / 1000

export function projectPreview(doc: Y.Doc): ProjectPreview {
  const rate = Number(metaMap(doc).get('sampleRate')) || DEFAULT_SAMPLE_RATE
  const tracks = getTracks(doc).slice(0, MAX_ROWS)
  const clips = getClips(doc)
  const pads = getPads(doc)
  const map = getTimeMap(doc)
  const raw = tracks.map((t) => {
    const spans: [number, number][] = []
    if (t.kind === 'soundscape') {
      for (const p of pads) if (p.trackId === t.id) spans.push([p.start, p.start + p.length])
    } else {
      for (const c of clips) {
        if (c.trackId !== t.id) continue
        const old = c as unknown as { start?: number; bpm?: number; ppq?: number; lengthTicks?: number }
        // a project not yet opened since v4 still has the per-clip clock
        if (c.kind === 'midi' && c.startTick == null) spans.push([old.start ?? 0, (old.start ?? 0) + Math.round(((old.lengthTicks ?? 0) / (old.ppq ?? 960)) * (60 / (old.bpm ?? 120)) * rate)])
        else spans.push([clipStart(c, map), clipEnd(c, map)])
      }
    }
    return { kind: t.kind, spans: spans.slice(0, MAX_SPANS) }
  })
  const end = Math.max(0, ...raw.flatMap((r) => r.spans.map((s) => s[1])))
  if (end <= 0) return { rows: raw.map((r) => ({ kind: r.kind, spans: [] })) }
  return {
    rows: raw.map((r) => ({
      kind: r.kind,
      spans: r.spans.map(([a, b]): [number, number] => [round(a / end), round(b / end)]),
    })),
  }
}
