// Where a foot press (or a key press) landed on the timeline: the timeline sample the performer *hears* at a given moment.
// The loop commands themselves are audio/loopPedal.ts.

/** A position report from the engine: at context frame `frame` the engine stood at timeline sample `pos`. */
export type PosReport = { pos: number; frame: number }
/** `AudioContext.getOutputTimestamp()`: the context time of the sample at the speaker at `performanceTime` (performance.now clock, ms). */
export type OutputTs = { contextTime: number; performanceTime: number }

/**
 * The timeline sample the performer *hears* at `perfTime` (performance.now clock, ms: a Web MIDI event's `timeStamp`). The
 * output timestamp already accounts for the output latency, so the heard context frame is that of the speaker at `perfTime`,
 * and the engine's report ties context frames to the timeline (the transport runs at one sample per frame, unless it jumped
 * since the report, which is rare and corrected by the next one).
 */
export function heardPosition(r: PosReport, ts: OutputTs, perfTime: number, rate: number): number {
  const heardFrame = (ts.contextTime + (perfTime - ts.performanceTime) / 1000) * rate
  return Math.round(r.pos + (heardFrame - r.frame))
}
