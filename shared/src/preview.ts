// A tiny picture of a project for the project list: one row per track, one span per clip (or per pad on a
// soundscape track), positioned as fractions of the project's length. No audio, no engine, no screenshots.
import type * as Y from 'yjs'
import { DEFAULT_SAMPLE_RATE, getClips, getPads, getTracks, metaMap, type TrackKind } from './schema.ts'

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
  const raw = tracks.map((t) => {
    const spans: [number, number][] = []
    if (t.kind === 'soundscape') {
      for (const p of pads) if (p.trackId === t.id) spans.push([p.start, p.start + p.length])
    } else {
      for (const c of clips) {
        if (c.trackId !== t.id) continue
        const length = c.kind === 'audio' ? c.length : Math.round((c.lengthTicks / c.ppq) * (60 / c.bpm) * rate)
        spans.push([c.start, c.start + length])
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
