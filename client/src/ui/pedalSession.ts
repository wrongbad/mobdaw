// A loop-pedal session against the engine and the doc (docs/engine.md §9.2): one continuous take of the whole session goes
// into a live source, every loop is an engine-only clip on its own new track, and when the session ends the take is saved
// and the surviving loops are written as ordinary audio clips. The decisions are audio/pedal.ts; this carries them out.
import { addAudioClip, deleteTrack, foreverSamples, getClips, getTracks, nextTrackColor, addTrack, isLooping, passLength, updateTrack, type Clip } from '@mobdaw/shared'
import type * as Y from 'yjs'
import type { Action, Grid, Op } from '../audio/pedal'
import { Pedal } from '../audio/pedal'
import type { Playback } from '../audio/playback'
import { finishTake, takeJournal, type TakeCtx } from '../takes'

export type PedalDeps = {
  doc: Y.Doc
  undo: Y.UndoManager
  pb: Playback
  rate: number
  projectId: string
  takeCtx(): TakeCtx
  /** Start the transport from the playhead (it is stopped). */
  play(): void
  /** The session changed: redraw. */
  changed(): void
  fail(msg: string): void
}

/** What the timeline draws: the layer being recorded, and the loops (a loop with no `stopAt` goes on forever). */
export type PedalView = {
  layer: { trackId: string; start: number } | null
  loops: { id: number; trackId: string; start: number; pass: number; stopAt?: number }[]
}

type Session = {
  pedal: Pedal
  live: number // the live source the take is written into
  journal: ReturnType<typeof takeJournal>
  tracks: Map<number, string> // loop (layer) id -> its track
  clips: Map<number, number> // loop id -> its engine-only clip
}

/** The click track's boundaries, if the project has one with a looping clip: its repeat seams. */
export function clickGrid(doc: Y.Doc, rate: number): Grid | null {
  const t = getTracks(doc).find((x) => x.role === 'click')
  const c: Clip | undefined = t && getClips(doc).find((x) => x.trackId === t.id && isLooping(x))
  return c ? { origin: c.start, period: passLength(c, rate) } : null
}

