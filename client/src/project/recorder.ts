// Recording (docs/engine.md §9): arming, takes, monitoring, and the loop commands (audio/loopPedal.ts) from keys and MIDI.
// Audio and doc state machines with no DOM: the view passes in what it shows and hears (`say`, `onChange`, the transport).
import { addTrack, foreverSamples, getTracks, nextTrackColor, tracksMap } from '@mobdaw/shared'
import { createSignal } from 'solid-js'
import type * as Y from 'yjs'
import type { Captured } from '../audio/recording'
import { LoopPedal, commitLoop, joinUndo, loopOffset, type Cmd, type LoopIO, type LoopTake } from '../audio/loopPedal'
import { actionFor, getBindings, getMidiInput, midiSupported, onPress, openMidi } from '../midi'
import type { Playback } from '../audio/playback'
import { finishTake, takeJournal, type TakeCtx } from '../takes'
import type { Session } from './session'

/** The take being recorded. */
export type Take = { trackId: string; trackName: string; start: number; journal: ReturnType<typeof takeJournal> }

export type RecorderDeps = {
  s: Pick<Session, 'projectId' | 'userId' | 'user' | 'setLocal'>
  doc: Y.Doc
  undo: Y.UndoManager
  readOnly: boolean
  /** Read at each use: the project's sample rate and playback change (and are absent until the doc has synced). */
  rate(): number
  pb(): Playback | null
  position(): number
  say(text: string, bad?: boolean): void
  /** Something the view shows changed: redraw. */
  onChange(): void
  /** Start the transport (from `from`, if it is not already playing) and whatever follows it in the view. */
  startTransport(from?: number): void
  /** Stop the transport the way the transport button does (this ends a take). */
  stop(): void
  /** The top bar's loop status line should be redrawn. */
  loopStatus(): void
  /** Replaceable for tests. */
  journal?: typeof takeJournal
  finish?: typeof finishTake
}

/** A mutable value that components can follow (`.v` read inside an effect or a binding subscribes). */
function sig<T>(init: T) {
  const [get, set] = createSignal(init)
  return { get v() { return get() }, set v(x: T) { set(() => x) } }
}

