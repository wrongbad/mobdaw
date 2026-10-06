// Isolated audio engine. Knows nothing about Yjs: it is handed plain tracks/clips and a buffer lookup.
import type { Clip, Track } from '@mobdaw/shared'

export type Project = { tracks: Track[]; clips: Clip[] }
type Peek = (hash: string) => AudioBuffer | undefined

let ctx: AudioContext | null = null
let master: GainNode
export function getCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    master.connect(ctx.destination)
  }
  return ctx
}

let sources: AudioBufferSourceNode[] = []
let nodes: AudioNode[] = []
let playing = false
let from = 0 // timeline position at ctx time t0
let t0 = 0

function schedule(p: Project, peek: Peek) {
  const c = getCtx()
  const trackGain = new Map<string, GainNode>()
  for (const t of p.tracks) {
    const g = c.createGain()
    g.gain.value = t.muted ? 0 : t.gain
    g.connect(master)
    trackGain.set(t.id, g)
    nodes.push(g)
  }
  t0 = c.currentTime + 0.05
  for (const clip of p.clips) {
    const buf = peek(clip.sampleHash)
    const out = trackGain.get(clip.trackId)
    if (!buf || !out) continue // not decoded yet: skipped
    const skip = Math.max(0, from - clip.start)
    const offset = clip.offset + skip
    const dur = Math.min(clip.duration - skip, buf.duration - offset)
    if (dur <= 0) continue
    const src = c.createBufferSource()
    src.buffer = buf
    const g = c.createGain()
    g.gain.value = clip.gain
    src.connect(g).connect(out)
    src.start(t0 + Math.max(0, clip.start - from), offset, dur)
    sources.push(src)
    nodes.push(g)
  }
}

function halt() {
  for (const s of sources) {
    s.onended = null
    try { s.stop() } catch {}
    s.disconnect()
  }
  for (const n of nodes) n.disconnect()
  sources = []
  nodes = []
}

export const engine = {
  get playing() { return playing },
  /** Timeline position in seconds (frozen while stopped). */
  currentTime(): number {
    return playing ? from + Math.max(0, getCtx().currentTime - t0) : from
  },
  play(fromSec: number, p: Project, peek: Peek) {
    halt()
    void getCtx().resume()
    from = Math.max(0, fromSec)
    playing = true
    schedule(p, peek)
  },
  /** Re-schedule from the current position (call when the doc changes during playback). */
  restart(p: Project, peek: Peek) {
    if (playing) this.play(this.currentTime(), p, peek)
  },
  stop() {
    from = this.currentTime()
    playing = false
    halt()
  },
  seek(sec: number) {
    from = Math.max(0, sec) // only meaningful while stopped; use play() to jump during playback
  },
}
