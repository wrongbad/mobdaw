// Stop on its own (main transport only): past the last clip, nothing to wait for, and the master quiet for a while. Pure: the timeline feeds it.

export const SILENT_PEAK = 3.16e-4 // -70 dBFS, linear
export const SILENT_MS = 500 // quiet this long, so effect tails have rung out
export const GAP_MS = 150 // reports come every ~33 ms while anything sounds; a longer hole is not silence unless the engine said so
export const LIVE_NOTE_MS = 1000 // a live note this recent (or still held) keeps the transport going

/** One master report: when it arrived (ms) and its [l, r] peaks. */
export type MeterSample = { at: number; peak: [number, number] }

export type AutoStopState = {
  now: number // ms, the clock of the samples
  since: number // ms: when the transport started (silence is counted from here at the earliest)
  position: number // playhead, samples
  end: number // the main timeline's content end, samples (0 when empty)
  busy: boolean // a take or loop is recording or closing, or the loop pedal is mid-command
  armed: boolean
  monitoring: boolean
  forever: boolean // some clip repeats without an end
  loopers: boolean // some soundscape looper is sounding
  held: number // live notes held
  noteAt: number // ms of the last live note event (-Infinity: none)
}

const quiet = (s: MeterSample) => s.peak[0] < SILENT_PEAK && s.peak[1] < SILENT_PEAK
// The engine posts silence once (exact zeros) and then nothing, so a hole after a zero report is still silence; after any other report it is unknown.
const zero = (s: MeterSample) => s.peak[0] === 0 && s.peak[1] === 0

/** When the current unbroken quiet stretch began (ms), or null if the master is loud now or the reports have a hole in them. */
export function quietSince(samples: MeterSample[], now: number, since: number): number | null {
  let from: number | null = null
  let prev: MeterSample | null = null
  for (const s of samples) {
    if (!quiet(s)) from = null
    else if (from == null || (prev && s.at - prev.at > GAP_MS && !zero(prev))) from = Math.max(s.at, since)
    prev = s
  }
  if (!prev || from == null) return null
  if (now - prev.at > GAP_MS && !zero(prev)) return null // reports stopped without saying silence
  return from
}

export function shouldAutoStop(st: AutoStopState, samples: MeterSample[]): boolean {
  if (st.position <= st.end) return false
  if (st.busy || st.armed || st.monitoring || st.forever || st.loopers) return false
  if (st.held > 0 || st.now - st.noteAt < LIVE_NOTE_MS) return false
  const q = quietSince(samples, st.now, st.since)
  return q != null && st.now - q >= SILENT_MS
}
