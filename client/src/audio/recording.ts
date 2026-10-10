// Microphone capture (docs/engine.md §9.2). The mic feeds the engine node's input; the worklet copies it while recording,
// in the same call that advances the engine, so every captured frame maps to a timeline sample. Nothing here is monitored.
import type { EngineHost } from './engine-host'
import { latencySamples, toPcm16 } from './wav'

export type InputInfo = { deviceId: string; label: string; channels: number }
export type Captured = { pcm: Int16Array[]; frames: number; channels: number; startPos: number; latency: number }

const offsetKey = (deviceId: string) => `mobdaw.inputOffsetMs.${deviceId}`
/** Manual input delay in ms for a device (added to the automatic compensation), kept per device in this browser. */
export const getInputOffset = (deviceId: string) => Number(localStorage.getItem(offsetKey(deviceId))) || 0
export const setInputOffset = (deviceId: string, ms: number) => localStorage.setItem(offsetKey(deviceId), String(ms))

type Take = {
  pcm: Int16Array[]; frames: number; startPos: number | null; onChunk?: (pcm: Int16Array, seq: number) => void
  done: () => void; finished: Promise<void>
}

export class Recorder {
  info: InputInfo | null = null
  private host: EngineHost | null = null
  private stream: MediaStream | null = null
  private src: MediaStreamAudioSourceNode | null = null
  private take: Take | null = null

  constructor(private ctx: AudioContext, private hostP: Promise<EngineHost>, private rate: number) {}

  get armed() { return !!this.stream }
  get recording() { return !!this.take }

  /** Ask for the microphone (the first time) and connect it to the engine. Rejects with a readable message. */
  async arm(): Promise<InputInfo> {
    if (this.info) return this.info
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('this browser cannot record audio')
    const off = { echoCancellation: false, noiseSuppression: false, autoGainControl: false } // call-style processing ruins music
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: off })
    } catch (e) {
      throw new Error((e as DOMException).name === 'NotAllowedError' ? 'microphone access was denied' : `no microphone: ${(e as Error).message}`)
    }
    const track = stream.getAudioTracks()[0]
    const max = (track.getCapabilities?.().channelCount as { max?: number } | undefined)?.max
    if (max && max > 1) await track.applyConstraints({ ...off, channelCount: { ideal: max } }).catch(() => {})
    const s = track.getSettings()
    void this.ctx.resume()
    try {
      this.host = await this.hostP
    } catch {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('the audio engine did not start')
    }
    try {
      this.src = this.ctx.createMediaStreamSource(stream)
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop())
      // Firefox refuses a microphone whose rate differs from the project's (docs/engine.md §9.2).
      const r = s.sampleRate
      throw new Error(r && r !== this.rate ? `this browser can't record a ${r} Hz microphone into a ${this.rate} Hz project` : `the microphone could not be connected: ${(e as Error).message}`)
    }
    this.src.connect(this.host.node)
    this.stream = stream
    return (this.info = { deviceId: s.deviceId ?? '', label: track.label, channels: Math.max(1, s.channelCount ?? 1) })
  }

  disarm(force = false) {
    if (this.take) {
      if (!force) return
      this.host?.record(false)
      this.take = null
    }
    this.src?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.src = this.stream = this.info = null
  }

  /** Begin capturing; the take starts at the engine's next play. `onChunk` gets each ~1 s of interleaved PCM as it arrives. */
  start(onChunk?: Take['onChunk'], onStart?: (pos: number) => void) {
    const h = this.host
    if (!h || !this.info || this.take) throw new Error('not armed')
    let done = () => {}
    const take: Take = { pcm: [], frames: 0, startPos: null, onChunk, done, finished: new Promise<void>((r) => (done = take.done = r)) }
    this.take = take
    h.onrecstart = (m) => ((take.startPos = m.pos), onStart?.(m.pos))
    h.onrec = (m) => {
      if (m.frames) {
        const pcm = toPcm16(m.channels, m.frames)
        take.onChunk?.(pcm, take.pcm.length)
        take.pcm.push(pcm)
        take.frames += m.frames
      }
      if (m.final) take.done()
    }
    h.record(true, this.info.channels)
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
