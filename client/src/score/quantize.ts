// Layer 2b: snap performed times to notation. A port of badmidi's per-beat quantizer (agent/badmidi/ingest.py `_Quantizer`) in ticks:
// each quarter-note window of a bar picks the coarsest division of the quarter that every onset and end in it already sits on;
// if none fits, 16ths or eighth triplets, whichever is closer. Pure.
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
}
export type QuantizeOpts = {
  /** Allow triplet windows (default true). */
  tuplets?: boolean
  /** Let note ends vote for a window's division (default true; drums have no length). */
  ends?: boolean
}

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
  const useEnds = opts.ends ?? true
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
  for (const n of notes) {
    const a = locate(n.tick)
    if (a) points[a[0]][a[1]].push(n.tick)
    if (useEnds) {
      const e = locate(n.tick + n.dur)
      if (e) points[e[0]][e[1]].push(n.tick + n.dur)
    }
  }
  for (let bi = 0; bi < bars.length; bi++) {
    const divs = allowed(bars[bi], tuplets)
    windows[bi].forEach((w, wi) => (w.div = pickDiv(points[bi][wi], w, ppq, divs)))
  }
  const snap = (t: number): { t: number; step: number } => {
    const at = locate(t)
    if (!at) return { t, step: ppq / 4 }
    const w = windows[at[0]][at[1]]
    return { t: snapIn(t, w, ppq, w.div), step: ppq / w.div }
  }
  const on: number[] = []
  const end: number[] = []
  for (const n of notes) {
    const a = snap(n.tick)
    let e = snap(n.tick + n.dur).t
    if (e <= a.t) e = a.t + a.step
    on.push(a.t)
    end.push(Math.min(e, Math.max(total, a.t)))
  }
  return { on, end, windows }
}
