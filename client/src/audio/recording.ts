// Microphone capture (docs/engine.md §9.2). The mic feeds the engine node's input; the worklet copies it while recording,
// in the same call that advances the engine, so every captured frame maps to a timeline sample. Monitoring (hearing the input through a track's effects) is a separate path: see Playback.monitor.
import type { EngineHost } from './engine-host'
import { LIVE_HEADROOM_S } from './bridge'
import { holdCapture } from './context'
import { latencySamples, toPcm16 } from './wav'

export type InputInfo = { deviceId: string; label: string; channels: number }
export type Captured = { pcm: Int16Array[]; frames: number; channels: number; startPos: number; latency: number }

/** A converter that clips reads as exactly full scale (16-bit: 32767/32768), so a hot but clean signal stays below this. */
const CLIP_LEVEL = 0.999
const CLIP_HOLD_MS = 2000

const offsetKey = (deviceId: string) => `mobdaw.inputOffsetMs.${deviceId}`
/** Manual input delay in ms for a device (added to the automatic compensation), kept per device in this browser. */
export const getInputOffset = (deviceId: string) => Number(localStorage.getItem(offsetKey(deviceId))) || 0
export const setInputOffset = (deviceId: string, ms: number) => localStorage.setItem(offsetKey(deviceId), String(ms))

const inputKey = 'mobdaw.inputDevice'
/** The microphone chosen in the project settings (a device id), kept in this browser; empty = the system default. */
export const getPreferredInput = () => localStorage.getItem(inputKey) ?? ''
export const setPreferredInput = (deviceId: string) => (deviceId ? localStorage.setItem(inputKey, deviceId) : localStorage.removeItem(inputKey))

type Take = {
  pcm: Int16Array[]; frames: number; startPos: number | null; onChunk?: (pcm: Int16Array, seq: number) => void
  done: () => void; finished: Promise<void>
}

export class Recorder {
  info: InputInfo | null = null
  private host: EngineHost | null = null
  private stream: MediaStream | null = null
  private release: (() => void) | null = null
  private src: MediaStreamAudioSourceNode | null = null
  private take: Take | null = null
  private pk = new Float32Array(4096)
  private pkN = 0
  /** Recent input level, 0..1 (peak with a short decay). */
  level = 0
  private clipAt = -Infinity
  /** Whether the input hit full scale in the last couple of seconds (a hold, so a brief clip is visible but doesn't stick). */
  get clipped() { return performance.now() - this.clipAt < CLIP_HOLD_MS }
  /** Called whenever the level moves (about 45 times a second while armed). */
  onlevel: (() => void) | null = null

  constructor(private ctx: AudioContext, private hostP: Promise<EngineHost>, private rate: number) {}

  get armed() { return !!this.stream }
  get recording() { return !!this.take }
  /** The take so far as waveform peaks (BUCKET frames each, the first being the take's first frame). */
  get peaks() { return this.pk.subarray(0, this.pkN) }

  private onLevel(m: { peaks: Float32Array; rec: boolean }) {
    let mx = 0
    for (const v of m.peaks) if (v > mx) mx = v
    this.level = Math.max(mx, this.level * 0.95)
    if (mx >= CLIP_LEVEL) this.clipAt = performance.now()
    if (this.take && m.rec) {
      if (this.pkN + m.peaks.length > this.pk.length) {
        const bigger = new Float32Array(this.pk.length * 2)
        bigger.set(this.pk.subarray(0, this.pkN))
        this.pk = bigger
      }
      this.pk.set(m.peaks, this.pkN)
      this.pkN += m.peaks.length
    }
    this.onlevel?.()
  }