export function createRecorder(d: RecorderDeps) {
  const { s, doc, undo, readOnly } = d
  const journalOf = d.journal ?? takeJournal
  const finish = d.finish ?? finishTake
  const current = sig<string | null>(null) // the loop commands' current track, as of the last change
  const armed = sig<string | null>(null) // audio track armed for recording (local UI state, never in the doc)
  const monitor = sig(false) // hear the armed track's input through its effects (local UI state)
  let monitored: string | null = null // the track the engine is currently monitoring
  let take: Take | null = null // the take being recorded
  let loops: LoopPedal | null = null // the loop commands (keys and MIDI are always listened for; docs/engine.md §9.2)
  let offMidi = () => {} // stops listening to the MIDI input
  let loopLive: { source: number; clip?: number } | null = null // the live source (and engine-only clip) of the loop being recorded
  let loopTimer: ReturnType<typeof setInterval> | 0 = 0 // while a loop records: ends its take when it has what it needs
  let closingTake: Promise<unknown> = Promise.resolve() // a loop take being stopped by the recorder
  let closing = 0 // how many are being stopped
  const closeTake = (p: Promise<unknown>) => (closingTake = p, closing++, void p.then(() => closing--, () => closing--))
  let loopArming = false // asking for the microphone
  let preparing = false // asking for the microphone for ●: ignore further presses
  let destroyed = false

  const say = d.say
  const changed = () => ((current.v = loops?.current ?? null), d.onChange())
  const takeCtx = (): TakeCtx => ({ doc, projectId: s.projectId, me: s.userId == null ? null : { id: s.userId, name: s.user.username }, rate: d.rate() })

  /** R: arm this audio track (the first time, ask for the microphone) or disarm it. */
  async function arm(id: string) {
    const pb = d.pb()
    if (!pb || take) return
    if (armed.v === id) {
      armed.v = null
      pb.recorder.disarm()
      return changed()
    }
    try {
      await pb.recorder.arm()
    } catch (err) {
      say(`record: ${(err as Error).message}`, true)
      return
    }
    say('')
    armed.v = id
    changed()
  }

  /** ●: play and capture from the playhead (onto a new track if none is armed); again to stop. */
  async function toggleRecord() {
    const pb = d.pb()
    if (!pb || readOnly || preparing) return
    if (loops?.recording) return void say('record: a loop is recording', true)
    if (take) return d.stop()
    if (!armed.v || !tracksMap(doc).has(armed.v) || !pb.recorder.armed) {
      preparing = true
      try {
        await pb.recorder.arm()
      } catch (err) {
        say(`record: ${(err as Error).message}`, true)
        return
      } finally {
        preparing = false
      }
      if (destroyed || take) return
      if (!armed.v || !tracksMap(doc).has(armed.v)) armed.v = addTrack(doc, `track ${getTracks(doc).length + 1}`, 'audio', undefined, undefined, nextTrackColor(getTracks(doc)))
      changed()
    }
    const trackId = armed.v!
    const from = Math.round(d.position()) // (while playing, capture begins at the engine's next block: the recorder reports where)
    const info = { trackId, trackName: String(tracksMap(doc).get(trackId)!.get('name')) }
    const journal = journalOf(s.projectId, info, d.rate(), pb.recorder.info!.channels)
    try {
      pb.recorder.start((pcm, seq) => journal.chunk(pcm, seq), (pos) => journal.header(pos, pb.recorder.latency()))
    } catch (err) {
      journal.release()
      say(`record: ${(err as Error).message}`, true)
      return
    }
    take = { ...info, start: from, journal }
    say('')
    s.setLocal({ recording: { trackId, start: from } })
    d.startTransport(from)
    changed()
  }

  /**
   * The transport is stopping: end the take in progress (a loop interrupted by the stop is saved as a plain take), call `halt` to stop
   * the engine and the view's transport, and save the take.
   */
  function stop(halt: () => void) {
    const pb = d.pb()
    const t = take
    take = null
    loops?.reset()
    const live = loopLive // (its live source goes once the take has ended)
    loopLive = null
    clearLoopTimer()
    d.loopStatus()
    const captured = t ? pb?.recorder.stop() : undefined // (asks the worklet to end the take before the engine stops)
    // the loop commands' microphone is let go once every take has ended (never cut short); a track armed for recording keeps it
    void Promise.all([captured, closingTake]).then(() => !armed.v && !take && !d.pb()?.playing && !loops?.recording && d.pb()?.recorder.disarm())
    if (live) void Promise.resolve(captured).then(() => (live.clip != null && pb?.removeLiveClip(live.clip), pb?.dropLiveSource(live.source)))
    halt()
    s.setLocal({ playhead: null, ...(t ? { recording: null } : {}) })
    changed()
    if (t && captured) void saveTake(t, captured)
  }

  async function saveTake(t: Take, captured: Promise<Captured | null>) {
    const cap = await captured
    if (!cap) return t.journal.discard(), t.journal.release()
    say('saving take…')
    undo.stopCapturing()
    try {
      await finish(takeCtx(), { ...cap, trackId: t.trackId, trackName: t.trackName })
      say('')
      await t.journal.settled()
      t.journal.discard() // (on failure the backup stays, and is recovered next time)
    } catch (err) {
      say(`take: ${(err as Error).message}`, true)
    }
    t.journal.release()
    undo.stopCapturing()
  }

  // --- loop commands (docs/engine.md §9.2, audio/loopPedal.ts): the transport keeps rolling and every command is written into
  // the doc where it was heard. A loop take goes through the normal take path (`take`, the recorder, `finishTake`).
  function resetLoops() {
    loops?.reset()
    dropLoopLive()
    loops = null
  }
  const clearLoopTimer = () => (clearInterval(loopTimer || undefined), (loopTimer = 0))
  /** Let go of a loop's live source and engine-only clip that never became a doc clip. */
  function dropLoopLive() {
    clearLoopTimer()
    const l = loopLive
    loopLive = null
    const pb = d.pb()
    if (!l || !pb) return
    if (l.clip != null) pb.removeLiveClip(l.clip)
    pb.dropLiveSource(l.source)
  }
  function makeLoops(): LoopPedal | null {
    const pb = d.pb()
    if (!pb || readOnly) return null
    const io: LoopIO = {
      playing: () => !!d.pb()?.playing,
      play: () => d.startTransport(),
      beginTake: beginLoopTake,
      liveLoop: (t) => {
        // The clip plays from the live source at once: silent until the boundary, then the loop, whatever the save is doing.
        if (loopLive) loopLive.clip = d.pb()!.liveClip(t.trackId, { source: loopLive.source, start: t.start, length: foreverSamples(d.rate()), sourceOffset: loopOffset(t), loopLength: t.pass })
      },
      endTake: endLoopTake,
      cancelTake: cancelLoopTake,
      say: (m) => say(m, true),
    }
    return new LoopPedal({ doc, rate: d.rate(), io, undo, latency: () => d.pb()!.recorder.latency() })
  }
  /** The take of a loop: the normal recording path, written into a live source the engine can play while it grows. */
  function beginLoopTake(trackId: string): boolean {
    const pb = d.pb()!
    const rec = pb.recorder
    if (take || rec.recording || !rec.armed || !rec.info) {
      say('loop: the previous take is still closing', true)
      return false
    }
    const source = pb.liveSource(rec.info.channels)
    const info = { trackId, trackName: String(tracksMap(doc).get(trackId)!.get('name')) }
    const journal = journalOf(s.projectId, info, d.rate(), rec.info.channels)
    const from = Math.round(d.position())
    try {
      rec.start((pcm, seq) => journal.chunk(pcm, seq), (pos) => (journal.header(pos, rec.latency()), loops?.tookAt(pos)), source)
    } catch (err) {
      journal.release()
      pb.dropLiveSource(source)
      say(`loop: ${(err as Error).message}`, true)
      return false
    }
    take = { ...info, start: from, journal }
    loopLive = { source }
    armed.v = trackId
    s.setLocal({ recording: { trackId, start: from } })
    loopTimer = setInterval(() => loops && (loops.tick(d.position()), d.loopStatus()), 30)
    return true
  }
  /** The loop has all its frames: stop the take and save it. Its clip is the loop, written with the take (one undo step). */
  function endLoopTake(t: LoopTake) {
    const pb = d.pb()
    const tk = take, live = loopLive
    take = null
    loopLive = null
    clearLoopTimer()
    s.setLocal({ recording: null })
    if (!tk || !live || !pb) return
    const stopped = pb.recorder.stop()
    closeTake(stopped)
    void saveLoopTake(tk, stopped, t, live)
    changed()
  }
  function cancelLoopTake() {
    const pb = d.pb()
    const tk = take, live = loopLive
    take = null
    clearLoopTimer()
    s.setLocal({ recording: null })
    const stopped = pb?.recorder.stop()
    if (stopped) closeTake(stopped)
    loopLive = null
    void stopped?.then(() => live && pb?.dropLiveSource(live.source))
    tk?.journal.discard()
    tk?.journal.release()
    changed()
  }
  async function saveLoopTake(tk: Take, captured: Promise<Captured | null>, t: LoopTake, live: NonNullable<typeof loopLive>) {
    const gone = () => (live.clip != null && d.pb()?.removeLiveClip(live.clip), d.pb()?.dropLiveSource(live.source))
    const cap = await captured
    if (!cap) return gone(), tk.journal.discard(), tk.journal.release()
    try {
      await finish(takeCtx(), { ...cap, trackId: tk.trackId, trackName: tk.trackName }, `loop ${new Date().toLocaleTimeString([], { hour12: false })}`,
        (hash) => (d.pb()?.bindLiveSource(hash, live.source), joinUndo(undo, t.undoDepth)),
        ({ trackId, hash }) => void commitLoop(doc, { ...t, recstart: cap.startPos }, trackId, hash), true)
      await tk.journal.settled()
      tk.journal.discard() // (on failure the backup stays, and is recovered next time)
    } catch (err) {
      gone()
      say(`loop: ${(err as Error).message}`, true)
    }
    tk.journal.release()
    undo.stopCapturing()
  }

  /** Run a command heard at `perfTime` (performance.now clock; a key or MIDI event's timeStamp). */
  async function command(cmd: Cmd, perfTime: number) {
    const pb = d.pb()
    if (!pb || readOnly || destroyed || loopArming) return
    let at = perfTime
    if (cmd === 'record' && !loops?.recording) {
      if (take) return void say('loop: stop recording first', true)
      if (!pb.recorder.armed) { // the first press asks for the microphone; it stays armed
        loopArming = true
        try {
          await pb.recorder.arm()
        } catch (err) {
          return void say(`loop: ${(err as Error).message}`, true)
        } finally {
          loopArming = false
        }
        say('')
        at = performance.now()
        if (destroyed || !d.pb()) return
      }
    }
    loops ??= makeLoops()
    if (!loops) return
    if (armed.v && tracksMap(doc).has(armed.v)) loops.current = armed.v // an armed track is the current one
    const now = d.pb()!
    loops.press(cmd, now.playing ? now.heard(at) : Math.round(d.position()))
    if (armed.v && loops.current) armed.v = loops.current
    changed()
  }
  /** Listen to the chosen MIDI input (always, once one is set up). */
  function listenMidi() {
    offMidi()
    offMidi = () => {}
    const id = getMidiInput()
    if (!id || !midiSupported() || readOnly) return
    void openMidi().then(() => {
      if (destroyed || id !== getMidiInput()) return
      offMidi = onPress(id, (t, at) => {
        const c = actionFor(getBindings(), t)
        if (c) void command(c, at)
      })
    }, () => {})
  }

  /** The microphone choice changed: if one is open, reconnect it to the chosen device (unless a take is running). */
  async function reopenInput() {
    const pb = d.pb()
    if (!pb?.recorder.armed) return
    if (take) {
      say('the new microphone is used from the next take')
      return
    }
    pb.recorder.disarm()
    try {
      await pb.recorder.arm()
      say('')
    } catch (err) {
      armed.v = null
      say(`record: ${(err as Error).message}`, true)
    }
    changed()
  }

  return {
    get take() { return take },
    /** Read inside an effect or a binding, these follow the recorder (the headers' R, I and meter do). */
    get armedTrack() { return armed.v },
    get monitoring() { return monitor.v },
    /** The loop commands' current track (where record and mute act). */
    get currentTrack() { return current.v },
    get loops() { return loops },
    /** A take or loop is recording or closing, or a command is asking for the microphone: the transport must not stop by itself. */
    get busy() { return !!take || !!loopLive || !!loops?.recording || closing > 0 || preparing },
    arm, toggleRecord, stop, command, listenMidi, reopenInput, resetLoops, takeCtx,
    toggleMonitoring() { monitor.v = !monitor.v; changed() },
    /** The project's sample rate changed: playback is opened again, and nothing stays armed. */
    forgetArmed() { armed.v = null },
    /** Each draw: the armed track may have been deleted, and the engine monitors the armed track if asked to (disarming ends monitoring). */
    sync(trackIds: Set<string>) {
      const pb = d.pb()
      if (armed.v && !trackIds.has(armed.v)) { // the armed track was deleted
        armed.v = null
        if (!take) pb?.recorder.disarm()
      }
      const want = monitor.v && armed.v && pb?.recorder.armed ? armed.v : null
      if (want !== monitored) pb?.monitor((monitored = want))
    },
    destroy() {
      destroyed = true
      offMidi()
      clearLoopTimer()
      if (take) s.setLocal({ recording: null }), take.journal.release() // (its backup is recovered on the next open)
    },
  }
}

export type Recorder = ReturnType<typeof createRecorder>
