// Layer 2b: snap performed times to notation. A port of badmidi's per-beat quantizer (agent/badmidi/ingest.py `_Quantizer`) in ticks:
// each quarter-note window of a bar picks the coarsest division of the quarter that every onset in it already sits on;
// if none fits, 16ths or eighth triplets, whichever is closer. Note ends never vote (a staccato 32nd on a 16th grid is a 16th note
// with a rest, as a notation program writes it); they are rounded up to the grid of the window they end in, see `roundEnd`. Pure.
import type { Bar } from './measures'

/** One quarter note of a bar (the last may be short) and how it is divided: `div` steps per quarter. 3 and 6 are triplets. */
export type Win = { start: number; end: number; div: number }
export const isTuplet = (w: Win) => w.div === 3 || w.div === 6

export type Timed = { tick: number; dur: number }
export type Quantized = {
  /** Snapped onsets and ends, in the order of the input notes. */
  on: number[]
  end: number[]
  /** Per bar. */
  windows: Win[][]
  /** Per note: performed clearly shorter than written, and written as a quarter or shorter (see STACCATO_RATIO). */
  stac: boolean[]
}
export type QuantizeOpts = {
  /** Allow triplet windows (default true). */
  tuplets?: boolean
}

/** A note is staccato when performed length / written length is at most this and the written length is a quarter or shorter. */
export const STACCATO_RATIO = 0.6
/** An end this close (ticks per 1/16 quarter) above a grid line stays on it instead of rounding up to the next one. */
const roundTol = (ppq: number) => ppq / 16
/** An end this close (ticks, 1/8 quarter) before the next onset in the voice is legato: it goes to that onset. */
const legatoTol = (ppq: number) => ppq / 8

const DIVS = [1, 2, 3, 4, 6, 8]

/** The divisions a bar may use: none finer than 32nds, no tuplets in eighth-note meters, only halves in free bars. */
function allowed(bar: Bar, tuplets: boolean): number[] {
  if (bar.free) return [1, 2]
  if (bar.den >= 8 || !tuplets) return [1, 2, 4, 8]
  return DIVS
}

/** The window's grid point nearest to `t`, at most the window's end. */
function snapIn(t: number, w: Win, ppq: number, div: number): number {
  const step = ppq / div
  return Math.min(w.end, Math.round(w.start + Math.round((t - w.start) / step) * step))
}

function pickDiv(points: number[], w: Win, ppq: number, divs: number[]): number {
  const tol = Math.max(1, ppq / 960)
  const err = (d: number) => points.reduce((s, t) => s + Math.abs(t - snapIn(t, w, ppq, d)), 0)
  for (const d of divs) if (points.every((t) => Math.abs(t - snapIn(t, w, ppq, d)) <= tol)) return d
  if (divs.includes(3)) return err(3) < err(4) ? 3 : 4
  return divs.includes(4) ? 4 : divs[divs.length - 1]
}

export function quantizeNotes(notes: readonly Timed[], bars: readonly Bar[], ppq: number, opts: QuantizeOpts = {}): Quantized {
  const tuplets = opts.tuplets ?? true
  const windows: Win[][] = bars.map((b) => {
    const ws: Win[] = []
    for (let t = b.startTick; t < b.endTick - 1e-6; t += ppq) ws.push({ start: t, end: Math.min(t + ppq, b.endTick), div: 1 })
    return ws
  })
  const points = windows.map((ws) => ws.map((): number[] => []))
  const total = bars.length ? bars[bars.length - 1].endTick : 0
  /** [bar index, window index] holding tick t, or null outside the bars. */
  const locate = (t: number): [number, number] | null => {
    if (!bars.length || t >= total) return null
    let lo = 0, hi = bars.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (bars[mid].startTick <= t) lo = mid
      else hi = mid - 1
    }
    const wi = Math.min(windows[lo].length - 1, Math.max(0, Math.floor((t - bars[lo].startTick) / ppq + 1e-9)))
    return [lo, wi]
  }
  /** Ends in windows with no onset: they vote only there, so a note ending off the beat in an empty window keeps its end. */
  const endPoints = windows.map((ws) => ws.map((): number[] => []))
  for (const n of notes) {
    const a = locate(n.tick)
    if (a) points[a[0]][a[1]].push(n.tick)
    const e = locate(n.tick + n.dur)
    if (e) endPoints[e[0]][e[1]].push(n.tick + n.dur)
  }
  for (let bi = 0; bi < bars.length; bi++) {
    const divs = allowed(bars[bi], tuplets)
    windows[bi].forEach((w, wi) => (w.div = pickDiv(points[bi][wi].length ? points[bi][wi] : endPoints[bi][wi], w, ppq, divs)))
  }
  const snap = (t: number): { t: number; step: number } => {
    const at = locate(t)
    if (!at) return { t, step: ppq / 4 }
    const w = windows[at[0]][at[1]]
    return { t: snapIn(t, w, ppq, w.div), step: ppq / w.div }
  }
  /**
   * The grid an end in window [bi][wi] rounds to: the window's own division, or the finest plain division of its neighbours (a voice
   * that has one onset in a window of a 16th passage still writes 16ths, not an eighth). Triplet windows keep their own.
   */
  const endDiv = (bi: number, wi: number): number => {
    const own = windows[bi][wi].div
    if (isTuplet(windows[bi][wi])) return own
    const prev = wi > 0 ? windows[bi][wi - 1] : bi > 0 ? windows[bi - 1].at(-1) : undefined
    const next = wi + 1 < windows[bi].length ? windows[bi][wi + 1] : windows[bi + 1]?.[0]
    return Math.max(own, ...[prev, next].filter((x): x is Win => !!x && !isTuplet(x)).map((x) => x.div))
  }
  /** `t` rounded up to its window's end grid (a little above a grid line stays on it), and that grid's step. */
  const roundEnd = (t: number): number => {
    const at = locate(t)
    if (!at) return t
    const w = windows[at[0]][at[1]]
    const step = ppq / endDiv(at[0], at[1])
    return Math.min(w.end, Math.round(w.start + Math.ceil((t - w.start - roundTol(ppq)) / step) * step))
  }
  const on = notes.map((n) => snap(n.tick))
  const onsets = [...new Set(on.map((a) => a.t))].sort((x, y) => x - y)
  /** The first snapped onset after `t` (in the voice: the whole track), or Infinity. */
  const nextOnset = (t: number): number => {
    let lo = 0, hi = onsets.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (onsets[mid] > t + 1e-6) hi = mid
      else lo = mid + 1
    }
    return onsets[lo] ?? Infinity
  }
  const end: number[] = []
  const stac: boolean[] = []
  notes.forEach((n, i) => {
    const a = on[i]
    const next = nextOnset(a.t)
    const pe = n.tick + n.dur
    const at = locate(a.t)
    const minStep = at ? ppq / endDiv(at[0], at[1]) : a.step
    let e = Math.max(roundEnd(pe), a.t + minStep)
    e = Math.min(e, next)
    if (next - pe <= legatoTol(ppq)) e = next
    e = Math.min(e, Math.max(total, a.t))
    if (e <= a.t) e = a.t + a.step
    end.push(e)
    stac.push(n.dur / (e - a.t) <= STACCATO_RATIO && e - a.t <= ppq + 1e-6)
  })
  return { on: on.map((a) => a.t), end, windows, stac }
}
