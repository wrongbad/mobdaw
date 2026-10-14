// Loop commands (docs/engine.md §9.2): record / mute / previous track / next track, from keys or a foot switch. The timeline is
// the performance record: the transport keeps rolling and every command is written into the doc at the timeline sample where
// it was heard, so playing the song from 0 reproduces the performance. A loop is an ordinary audio clip with `forever`; a mute
// is a step in the track's volume automation. Pure of the browser: positions come in as numbers and the recorder and engine are
// behind `LoopIO`, so the whole thing is tested with a fake clock (client/test/loopPedal.test.ts).
import {
  addAudioClip, addLane, addPoint, addTrack, deleteClip, ensureMixDevice, evalPoints, getClips, getLanes, getMixDevice, getPoints, getTracks, MIX_GAIN, nextTrackColor, paramToPos, resolveTarget,
  updateClip, updatePoint, updateTrack, type AudioClip, type ParamTarget,
} from '@mobdaw/shared'
import type * as Y from 'yjs'

export type Cmd = 'record' | 'mute' | 'prev' | 'next'
export const CMDS: Cmd[] = ['record', 'mute', 'prev', 'next']
export const CMD_LABELS: Record<Cmd, string> = { record: 'loop record', mute: 'mute track', prev: 'previous track', next: 'next track' }

/** A first loop shorter than this is a bounced switch, not a loop. */
export const MIN_LOOP_S = 0.25
/** A take runs this much past the last frame a loop needs (seconds), so the engine's block granularity never cuts it short. */
export const TAIL_S = 0.05

/** Boundaries at `origin + k * period` (samples), k >= 0: the cycle every loop snaps to. */
export type Grid = { origin: number; period: number }

/** The first boundary at or after `t` (the origin before it). */
export function nextBoundary(t: number, g: Grid): number {
  if (t <= g.origin) return g.origin
  return g.origin + Math.ceil((t - g.origin) / g.period) * g.period
}

/** Audio clips that loop (a pass shorter than the extent, or a forever clip that was ended). */
const loopClips = (doc: Y.Doc) => getClips(doc).filter((c): c is AudioClip => c.kind === 'audio' && !!c.loopLength && c.loopLength > 0)

/** The cycle: the earliest loop's start on the timeline and its pass. Null while the project has no audio loop (the next one is free length). */
export function cycleGrid(doc: Y.Doc): Grid | null {
  const first = loopClips(doc).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1))[0]
  return first ? { origin: first.start, period: first.loopLength! } : null
}

/** The audio tracks the commands walk through (the click track is not one). */
export const audioTracks = (doc: Y.Doc) => getTracks(doc).filter((t) => t.kind === 'audio' && t.role !== 'click')

/**
 * End the loops playing on `trackId` at timeline sample `at`: a loop that started earlier stops exactly there (forever off,
 * extent cut), so its history stays on the timeline; one that starts at or after `at` is replaced outright. Returns whether
 * anything changed.
 */
export function endLoopsAt(doc: Y.Doc, trackId: string, at: number): boolean {
  const hit = loopClips(doc).filter((c) => c.trackId === trackId && (c.start === at || (c.start < at && (c.forever || c.start + c.length > at))))
  if (!hit.length) return false
  doc.transact(() => {
    for (const c of hit) {
      if (c.start >= at) deleteClip(doc, c.id)
      else updateClip(doc, c.id, { length: at - c.start, fadeOut: 0, forever: false })
    }
  })
  return true
}

/** What a finished loop take becomes: where it starts on the timeline, its pass, and the take's timeline start. */
export type LoopTake = { trackId: string; start: number; pass: number; recstart: number; latency: number; undoDepth: number | null }

/** Frame of the take where the loop's pass begins: what the performer played at timeline `start` sits `latency` frames later. */
export const loopOffset = (t: Pick<LoopTake, 'start' | 'recstart' | 'latency'>) => Math.max(0, t.start - t.recstart + t.latency)

/** The doc clip of a finished loop: a plain audio clip at its start, looping forever. Call inside the take's transaction. */
export function commitLoop(doc: Y.Doc, t: LoopTake, trackId: string, sourceHash: string): string {
  return addAudioClip(doc, { trackId, sourceHash, start: t.start, length: t.pass * 2, sourceOffset: loopOffset(t), loopLength: t.pass, forever: true })
}

// --- mute: volume automation
const volumeTarget = (doc: Y.Doc, trackId: string): ParamTarget => ({ scope: trackId, kind: 'effect', owner: ensureMixDevice(doc, trackId), param: String(MIX_GAIN) })
const sorted = (doc: Y.Doc, laneId: string) => getPoints(doc).filter((p) => p.laneId === laneId).sort((a, b) => a.pos - b.pos)
/** The mute's ramp (seconds): a linear fade over the step, so it does not click. */
export const RAMP_S = 0.005
/** Normalised values at or below this are silence. */
const SILENT = 1e-6

