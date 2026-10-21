// Layer 2g: notation hints (`Note.hint`, docs/SCORE-PLAN.md "Notation hints") -> the same pieces `notate.ts` makes from guessed notes. A (track, bar)
// is hinted when every note of the track sounding in it carries a fresh hint; the bar is then written as the hints say (onsets and lengths in exact
// quarters, staves, voices, spelling, articulations, tuplets, tied chains) and nothing is quantized. Any other bar is guessed as before. Pure.
import type { Frac } from '@mobdaw/shared'
import type { FlatNote, FlatTrack } from './flatten'
import type { Bar } from './measures'
import { EPS, greedy, near, splitPlain, type Head, type Piece, type Span } from './notate'
import { parseSpell } from './spell'

/** Ticks of a fraction of a quarter. */
export const fracTicks = (f: Frac, ppq: number) => (f[0] / f[1]) * ppq

const okFrac = (f: Frac | undefined): f is Frac => !!f && Number.isFinite(f[0]) && Number.isFinite(f[1]) && f[1] > 0

/** A hinted note's notated span in absolute ticks, or null when its fractions are unusable (it is then treated as stale). */
export function notatedSpan(n: FlatNote, ppq: number): { start: number; end: number } | null {
  const h = n.fresh
  if (!h || !okFrac(h.hint.on) || !okFrac(h.hint.len) || h.hint.len[0] <= 0) return null
  const start = h.clipStart + fracTicks(h.hint.on, ppq)
  return { start, end: start + fracTicks(h.hint.len, ppq) }
}

/** The 0-based staff a hinted note names, clamped to the staves the track has, and its 1-based voice. */
export const hintStaff = (n: FlatNote, nStaves: number) => Math.max(0, Math.min(nStaves - 1, (n.fresh?.hint.staff ?? 1) - 1))
export const hintVoice = (n: FlatNote) => Math.max(1, Math.floor(n.fresh?.hint.voice ?? 1))

function forBars(bars: readonly Bar[], s: number, e: number, fn: (bi: number) => void) {
  let lo = 0, hi = bars.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (bars[mid].endTick > s + EPS) hi = mid
    else lo = mid + 1
  }
  for (let bi = lo; bi < bars.length && bars[bi].startTick < e - EPS; bi++) fn(bi)
}

/**
 * Which bars are written from hints, and for those the hinted notes drawn in them (their notated span overlaps the bar). A bar is guessed
 * as soon as one note sounding in it (by its performed span, or the notated one if it has a usable fresh hint) has none.
 */
export function hintedBars(f: Pick<FlatTrack, 'uncut'>, bars: readonly Bar[], ppq: number): { hinted: boolean[]; notes: FlatNote[][] } {
  const bad = bars.map(() => false)
  const notes = bars.map((): FlatNote[] => [])
  for (const n of f.uncut) {
    const span = notatedSpan(n, ppq)
    if (span) forBars(bars, span.start, span.end, (bi) => notes[bi].push(n))
    else forBars(bars, n.tick, n.tick + n.dur, (bi) => (bad[bi] = true))
  }
  return { hinted: bars.map((_, bi) => !bad[bi] && notes[bi].length > 0), notes }
}

/** `[staff][voice - 1]` counts: how many voices each staff needs over the hinted bars (at least one). */
export function voiceCounts(nStaves: number, hb: { hinted: boolean[]; notes: FlatNote[][] }): number[] {
  const out = Array.from({ length: nStaves }, () => 1)
  hb.notes.forEach((ns, bi) => {
    if (hb.hinted[bi]) for (const n of ns) out[hintStaff(n, nStaves)] = Math.max(out[hintStaff(n, nStaves)], hintVoice(n))
  })
  return out
}

type Tup = { key: string; n: number; of: number; start: number; end: number }
type HEv = {
  start: number
  end: number
  heads: Head[]
  stac: boolean
  deco: string
  /** The written pieces (actual ticks), if every note of the chord gave the same ones. */
  segs?: number[]
  tup?: Tup
}

const DECO: Record<string, string> = { '>': '!>!', '^': '!marcato!', _: '!tenuto!' }

function tupOf(n: FlatNote, ppq: number): Tup | undefined {
  const t = n.fresh?.hint.tup
  if (!t || !(t.n > 0) || !(t.of > 0) || !okFrac(t.start) || !okFrac(t.span) || t.span[0] <= 0) return undefined
  const start = n.fresh!.clipStart + fracTicks(t.start, ppq)
  const end = start + fracTicks(t.span, ppq)
  return { key: `${t.n}:${t.of}:${start.toFixed(4)}:${end.toFixed(4)}`, n: t.n, of: t.of, start, end }
}

