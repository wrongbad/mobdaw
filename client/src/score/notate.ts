// Layer 2c: quantized notes -> printable pieces. Notes with one onset become a chord, overlaps are trimmed, gaps become rests, and every
// event is split per bar into note values (with ties) that respect beats and beat groups, tuplet windows written as 3:2 tuplets.
// Port of the idea in agent/badmidi/lilypond.py `_split`. Pure; one voice per call.
import { groupBounds, type Bar } from './measures'
import { isTuplet, type Win } from './quantize'

export type Head = { pitch: number; noteIds: string[] }
/** A quantized note: absolute ticks. */
export type QNote = { on: number; end: number; pitch: number; noteId: string }
/** Something sounding (or, with no heads, silent) from `start` to `end`. */
export type Ev = { start: number; end: number; heads: Head[] }

export type Piece = {
  /** Absolute tick where it starts (the real time, not the written one). */
  start: number
  /** Written length in ticks: the sounding length, times 3/2 inside a tuplet. */
  len: number
  /** Empty for a rest. */
  heads: Head[]
  /** Tied to the next piece. */
  tie: boolean
  /** Continues a tie from the previous piece (prints no accidental). */
  cont: boolean
  /** On the first piece of a tuplet window: how many pieces it holds. */
  tuplet?: number
  /** A rest that fills the whole bar. */
  whole?: boolean
}

const EPS = 1e-6
const near = (a: number, b: number) => Math.abs(a - b) < EPS
const multiple = (x: number, of: number) => near(x / of, Math.round(x / of))

/** Notes -> events: same onset = one chord ending at its latest end, cut at the next onset. */
export function chordEvents(notes: readonly QNote[]): Ev[] {
  const sorted = [...notes].sort((a, b) => a.on - b.on || a.pitch - b.pitch)
  const evs: Ev[] = []
  for (const n of sorted) {
    const last = evs[evs.length - 1]
    if (last && last.start === n.on) {
      last.end = Math.max(last.end, n.end)
      const h = last.heads.find((x) => x.pitch === n.pitch)
      if (h) h.noteIds.push(n.noteId)
      else last.heads.push({ pitch: n.pitch, noteIds: [n.noteId] })
    } else evs.push({ start: n.on, end: n.end, heads: [{ pitch: n.pitch, noteIds: [n.noteId] }] })
  }
  for (let i = 0; i + 1 < evs.length; i++) evs[i].end = Math.min(evs[i].end, evs[i + 1].start)
  return evs
}

/** Printable lengths (whole .. 32nd, plain and single-dotted), longest first. */
function values(ppq: number) {
  const out: { len: number; base: number; dotted: boolean }[] = []
  for (const x of [4, 2, 1, 0.5, 0.25, 0.125]) {
    out.push({ len: x * ppq, base: x * ppq, dotted: false }, { len: 1.5 * x * ppq, base: x * ppq, dotted: true })
  }
  return out.sort((a, b) => b.len - a.len)
}

/** The next piece length for a run of `rem` ticks starting `p` ticks into its segment: 0 when less than a 32nd is left. */
function greedy(rem: number, p: number, ppq: number): number {
  let fit = 0
  for (const v of values(ppq)) {
    if (v.len > rem + EPS) continue
    if (multiple(p, v.dotted ? v.base : v.base / 2)) return v.len
    fit ||= v.len
  }
  return fit
}

type Span = { start: number; len: number }

/** Split [a, b) of a bar that is not in a tuplet window. */
function splitPlain(a: number, b: number, bar: Bar, ppq: number): Span[] {
  const bounds = groupBounds(bar)
  const beat = bar.free ? ppq : bar.beatTicks
  const printable = (len: number) => values(ppq).some((v) => near(v.len, len))
  const out: Span[] = []
  let pos = a
  while (b - pos > EPS) {
    const gi = bounds.findLastIndex((x) => x <= pos + EPS)
    const gEnd = bounds[Math.min(gi + 1, bounds.length - 1)]
    if (near(bounds[gi], pos)) {
      // starting on a group line, a piece may run over further group lines if it ends on one
      const e = bounds.findLast((x) => x > gEnd + EPS && x <= b + EPS && printable(x - pos))
      if (e !== undefined) {
        out.push({ start: pos, len: e - pos })
        pos = e
        continue
      }
    }
    let end = Math.min(b, gEnd)
    const off = pos - bar.startTick
    if (!multiple(off, beat)) end = Math.min(end, bar.startTick + (Math.floor(off / beat + EPS) + 1) * beat)
    const len = greedy(end - pos, pos - bounds[gi], ppq)
    if (len <= 0) pos = end
    else {
      out.push({ start: pos, len })
      pos += len
    }
  }
  return out
}