/**
 * Toggle the track's mute at timeline sample `pos`, as a step in the volume automation (one transaction): a mute ramps to 0 over 5 ms
 * from `pos`, an unmute ramps back to the volume that was there before. The lane is made on the first use, flat at the track's volume. Not
 * quantized. Returns what the track is now.
 */
export function toggleMute(doc: Y.Doc, trackId: string, pos: number, rate: number): 'muted' | 'unmuted' {
  const ramp = Math.max(1, Math.round(RAMP_S * rate))
  let result: 'muted' | 'unmuted' = 'muted'
  doc.transact(() => {
    const target = volumeTarget(doc, trackId)
    const r = resolveTarget(doc, target)
    if (!r) return
    const lane = addLane(doc, target, r.def)
    let pts = sorted(doc, lane)
    if (!pts.length) {
      addPoint(doc, lane, 0, paramToPos(r.def, r.value), 'hold')
      pts = sorted(doc, lane)
    }
    const at = Math.max(0, Math.round(pos))
    const now = evalPoints(pts, at) ?? 0
    const muted = now <= SILENT
    const before = pts.filter((p) => p.pos < at)
    const prior = [...before].reverse().find((p) => p.value > SILENT)?.value ?? paramToPos(r.def, r.value)
    const value = muted ? (prior > SILENT ? prior : paramToPos(r.def, 1)) : 0
    // a linear segment into the step would ramp towards it: pin the value just before, so the curve up to `at` is unchanged
    const prev = before.at(-1)
    if (prev && prev.curve === 'linear' && at >= 1 && !pts.some((p) => p.pos === at - 1)) addPoint(doc, lane, at - 1, now, 'hold')
    // from the current value at `at`, linearly to the target one ramp later, where it holds
    const put = (pos: number, v: number, curve: 'linear' | 'hold') => {
      const same = pts.find((p) => p.pos === pos)
      if (same) updatePoint(doc, same.id, { value: v, curve })
      else addPoint(doc, lane, pos, v, curve)
    }
    put(at, now, 'linear')
    put(at + ramp, value, 'hold')
    result = muted ? 'unmuted' : 'muted'
  })
  return result
}

/** The volume (as a gain, 0 when muted) a track has at timeline sample `pos` according to its automation, or null with no lane. */
export function volumeAt(doc: Y.Doc, trackId: string, pos: number): number | null {
  const lane = getLanes(doc).find((l) => l.scope === trackId && l.owner === getMixDevice(doc, trackId)?.id && l.param === String(MIX_GAIN))
  if (!lane) return null
  const v = evalPoints(sorted(doc, lane.id), pos)
  return v == null ? null : v * 2
}

// --- the state machine
/** What the commands need from the browser: the transport, the recorder and the engine. */
export interface LoopIO {
  playing(): boolean
  /** Start the transport from the playhead; the position the next press reports must be the playhead. */
  play(): void
  /** Start the take on `trackId` (the normal recording path, into a live source). False when it can't (the message says why). */
  beginTake(trackId: string): boolean
  /** The stop press: the loop `t` will start sounding from the live source at its boundary. */
  liveLoop(t: LoopTake): void
  /** The take has run past the loop's last frame: stop and save it (the doc clip is `commitLoop`). */
  endTake(t: LoopTake): void
  /** The recording was cancelled before it began to count. */
  cancelTake(): void
  say(msg: string): void
}

type Rec = { trackId: string; start: number; grid: Grid | null; recstart?: number; end?: number; pass?: number; undoDepth: number | null }

export class LoopPedal {
  /** The current track: where record and mute act, which prev/next move. */
  current: string | null = null
  private rec: Rec | null = null

  constructor(private d: { doc: Y.Doc; rate: number; io: LoopIO; undo?: Y.UndoManager; latency(): number }) {}

  get recording() { return !!this.rec }
  /** The take's timeline start, once the recorder reports it. */
  tookAt(recstart: number) { if (this.rec) this.rec.recstart = recstart }

  /** For the status line: how far to the loop's next edge, in samples (or how long it has run, for the free-length first loop). */
  status(pos: number): { stopping: boolean; samples: number; free: boolean } | null {
    const r = this.rec
    if (!r) return null
    if (r.end != null) return { stopping: true, samples: Math.max(0, r.end - pos), free: false }
    if (pos < r.start) return { stopping: false, samples: r.start - pos, free: false }
    return r.grid ? { stopping: false, samples: nextBoundary(pos, r.grid) - pos, free: false } : { stopping: false, samples: pos - r.start, free: true }
  }