function segsOf(n: FlatNote, ppq: number, len: number): number[] | undefined {
  const segs = n.fresh?.hint.segs
  if (!segs?.length || !segs.every(okFrac)) return undefined
  const t = segs.map((s) => fracTicks(s, ppq))
  return t.every((x) => x > 0) && near(t.reduce((a, b) => a + b, 0), len) ? t : undefined
}

/** One voice's notes -> events: the same onset is one chord, and an event ends where the next begins. */
function voiceEvents(ns: readonly FlatNote[], ppq: number): HEv[] {
  const items = ns.map((n) => ({ n, ...notatedSpan(n, ppq)! })).sort((a, b) => a.start - b.start || a.n.pitch - b.n.pitch)
  const evs: (HEv & { members: FlatNote[] })[] = []
  for (const it of items) {
    const art = it.n.fresh!.hint.art ?? ''
    const last = evs[evs.length - 1]
    if (last && near(last.start, it.start)) {
      last.end = Math.max(last.end, it.end)
      last.members.push(it.n)
      const h = last.heads.find((x) => x.pitch === it.n.pitch)
      if (h) h.noteIds.push(it.n.noteId)
      else last.heads.push({ pitch: it.n.pitch, noteIds: [it.n.noteId], spell: parseSpell(it.n.fresh!.hint.spell, it.n.pitch) })
      last.stac ||= art.includes("'")
      for (const c of art) if (DECO[c] && !last.deco.includes(DECO[c])) last.deco += DECO[c]
      continue
    }
    evs.push({
      start: it.start,
      end: it.end,
      heads: [{ pitch: it.n.pitch, noteIds: [it.n.noteId], spell: parseSpell(it.n.fresh!.hint.spell, it.n.pitch) }],
      stac: art.includes("'"),
      deco: [...art].map((c) => DECO[c] ?? '').filter((x, i, a) => x && a.indexOf(x) === i).join(''),
      tup: tupOf(it.n, ppq),
      members: [it.n],
    })
  }
  for (let i = 0; i + 1 < evs.length; i++) evs[i].end = Math.min(evs[i].end, evs[i + 1].start)
  return evs.map(({ members, ...e }) => {
    const first = segsOf(members[0], ppq, e.end - e.start)
    const same = first && members.every((m) => JSON.stringify(m.fresh!.hint.segs) === JSON.stringify(members[0].fresh!.hint.segs))
    return same ? { ...e, segs: first } : e
  })
}

/** Split [a, b) of a tuplet span: in written time (x n/of) from the span's start; lengths come back written. */
function splitSpan(a: number, b: number, t: Tup, ppq: number): Span[] {
  const out: Span[] = []
  const endW = ((b - t.start) * t.n) / t.of
  let posW = ((a - t.start) * t.n) / t.of
  while (endW - posW > EPS) {
    const len = greedy(endW - posW, posW, ppq)
    if (len <= 0) break
    out.push({ start: t.start + (posW * t.of) / t.n, len })
    posW += len
  }
  return out
}

type KPiece = { p: Piece; tup?: Tup }

/** [a, b) as spans of printable values: inside a tuplet span at its ratio, elsewhere by the bar's beats. */
function fill(a: number, b: number, spans: readonly Tup[], bar: Bar, ppq: number): { s: Span; tup?: Tup }[] {
  const cuts = [a, ...spans.flatMap((t) => [t.start, t.end]).filter((c) => c > a + EPS && c < b - EPS).sort((x, y) => x - y), b]
  const out: { s: Span; tup?: Tup }[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    if (cuts[i + 1] - cuts[i] <= EPS) continue
    const t = spans.find((x) => cuts[i] >= x.start - EPS && cuts[i + 1] <= x.end + EPS)
    for (const s of t ? splitSpan(cuts[i], cuts[i + 1], t, ppq) : splitPlain(cuts[i], cuts[i + 1], bar, ppq)) out.push({ s, tup: t })
  }
  return out
}