/** Split [a, b) of a tuplet window: in written time (x 3/2) from the window's start; lengths come back written. */
function splitTuplet(a: number, b: number, w: Win, ppq: number): Span[] {
  const out: Span[] = []
  const endW = ((b - w.start) * 3) / 2
  let posW = ((a - w.start) * 3) / 2
  while (endW - posW > EPS) {
    const len = greedy(endW - posW, posW, ppq)
    if (len <= 0) break
    out.push({ start: w.start + (posW * 2) / 3, len })
    posW += len
  }
  return out
}

/**
 * Events -> pieces per bar. `windows` are the quantizer's (per bar) and say where tuplets sit. `noTie` (drums) keeps only the first
 * piece of a split note and turns the rest into rests.
 */
export function notateStaff(evs: readonly Ev[], bars: readonly Bar[], windows: readonly Win[][], ppq: number, opts: { noTie?: boolean } = {}): Piece[][] {
  let ei = 0
  return bars.map((bar, bi) => {
    while (ei < evs.length && evs[ei].end <= bar.startTick) ei++
    const parts: { a: number; b: number; ev?: Ev }[] = []
    let cur = bar.startTick
    for (let j = ei; j < evs.length && evs[j].start < bar.endTick; j++) {
      const ev = evs[j]
      const a = Math.max(ev.start, bar.startTick, cur), b = Math.min(ev.end, bar.endTick)
      if (b <= a) continue
      if (a > cur) parts.push({ a: cur, b: a })
      parts.push({ a, b, ev })
      cur = b
    }
    if (cur < bar.endTick) parts.push({ a: cur, b: bar.endTick })
    if (parts.length === 1 && !parts[0].ev) return [{ start: bar.startTick, len: bar.barTicks, heads: [], tie: false, cont: false, whole: true }]

    const wins = windows[bi]
    const cutAt = new Set<number>()
    wins.forEach((w, i) => {
      if (i > 0 && (isTuplet(w) || isTuplet(wins[i - 1]))) cutAt.add(w.start)
    })
    const winOf = (t: number) => wins.find((w) => t >= w.start - EPS && t < w.end - EPS) ?? wins[wins.length - 1]
    const out: Piece[] = []
    const tupFirst = new Map<number, Piece>()
    for (const p of parts) {
      const cuts = [p.a, ...[...cutAt].filter((c) => c > p.a && c < p.b).sort((x, y) => x - y), p.b]
      const made: Piece[] = []
      for (let i = 0; i + 1 < cuts.length; i++) {
        const w = winOf(cuts[i])
        const tup = isTuplet(w)
        const spans = tup ? splitTuplet(cuts[i], cuts[i + 1], w, ppq) : splitPlain(cuts[i], cuts[i + 1], bar, ppq)
        for (const s of spans) {
          const piece: Piece = { start: s.start, len: s.len, heads: p.ev ? p.ev.heads : [], tie: false, cont: false }
          if (tup) {
            const f = tupFirst.get(w.start)
            if (f) f.tuplet = (f.tuplet ?? 1) + 1
            else {
              piece.tuplet = 1
              tupFirst.set(w.start, piece)
            }
          }
          made.push(piece)
        }
      }
      if (p.ev) {
        made.forEach((m, k) => {
          if (opts.noTie && k > 0) m.heads = []
          else {
            m.tie = !opts.noTie && (k < made.length - 1 || p.ev!.end > bar.endTick)
            m.cont = !opts.noTie && (k > 0 || p.ev!.start < bar.startTick)
          }
        })
      }
      out.push(...made)
    }
    return out
  })
}
