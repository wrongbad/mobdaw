// Glue for one open project: the wasm engine host + the doc bridge + transport.
import type * as Y from 'yjs'
import { Bridge, type Drag, type LiveClip, type Meters, type PreviewMode, type PreviewTransport } from './bridge'
import { getCtx, holdPlayback } from './context'
import { EngineHost } from './engine-host'
import { heardPosition, type PosReport } from './pedal'
import { Recorder } from './recording'
import { getSampleBuffer, playable } from '../samples'

export type Playback = ReturnType<typeof openPlayback>

/** `me` is the signed-in user's id: it may load its own 'incoming' takes, which are only on this device. */
export function openPlayback(doc: Y.Doc, projectId: string, rate: number, me?: number | null) {
  const ctx = getCtx(rate)
  let oncpu: ((m: { load: number; peak: number }) => void) | null = null
  let onmeters: ((m: Meters) => void) | null = null
  let analyser: AnalyserNode | null = null
  let lastPos: (PosReport & { playing: boolean }) | null = null // the engine's latest position report, to place loop-command presses
  const hostP = EngineHost.create(ctx).then((h) => {
    h.oncpu = (m) => oncpu?.(m)
    h.node.connect(ctx.destination)
    h.onpos = (m) => ((lastPos = m), bridge.onPos(m))
    h.onpreview = (m) => bridge.onPreviewPos(m)
    h.onloopers = (m) => bridge.onLooperHeads(m)
    h.onmeters = (m) => onmeters?.(bridge.meters(m))
    return h
  })
  hostP.catch((e) => console.error('engine failed to start:', e))
  // Calls chain on the host promise, so they reach the worklet in order.
  const bridge = new Bridge(
    doc,
    {
      call: (fn, ...args) => void hostP.then((h) => h.call(fn, args), () => {}),
      source: (h, ch, frames) => void hostP.then((x) => x.source(h, ch, frames), () => {}),
      callAt: (at, fn, ...args) => void hostP.then((h) => h.callAt(at, fn, args), () => {}),
    },
    async (hash, meta) => {
      if (!playable(meta) || meta.status === 'missing') return null
      const buf = await getSampleBuffer(projectId, hash, rate, meta.status === 'incoming')
      return Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice())
    },
    rate,
    undefined,
    me,
  )
  // The transport cycle is off while a take is recorded (docs/engine-api.md, engine_set_loop).
  const recorder = new Recorder(ctx, hostP, rate, (on) => bridge.setRecording(on))

  // The iOS audio session is 'playback' (so the silent switch doesn't mute us) only while something sounds; the rest
  // of the time it is released so the page doesn't sit in the notification center as a now-playing tile.
  const sounding = new Set<{ playing: boolean }>() // private transports (soundscape previews) that were started
  let releasePlayback: (() => void) | null = null
  let quietSince = 0
  let settleTimer = 0
  const TAIL_MS = 3000 // effect tails and note releases keep sounding a little after the transport stops
  const busy = () => bridge.isPlaying || [...sounding].some((p) => p.playing)
  const sound = () => {
    releasePlayback ??= holdPlayback()
    quietSince = 0
    settleTimer ||= window.setInterval(() => {
      for (const p of sounding) if (!p.playing) sounding.delete(p)
      if (busy()) return void (quietSince = 0)
      quietSince ||= performance.now()
      if (performance.now() - quietSince < TAIL_MS) return
      releasePlayback?.()
      releasePlayback = null
      clearInterval(settleTimer)
      settleTimer = 0
    }, 500)
  }
  return {
    rate,
    recorder,
    /** Engine DSP load reports (twice a second). */
    set oncpu(fn: ((m: { load: number; peak: number }) => void) | null) { oncpu = fn },
    /**
     * Level meters, about 30 times a second while anything sounds (stopped too: live notes, monitoring), then one
     * all-zero report when it falls silent: post-fader peaks (linear, 1 = full scale) since the last report, master and
     * per track by doc id. Decay and peak hold are the UI's.
     */
    set onmeters(fn: ((m: Meters) => void) | null) { onmeters = fn },
    /** The master output for a scope or spectrum (fftSize 2048), fed in parallel from the engine; made on first use. */
    get analyser(): AnalyserNode {
      if (!analyser) {
        const a = (analyser = ctx.createAnalyser())
        a.fftSize = 2048
        void hostP.then((h) => h.node.connect(a), () => {})
      }
      return analyser
    },
    get playing() { return bridge.isPlaying },
    position: () => bridge.position(),
    play(from?: number) {
      sound()
      void ctx.resume()
      bridge.play(from)
    },
    stop: () => bridge.stop(),
    /** A private transport on a soundscape track (its source tape, or its loops). */
    preview(trackId: string, mode: PreviewMode): PreviewTransport {
      const p = bridge.preview(trackId, mode)
      return {
        get playing() { return p.playing },
        position: () => p.position(),
        play(from?: number) {
          sound()
          sounding.add(p)
          void ctx.resume()
          p.play(from)
        },
        stop: () => p.stop(),
        seek: (pos: number) => p.seek(pos),
      }
    },
    seek: (pos: number) => bridge.seek(pos),
    /**
     * The timeline sample the performer hears at `perfTime` (performance.now clock, ms; a MIDI event's `timeStamp`): the
     * output timestamp says which context frame is at the speaker then, and the engine's last position report ties that
     * frame to the timeline. Without a usable report, the extrapolated position less the output latency.
     */
    heard(perfTime: number): number {
      const ts = ctx.getOutputTimestamp?.()
      if (lastPos?.playing && ts && ts.contextTime != null && ts.performanceTime) {
        return heardPosition(lastPos, { contextTime: ts.contextTime, performanceTime: ts.performanceTime }, perfTime, rate)
      }
      const late = (ctx.outputLatency ?? 0) + (ctx.baseLatency ?? 0) - (performance.now() - perfTime) / 1000
      return Math.round(bridge.position() - late * rate)
    },
    /** Hear the armed microphone through this track's effects (null: stop). Only audible while the recorder is armed. */
    monitor: (trackId: string | null) => void hostP.then((h) => h.monitor(trackId == null ? null : bridge.trackHandle(trackId)), () => {}),
    /** Gate a key on the track's instruments (held until `on` is false), whether or not the transport runs. */
    noteLive: (trackId: string, pitch: number, velocity: number, on: boolean) => {
      if (on) sound()
      void hostP.then((h) => h.call('engine_note_live', [bridge.trackHandle(trackId), pitch, velocity, on ? 1 : 0]), () => {})
    },
    /** A looper's read head on the source tape (samples), or null while it isn't sounding. */
    looperHead: (id: string) => bridge.looperHead(id),
    /**
     * Reserve a live source for a take (pass it to `recorder.start(..., live)`): audio that grows as the take is
     * recorded. Returns its engine handle.
     */
    liveSource: (channels?: number) => bridge.liveSource(channels),
    /** The finished take is the doc sample `hash`: bind it to the live source `h` and finalize it, so it is not loaded again. Call before writing the sample to the doc. */
    bindLiveSource: (hash: string, h: number) => bridge.bindLiveSource(hash, h),
    /** Free a live source that was never bound (a discarded take). */
    dropLiveSource: (h: number) => bridge.dropLiveSource(h),
    /** Play an audio clip that is not in the doc, now or applied exactly at timeline sample `at`. Returns its engine handle. */
    liveClip: (trackId: string, c: LiveClip, at?: number) => bridge.liveClip(trackId, c, at),
    /** Change such a clip (e.g. `{ length }` to stop it), now or at sample `at`. */
    updateLiveClip: (h: number, patch: Partial<LiveClip>, at?: number) => bridge.updateLiveClip(h, patch, at),
    /** Remove such a clip, now or at sample `at`. */
    removeLiveClip: (h: number, at?: number) => bridge.removeLiveClip(h, at),
    /** Make the engine-only clip `h` the engine copy of doc clip `clipId` (a matching doc clip adopts it by itself; see Bridge.adoptLiveClip). */
    adoptLiveClip: (h: number, clipId: string) => bridge.adoptLiveClip(h, clipId),
    /** Forget scheduled engine calls that have not run yet. */
    clearScheduled: () => void hostP.then((h) => h.clearScheduled(), () => {}),
    live: (deviceId: string, paramId: number, v: number) => bridge.live(deviceId, paramId, v),
    setOverrides: (d: Drag[]) => bridge.setOverrides(d),
    destroy() {
      clearInterval(settleTimer)
      releasePlayback?.()
      releasePlayback = null
      recorder.disarm(true)
      analyser?.disconnect()
      bridge.stop()
      bridge.destroy()
      void hostP.then((h) => h.dispose(), () => {})
    },
  }
}