  /** Ask for the microphone (the first time) and connect it to the engine. Rejects with a readable message. */
  async arm(): Promise<InputInfo> {
    if (this.info) return this.info
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('this browser cannot record audio')
    const off = { echoCancellation: false, noiseSuppression: false, autoGainControl: false } // call-style processing ruins music
    let stream: MediaStream
    const release = holdCapture()
    try {
      const pick = getPreferredInput()
      // (a chosen microphone that is unplugged falls back to the default one)
      stream = await navigator.mediaDevices.getUserMedia({ audio: pick ? { ...off, deviceId: { exact: pick } } : off })
        .catch((e: DOMException) => (pick && e.name === 'OverconstrainedError' ? navigator.mediaDevices.getUserMedia({ audio: off }) : Promise.reject(e)))
    } catch (e) {
      release()
      throw new Error((e as DOMException).name === 'NotAllowedError' ? 'microphone blocked: allow it in the site settings' : `no microphone: ${(e as Error).message}`)
    }
    const track = stream.getAudioTracks()[0]
    const max = (track.getCapabilities?.().channelCount as { max?: number } | undefined)?.max
    if (max && max > 1) await track.applyConstraints({ ...off, channelCount: { ideal: max } }).catch(() => {})
    const s = track.getSettings()
    void this.ctx.resume()
    try {
      this.host = await this.hostP
    } catch {
      release()
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('the audio engine did not start')
    }
    try {
      this.src = this.ctx.createMediaStreamSource(stream)
    } catch (e) {
      release()
      stream.getTracks().forEach((t) => t.stop())
      // Firefox refuses a microphone whose rate differs from the project's (docs/engine.md §9.2).
      const r = s.sampleRate
      throw new Error(r && r !== this.rate ? `this browser can't record a ${r} Hz microphone into a ${this.rate} Hz project` : `the microphone could not be connected: ${(e as Error).message}`)
    }
    this.src.connect(this.host.node)
    this.stream = stream
    this.release = release
    this.level = 0
    this.clipAt = -Infinity
    this.host.onlevel = (m) => this.onLevel(m)
    this.host.meter(true)
    return (this.info = { deviceId: s.deviceId ?? '', label: track.label, channels: Math.max(1, s.channelCount ?? 1) })
  }

  disarm(force = false) {
    if (this.take) {
      if (!force) return
      this.host?.record(false)
      this.take = null
    }
    this.host?.meter(false)
    if (this.host) this.host.onlevel = null
    this.level = 0
    this.onlevel?.()
    this.src?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.src = this.stream = this.info = null
    this.release?.()
    this.release = null
  }

  /**
   * Begin capturing; the take starts at the engine's next play. `onChunk` gets each ~1 s of interleaved PCM as it arrives.
   * `live` is a live source handle (`Bridge.liveSource`) the engine fills as the take is captured; its room is topped up
   * with every chunk. `onStart` gets the take's timeline start (the sample of the first captured frame).
   */
  start(onChunk?: Take['onChunk'], onStart?: (pos: number) => void, live = 0) {
    const h = this.host
    if (!h || !this.info || this.take) throw new Error('not armed')
    let done = () => {}
    const finished = new Promise<void>((r) => (done = r))
    const take: Take = { pcm: [], frames: 0, startPos: null, onChunk, done, finished }
    this.take = take
    this.pkN = 0
    this.clipAt = -Infinity
    h.onrecstart = (m) => ((take.startPos = m.pos), onStart?.(m.pos))
    h.onrec = (m) => {
      if (m.frames) {
        const pcm = toPcm16(m.channels, m.frames)
        take.onChunk?.(pcm, take.pcm.length)
        take.pcm.push(pcm)
        take.frames += m.frames
        if (live) h.call('engine_source_live_reserve', [live, take.frames + LIVE_HEADROOM_S * this.rate])
      }
      if (m.final) take.done()
    }
    h.record(true, this.info.channels, live)
  }

  /** End the take. Null when nothing was captured (the engine never played). */
  async stop(): Promise<Captured | null> {
    const take = this.take, h = this.host, info = this.info
    if (!take || !h || !info) return null
    h.record(false)
    await Promise.race([take.finished, new Promise((r) => setTimeout(r, 2000))])
    h.onrec = h.onrecstart = null
    this.take = null
    if (take.startPos == null || !take.frames) return null
    return { pcm: take.pcm, frames: take.frames, channels: info.channels, startPos: take.startPos, latency: this.latency() }
  }

  /** How late the armed input's audio reaches the engine, in samples (docs/engine.md §9.2). */
  latency() {
    const settings = this.stream?.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined
    return latencySamples({
      output: this.ctx.outputLatency ?? 0, base: this.ctx.baseLatency ?? 0,
      input: settings?.latency ?? 0, manualMs: getInputOffset(this.info?.deviceId ?? ''),
    }, this.rate)
  }
}