/** The pieces of one event within one bar. */
function eventPieces(ev: HEv, bar: Bar, ppq: number, spans: readonly Tup[]): KPiece[] {
  const a = Math.max(ev.start, bar.startTick), b = Math.min(ev.end, bar.endTick)
  if (b - a <= EPS) return []
  const mk = (s: Span, tup: Tup | undefined, first: boolean, cont: boolean, tie: boolean): KPiece => {
    const p: Piece = { start: s.start, len: s.len, heads: ev.heads, tie, cont }
    if (first) {
      if (ev.stac) p.stac = true
      if (ev.deco) p.deco = ev.deco
    }
    return { p, tup }
  }
  // the written pieces of a tied chain, verbatim, unless one of them crosses a bar line
  if (ev.segs) {
    let pos = ev.start
    const placed = ev.segs.map((len) => {
      const at = pos
      pos += len
      return { at, len }
    })
    if (placed.every((s) => !(s.at < bar.startTick - EPS && s.at + s.len > bar.startTick + EPS) && !(s.at < bar.endTick - EPS && s.at + s.len > bar.endTick + EPS))) {
      const mine = placed.map((s, i) => ({ ...s, i })).filter((s) => s.at >= bar.startTick - EPS && s.at < bar.endTick - EPS)
      return mine.map((s) => {
        const written = ev.tup ? (s.len * ev.tup.n) / ev.tup.of : s.len
        return mk({ start: s.at, len: written }, ev.tup, s.i === 0, s.i > 0, s.i < placed.length - 1)
      })
    }
  }
  const made = fill(a, b, spans, bar, ppq)
  return made.map((m, k) => mk(m.s, m.tup, k === 0 && ev.start >= bar.startTick - EPS, k > 0 || ev.start < bar.startTick - EPS, k < made.length - 1 || ev.end > bar.endTick + EPS))
}

/** One voice's bar: its events, rests in the gaps (inside a tuplet span at the span's ratio) and tuplet marks on the first piece of each group. */
function voiceBar(evs: readonly HEv[], bar: Bar, ppq: number): Piece[] {
  const mine = evs.filter((e) => e.start < bar.endTick - EPS && e.end > bar.startTick + EPS)
  const spans = [...new Map(mine.flatMap((e) => (e.tup ? [e.tup] : [])).map((t) => [t.key, t])).values()]
  const out: KPiece[] = []
  let cur = bar.startTick
  const rest = (a: number, b: number) => {
    for (const m of fill(a, b, spans, bar, ppq)) out.push({ p: { start: m.s.start, len: m.s.len, heads: [], tie: false, cont: false }, tup: m.tup })
  }
  for (const e of mine) {
    const a = Math.max(e.start, bar.startTick)
    if (a > cur + EPS) rest(cur, a)
    out.push(...eventPieces(e, bar, ppq, spans))
    cur = Math.max(cur, Math.min(e.end, bar.endTick))
  }
  if (cur < bar.endTick - EPS) rest(cur, bar.endTick)
  let group: { key: string; first: Piece; count: number } | null = null
  for (const { p, tup } of out) {
    if (!tup) {
      group = null
      continue
    }
    if (group && group.key === tup.key) group.first.tuplet = ++group.count
    else {
      p.tuplet = 1
      p.ratio = { n: tup.n, of: tup.of }
      group = { key: tup.key, first: p, count: 1 }
    }
  }
  return out.map((k) => k.p)
}

/** The rest that fills a bar; `hide`: not drawn (a voice with nothing in the bar, other than the first). */
export const wholeRest = (bar: Bar, hide: boolean): Piece => ({ start: bar.startTick, len: bar.barTicks, heads: [], tie: false, cont: false, whole: true, ...(hide ? { hide: true } : {}) })

/**
 * Pieces of a hinted bar for `[staff][voice - 1]`. `voices` is how many voices each staff has; a voice with no note in the bar is a whole-bar
 * rest, drawn in voice 1 and invisible (`x`) in the others.
 */
export function hintedBar(notes: readonly FlatNote[], bar: Bar, ppq: number, voices: readonly number[]): Piece[][][] {
  const by = new Map<string, FlatNote[]>()
  for (const n of notes) {
    const k = `${hintStaff(n, voices.length)}:${Math.min(hintVoice(n), voices[hintStaff(n, voices.length)])}`
    by.set(k, [...(by.get(k) ?? []), n])
  }
  return voices.map((count, s) =>
    Array.from({ length: count }, (_, v) => {
      const ns = by.get(`${s}:${v + 1}`)
      return ns ? voiceBar(voiceEvents(ns, ppq), bar, ppq) : [wholeRest(bar, v > 0)]
    }),
  )
}
