// Layer 2f: drum tracks on a one-line-per-sound percussion staff. Each key gets a staff position and head from its drum's name; the
// kick goes down-stemmed in voice 2, everything else up-stemmed in voice 1. A drum note has no length on the page: it lasts until the
// next hit in its voice, at most to the next beat line. Pure.
import { beatLines, type Bar } from './measures'
import { chordEvents, type Ev, type QNote } from './notate'

/** `pos` is an ABC pitch letter (read on the percussion staff like a treble staff: F bottom space, c third space, g above the top line). */
export type DrumHead = { pos: string; x: boolean; open: boolean; kick: boolean }

const KICK_KEY = 36
/** Positions for drums with no known name, in key order. */
const FREE_POS = ['B', 'd', 'A', 'E']

/** The head for a drum name, or null when the name says nothing. */
function classify(name: string): DrumHead | null {
  const n = name.toLowerCase()
  const head = (pos: string, x = false, open = false, kick = false): DrumHead => ({ pos, x, open, kick })
  if (/kick|\bbd\b|bass/.test(n)) return head('F', false, false, true)
  if (/hat|\bhh\b|\boh\b/.test(n)) return head('g', true, /open|\boh\b/.test(n))
  if (/snare|\bsd\b/.test(n)) return head('c')
  if (/rim/.test(n)) return head('c', true)
  if (/clap/.test(n)) return head('e', true)
  if (/tom/.test(n)) return head(/low|floor/.test(n) ? 'A' : 'e')
  if (/crash|ride|cymbal/.test(n)) return head('a', true)
  if (/perc/.test(n)) return head('B')
  return null
}

/** Heads for the drum keys in use (`names`: key -> device name; an unnamed key 36 is the kick). */
export function drumHeads(keys: Iterable<number>, names: ReadonlyMap<number, string>): Map<number, DrumHead> {
  const sorted = [...new Set(keys)].sort((a, b) => a - b)
  const out = new Map<number, DrumHead>()
  const unknown: number[] = []
  for (const k of sorted) {
    const name = names.get(k)
    const h = name ? classify(name) : k === KICK_KEY ? classify('kick') : null
    if (h) out.set(k, h)
    else unknown.push(k)
  }
  const used = new Set([...out.values()].map((h) => h.pos))
  const free = FREE_POS.filter((p) => !used.has(p))
  const pool = free.length ? free : FREE_POS
  unknown.forEach((k, i) => out.set(k, { pos: pool[i % pool.length], x: false, open: false, kick: false }))
  return out
}

/** The two voices' events: [0] up-stemmed (everything but the kick), [1] down-stemmed (the kick). */
export function drumEvents(notes: readonly QNote[], heads: ReadonlyMap<number, DrumHead>, bars: readonly Bar[], ppq: number): [Ev[], Ev[]] {
  const total = bars.length ? bars[bars.length - 1].endTick : 0
  const voice = (ns: QNote[]): Ev[] => {
    const evs = chordEvents(ns.filter((n) => n.on < total))
    return evs.map((e, i) => {
      const bar = bars.findLast((b) => b.startTick <= e.start)!
      const line = beatLines(bar, ppq).find((t) => t > e.start + 1e-6) ?? bar.endTick
      return { start: e.start, end: Math.min(evs[i + 1]?.start ?? Infinity, line), heads: e.heads }
    })
  }
  return [voice(notes.filter((n) => !heads.get(n.pitch)?.kick)), voice(notes.filter((n) => heads.get(n.pitch)?.kick))]
}
