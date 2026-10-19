// Host-side baking of MIDI for the engine (docs/engine.md §2, option (a)): every note becomes absolute timeline samples, converted from
// its absolute tick through the project's time map (each event rounded once), so a tempo ramp or a region boundary anywhere in a clip, or
// under a looping pattern, lands exactly where `map.tickToSample` puts it. The engine then runs its per-clip tick clock at one tick per
// sample (`ENGINE_BPM`, `ENGINE_PPQ`), where its own conversion is the identity.
import { foreverTicks, isForever, isLooping, patternTicks, type MidiClip, type Note, type TimeMap } from '@mobdaw/shared'
import { clickEvents } from './click'

/** Engine clip clock for baked clips: `bpm * ppq = 60 * rate`, so `start + round(tick * 60 * rate / (bpm * ppq)) = start + tick` (exact in f64 for integer ticks). */
export const ENGINE_PPQ = 1
export const engineBpm = (rate: number) => 60 * rate

/** The slice of the timeline that is baked: `[lo, hi)` in samples. Notes starting outside it are left out. */
export type Window = { lo: number; hi: number }

/** An engine note: `tick` is samples from the engine clip's start, `dur` samples. */
export type BakedNote = { tick: number; dur: number; pitch: number; velocity: number }
export type BakedClip = {
  /** The engine clip's `start` and its length in samples (the clip's true end, a forever clip's 24 hours). */
  start: number
  length: number
  /** Engine notes by a stable key (`<noteId>|<pass>`), so a re-bake can send only what changed. */
  notes: Map<string, BakedNote>
}

/**
 * A MIDI clip's notes as engine notes within the window. A looping clip is unrolled: pass `k` plays the pattern's notes from tick
 * `startTick + k * passTicks`, each converted from its own absolute tick. A note ends at the earliest of its own end, the end of its pass
 * (when looping) and the clip's end; a note at or after the clip end, or before its start, never plays. Bounded by the window: passes
 * past `hi` are not visited (a `forever` clip is 24 hours long), and the first pass visited is found by arithmetic, not by walking.
 */
export function bakeClip(map: TimeMap, c: Pick<MidiClip, 'startTick' | 'lengthTicks' | 'loopTicks' | 'forever'>, notes: Iterable<Note>, w: Window): BakedClip {
  const start = map.tickToSample(c.startTick)
  const looping = isLooping(c)
  const endTick = c.startTick + (isForever(c) ? Math.max(c.lengthTicks, foreverTicks(map, c.startTick)) : c.lengthTicks)
  const end = map.tickToSample(endTick)
  const out = new Map<string, BakedNote>()
  if (!(c.lengthTicks > 0) || !Number.isFinite(c.startTick)) return { start, length: Math.max(0, end - start), notes: out }
  const pass = patternTicks(c)
  const list = [...notes].filter((n) => n.tick >= 0 && Number.isFinite(n.tick) && Number.isFinite(n.durTicks))
  const passes = looping ? Math.ceil((endTick - c.startTick) / pass) : 1
  const k0 = looping ? Math.min(passes, Math.max(0, Math.floor((map.sampleToTick(Math.max(0, w.lo)) - c.startTick) / pass) - 1)) : 0
  for (let k = k0; k < passes; k++) {
    const origin = c.startTick + k * pass
    if (map.tickToSample(origin) >= w.hi) break
    for (const n of list) {
      if (looping ? n.tick >= pass : n.tick >= c.lengthTicks) continue
      const tick = origin + n.tick
      if (tick >= endTick) continue
      const on = map.tickToSample(tick)
      if (on < w.lo || on >= w.hi || on >= end) continue
      let stop = tick + Math.max(0, n.durTicks)
      if (looping) stop = Math.min(stop, origin + pass)
      const off = Math.min(map.tickToSample(stop), end)
      out.set(`${n.id}|${k}`, { tick: on - start, dur: Math.max(1, off - on), pitch: n.pitch, velocity: n.velocity })
    }
  }
  return { start, length: Math.max(0, end - start), notes: out }
}

/** The click track's engine clip: it starts at sample 0 and covers the window, with `clickEvents` as its notes (key `click|<tick>|<pitch>`). */
export function bakeClick(map: TimeMap, w: Window): BakedClip {
  const notes = new Map<string, BakedNote>()
  for (const e of clickEvents(map, Math.max(0, w.lo), w.hi)) notes.set(`click|${e.tick}|${e.pitch}`, { tick: e.sample, dur: e.dur, pitch: e.pitch, velocity: e.velocity })
  return { start: 0, length: Math.max(0, w.hi), notes }
}
