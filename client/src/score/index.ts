// The score view's pure core: a project's MIDI tracks -> ABC text for abcjs (docs/SCORE-PLAN.md). No DOM, no Yjs; the caller reads the
// doc into a `ScoreInput` and renders `BuiltScore.abc`. Layers: flatten -> measures -> quantize -> notate (+ spell, staves, drums) -> abc.
import { emitAbc, type Part, type Staff } from './abc'
import { drumEvents, drumHeads } from './drums'
import { flattenTrack, type FlatTrack, type ScoreInput } from './flatten'
import { buildBars } from './measures'
import { chordEvents, notateStaff, type QNote } from './notate'
import { quantizeNotes } from './quantize'
import { estimateKey, parseKey } from './spell'
import { chooseClef, GRAND_SPLIT } from './staves'
import { isDrumTrack } from '../ui/trackKind'

export type { ScoreInput } from './flatten'
export type ScoreTrack = { id: string; name: string; drums: boolean }
export type BuiltScore = {
  abc: string
  /** The project bars shown (1-based `bar`), with their tick range. */
  bars: { bar: number; startTick: number; endTick: number }[]
  /** Systems: which entries of `bars` (indices, inclusive) each ABC line of music holds, in order. */
  lines: { first: number; last: number }[]
  /** Character ranges in `abc` of every emitted note/chord piece, with the doc note ids it came from (for clicks later). */
  ids: { start: number; end: number; noteIds: string[] }[]
  /** Pass to abcjs renderAbc as `staffwidth`. */
  staffWidth: number
  /** Nothing to show (no chosen track has notes). */
  empty: boolean
}

/** Tracks that can appear in the score: MIDI tracks with at least one note, in track order; never the click track (role 'click'). */
export function scoreTracks(input: ScoreInput): ScoreTrack[] {
  const clipTrack = new Map<string, string>()
  for (const c of input.clips) if (c.kind === 'midi') clipTrack.set(c.id, c.trackId)
  const has = new Set<string>()
  for (const n of input.notes) {
    const t = clipTrack.get(n.clipId)
    if (t) has.add(t)
  }
  return input.tracks
    .filter((t) => t.kind === 'midi' && t.role !== 'click' && has.has(t.id))
    .sort((a, b) => a.order - b.order)
    .map((t) => ({ id: t.id, name: t.name, drums: isDrumTrack(t, input.devices, input.clips) }))
}

/** `show`: track ids to include (others hidden). `width`: the pane's pixel width. */
export function buildScore(input: ScoreInput, opts: { show: ReadonlySet<string>; width: number }): BuiltScore {
  const staffWidth = Math.max(100, opts.width - 20)
  const none: BuiltScore = { abc: '', bars: [], lines: [], ids: [], staffWidth, empty: true }
  const all = scoreTracks(input)
  const flat = new Map<string, FlatTrack>()
  const flatOf = (t: ScoreTrack) => {
    let f = flat.get(t.id)
    if (!f) flat.set(t.id, (f = flattenTrack(input.tracks.find((x) => x.id === t.id)!, t.drums, input)))
    return f
  }
  const shown = all.filter((t) => opts.show.has(t.id)).map(flatOf).filter((f) => f.notes.length)
  if (!shown.length) return none

  const ppq = input.map.ppq
  const endTick = Math.max(...shown.flatMap((f) => f.notes.map((n) => n.tick + n.dur)))
  const bars = buildBars(input.map, endTick, input.markers)

  // the key counts every pitched track, so toggling tracks does not change it
  let key = parseKey(input.key)
  if (!key) {
    const weights = new Array<number>(12).fill(0)
    for (const t of all) if (!t.drums) for (const n of flatOf(t).notes) weights[n.pitch % 12] += n.dur
    key = estimateKey(weights)
  }

  const parts: Part[] = shown.map((f) => {
    if (f.drums) {
      const q = quantizeNotes(f.notes, bars, ppq, { tuplets: false, ends: false })
      const qn: QNote[] = f.notes.map((n, i) => ({ on: q.on[i], end: q.end[i], pitch: n.pitch, noteId: n.noteId }))
      const heads = drumHeads(new Set(f.notes.map((n) => n.pitch)), f.drumNames)
      const [up, down] = drumEvents(qn, heads, bars, ppq)
      return {
        name: f.name,
        staves: [{
          clef: 'perc',
          drums: heads,
          voices: [
            { bars: notateStaff(up, bars, q.windows, ppq, { noTie: true }), hidden: !up.length, stem: 'up' },
            { bars: notateStaff(down, bars, q.windows, ppq, { noTie: true }), hidden: true, stem: 'down' },
          ],
        }],
      }
    }
    const q = quantizeNotes(f.notes, bars, ppq)
    const qn: QNote[] = f.notes.map((n, i) => ({ on: q.on[i], end: q.end[i], pitch: n.pitch, noteId: n.noteId }))
    const staff = (clef: 'treble' | 'bass', ns: QNote[]): Staff => ({ clef, voices: [{ bars: notateStaff(chordEvents(ns.filter((n) => n.on < bars[bars.length - 1].endTick)), bars, q.windows, ppq) }] })
    const clef = chooseClef(f.notes.map((n) => n.pitch))
    if (clef === 'grand') return { name: f.name, staves: [staff('treble', qn.filter((n) => n.pitch >= GRAND_SPLIT)), staff('bass', qn.filter((n) => n.pitch < GRAND_SPLIT))] }
    return { name: f.name, staves: [staff(clef, qn)] }
  })

  const out = emitAbc({ bars, parts, key, ppq, staffWidth })
  return { abc: out.abc, bars: bars.map((b) => ({ bar: b.bar, startTick: b.startTick, endTick: b.endTick })), lines: out.lines, ids: out.ids, staffWidth, empty: false }
}