  /** The transport stopped or the take ended on its own: forget the loop (a normal take was saved). */
  reset() { this.rec = null }

  private tracks() { return audioTracks(this.d.doc) }
  private stopGroup() { this.d.undo?.stopCapturing() }

  /** `pos`: the timeline sample the press was heard at (the playhead, when the transport is stopped). */
  press(cmd: Cmd, pos: number) {
    if (cmd === 'record') this.record(pos)
    else if (cmd === 'mute') this.mute(pos)
    else this.step(cmd === 'next' ? 1 : -1)
  }

  private step(dir: 1 | -1) {
    const { doc } = this.d
    const ts = this.tracks()
    const i = ts.findIndex((t) => t.id === this.current)
    if (dir > 0 && i === ts.length - 1 && ts.length) {
      this.stopGroup()
      this.current = addTrack(doc, `track ${getTracks(doc).length + 1}`, 'audio', undefined, undefined, nextTrackColor(getTracks(doc)))
      this.stopGroup()
    } else this.current = ts[Math.min(ts.length - 1, Math.max(0, i + dir))]?.id ?? null
  }

  private mute(pos: number) {
    const { doc } = this.d
    if (!this.current || !this.tracks().some((t) => t.id === this.current)) this.current = this.tracks()[0]?.id ?? null
    const id = this.current
    if (!id) return this.d.io.say('mute: there is no track')
    this.stopGroup()
    if (this.d.io.playing()) toggleMute(doc, id, pos, this.d.rate)
    else updateTrack(doc, id, { muted: !getTracks(doc).find((t) => t.id === id)?.muted }) // stopped: nothing to record, the plain mute
    this.stopGroup()
  }

  private record(pos: number) {
    const { doc, io, undo } = this.d
    const r = this.rec
    if (r) return r.end != null ? io.say('loop: it is already ending') : this.stopRecording(r, pos)
    if (!this.current || !this.tracks().some((t) => t.id === this.current)) {
      this.current = this.tracks()[0]?.id ?? (this.stopGroup(), addTrack(doc, `track ${getTracks(doc).length + 1}`, 'audio', undefined, undefined, nextTrackColor(getTracks(doc))))
      this.stopGroup()
    }
    const trackId = this.current!
    const grid = cycleGrid(doc)
    const start = grid ? nextBoundary(pos, grid) : Math.round(pos)
    if (!io.beginTake(trackId)) return
    if (!io.playing()) io.play()
    // overwrite only: the loop already playing here ends exactly where this one starts
    this.stopGroup()
    const changed = endLoopsAt(doc, trackId, start)
    this.rec = { trackId, start, grid, undoDepth: changed && undo ? undo.undoStack.length : null }
    if (changed) this.stopGroup()
  }

  private stopRecording(r: Rec, pos: number) {
    const { io, rate } = this.d
    if (pos < r.start) return this.cancel(r) // stopped before it began
    let end: number
    if (r.grid) {
      end = nextBoundary(pos, r.grid)
      if (end <= r.start) end = r.start + r.grid.period
    } else {
      end = Math.round(pos)
      if (end - r.start < MIN_LOOP_S * rate) return this.cancel(r, true)
    }
    r.end = end
    r.pass = end - r.start
    if (r.recstart != null) io.liveLoop(this.take(r))
  }

  private take(r: Rec): LoopTake {
    return { trackId: r.trackId, start: r.start, pass: r.pass!, recstart: r.recstart!, latency: this.d.latency(), undoDepth: r.undoDepth }
  }

  private cancel(r: Rec, tooShort = false) {
    const { io, undo } = this.d
    this.rec = null
    io.cancelTake()
    if (undo && r.undoDepth != null && undo.undoStack.length === r.undoDepth) undo.undo() // give the earlier loop back
    if (tooShort) io.say('loop: too short')
  }

  /** Called as the clock runs: ends the take once it has everything the loop needs (its last frame arrives `latency` late). */
  tick(pos: number) {
    const r = this.rec
    if (!r || r.end == null || r.recstart == null) return
    if (pos < r.end + this.d.latency() + Math.round(TAIL_S * this.d.rate)) return
    this.rec = null
    this.d.io.endTake(this.take(r))
  }
}

/** Make the next write join the undo step of the earlier loop's end (one step per loop), or stand alone. Call just before the clip is written. */
export function joinUndo(undo: Y.UndoManager, depth: number | null) {
  if (depth != null && undo.undoStack.length === depth) undo.lastChange = Date.now()
  else undo.stopCapturing()
}