export function pedalSession(d: PedalDeps) {
  const { doc, undo, pb, rate } = d
  let st: Session | null = null

  const nextName = () => {
    const used = getTracks(doc).map((t) => /^loop (\d+)$/.exec(t.name)).flatMap((m) => (m ? [Number(m[1])] : []))
    return `loop ${Math.max(0, ...used) + 1}`
  }

  /** Carry out what the state machine decided, in order. */
  function run(s: Session, ops: Op[]) {
    for (const o of ops) {
      if (o.op === 'begin') begin(s)
      else if (o.op === 'layer') {
        undo.stopCapturing()
        s.tracks.set(o.id, addTrack(doc, nextName(), 'audio', undefined, undefined, nextTrackColor(getTracks(doc))))
        undo.stopCapturing()
      } else if (o.op === 'cancel') drop(s, o.id)
      else if (o.op === 'add') {
        // The clip starts at the closing boundary; playback is stateless, so applying it now (before or just after that
        // sample) sounds the same as applying it exactly there.
        const l = o.loop
        s.clips.set(l.id, pb.liveClip(s.tracks.get(l.id)!, { source: s.live, start: l.start, length: foreverSamples(rate), sourceOffset: l.offset, loopLength: l.pass }))
      } else if (o.op === 'stop') stopAt(s, o)
      else if (o.op === 'remove') {
        drop(s, o.id)
        // a scheduled stop of the loop just removed would bring it back: clear the queue and schedule the others again
        pb.clearScheduled()
        s.pedal.pendingStops(Math.round(pb.position())).forEach((x) => stopAt(s, x))
      } else void end() // 'end': the transport keeps running, the loops go on as clips
    }
    d.changed()
  }

  function stopAt(s: Session, o: { id: number; at: number; length: number }) {
    const h = s.clips.get(o.id)
    if (h != null) pb.updateLiveClip(h, { length: o.length }, o.at)
  }

  /** Take a loop (or the layer being recorded) away: its clip and its track. */
  function drop(s: Session, id: number) {
    const h = s.clips.get(id), track = s.tracks.get(id)
    if (h != null) pb.removeLiveClip(h)
    if (track) deleteTrack(doc, track)
    s.clips.delete(id)
    s.tracks.delete(id)
  }

  /** The first press: start the transport and the session take. */
  function begin(s: Session) {
    pb.recorder.start((pcm, seq) => s.journal.chunk(pcm, seq), (pos) => (s.pedal.tookAt(pos), s.journal.header(pos, s.pedal.latency)), s.live)
    if (!pb.playing) d.play()
  }

  function press(action: Action, perfTime: number) {
    const rec = pb.recorder
    if (!st) {
      if (action !== 'loop') return
      if (!rec.armed || !rec.info) return d.fail('pedal: the microphone is not ready')
      const live = pb.liveSource(rec.info.channels)
      const journal = takeJournal(d.projectId, { trackId: '', trackName: 'pedal take' }, rate, rec.info.channels)
      st = { pedal: new Pedal(rate, rec.latency()), live, journal, tracks: new Map(), clips: new Map() }
      try {
        run(st, st.pedal.press(action, pb.heard(perfTime), clickGrid(doc, rate)))
      } catch (err) {
        const s = st
        st = null
        s.tracks.forEach((t) => deleteTrack(doc, t))
        pb.dropLiveSource(live)
        journal.discard()
        journal.release()
        d.fail(`pedal: ${(err as Error).message}`)
        d.changed()
      }
      return
    }
    run(st, st.pedal.press(action, pb.heard(perfTime), clickGrid(doc, rate)))
  }

  /**
   * End the session: stop the take, save it on its own muted "pedal take" track and write the surviving loops as audio clips,
   * all as one undo step. The loops keep sounding from the engine until the doc clips take them over. The part before the
   * first `await` runs at once, so call it before the transport stops (the take must end before the engine does).
   */
  async function end() {
    const s = st
    if (!s) return
    st = null
    pb.clearScheduled()
    const endPos = Math.round(pb.position())
    const captured = pb.recorder.stop()
    if (s.pedal.layer) drop(s, s.pedal.layer.id)
    const specs = s.pedal.clips(endPos)
    d.changed()
    const cleanup = () => {
      s.clips.forEach((h) => pb.removeLiveClip(h))
      s.tracks.forEach((t) => deleteTrack(doc, t))
    }
    const cap = await captured
    if (!cap) { // the engine never played
      cleanup()
      pb.dropLiveSource(s.live)
      s.journal.discard()
      s.journal.release()
      return
    }
    undo.stopCapturing()
    try {
      await finishTake(d.takeCtx(), { ...cap, latency: s.pedal.latency, trackId: '', trackName: 'pedal take' }, `pedal ${new Date().toLocaleTimeString([], { hour12: false })}`,
        (hash) => pb.bindLiveSource(hash, s.live),
        ({ trackId, hash }) => {
          updateTrack(d.doc, trackId, { muted: true }) // the whole performance stays, editable, but only the loops sound
          for (const c of specs) {
            const { id, ...rest } = c
            addAudioClip(doc, { trackId: s.tracks.get(id)!, sourceHash: hash, ...rest })
          }
        })
      s.clips.forEach((h) => pb.removeLiveClip(h)) // (a no-op for the ones the doc clips adopted)
      await s.journal.settled()
      s.journal.discard() // (on failure the backup stays, and is recovered next time)
    } catch (err) {
      cleanup()
      d.fail(`pedal take: ${(err as Error).message}`)
    }
    s.journal.release()
    undo.stopCapturing()
    d.changed()
  }

  return {
    get active() { return !!st },
    /** Timeline sample where the session take began (for the playback length limit). */
    get since() { return st?.pedal.tookStart ?? 0 },
    press,
    end,
    /** The page is going away mid-session: let go of the take's backup lock (it is recovered on the next open). */
    abandon() {
      st?.journal.release()
      st = null
    },
    view(): PedalView | null {
      if (!st) return null
      const s = st
      const track = (id: number) => s.tracks.get(id) ?? ''
      return {
        layer: s.pedal.layer && { trackId: track(s.pedal.layer.id), start: s.pedal.layer.start },
        loops: s.pedal.loops.map((l) => ({ id: l.id, trackId: track(l.id), start: l.start, pass: l.pass, stopAt: l.stopAt })),
      }
    },
  }
}
