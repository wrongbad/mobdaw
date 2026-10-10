// Glue for one open project: the wasm engine host + the doc bridge + transport.
import type * as Y from 'yjs'
import { Bridge, type Drag, type PreviewMode, type PreviewTransport } from './bridge'
import { getCtx } from './context'
import { EngineHost } from './engine-host'
import { Recorder } from './recording'
import { getSampleBuffer, playable } from '../samples'

export type Playback = ReturnType<typeof openPlayback>

/** `me` is the signed-in user's id: it may load its own 'incoming' takes, which are only on this device. */
export function openPlayback(doc: Y.Doc, projectId: string, rate: number, me?: number | null) {
  const ctx = getCtx(rate)
  const hostP = EngineHost.create(ctx).then((h) => {
    h.node.connect(ctx.destination)
    h.onpos = (m) => bridge.onPos(m)
    h.onpreview = (m) => bridge.onPreviewPos(m)
    h.onloopers = (m) => bridge.onLooperHeads(m)
    return h
  })
  hostP.catch((e) => console.error('engine failed to start:', e))
  // Calls chain on the host promise, so they reach the worklet in order.
  const bridge = new Bridge(
    doc,
    {
      call: (fn, ...args) => void hostP.then((h) => h.call(fn, args), () => {}),
      source: (h, ch, frames) => void hostP.then((x) => x.source(h, ch, frames), () => {}),
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
  const recorder = new Recorder(ctx, hostP, rate)
  return {
    rate,
    recorder,
    get playing() { return bridge.isPlaying },
    position: () => bridge.position(),
    play(from?: number) {
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
          void ctx.resume()
          p.play(from)
        },
        stop: () => p.stop(),
        seek: (pos: number) => p.seek(pos),
      }
    },
    seek: (pos: number) => bridge.seek(pos),
    /** A looper's read head on the source tape (samples), or null while it isn't sounding. */
    looperHead: (id: string) => bridge.looperHead(id),
    live: (deviceId: string, paramId: number, v: number) => bridge.live(deviceId, paramId, v),
    setOverrides: (d: Drag[]) => bridge.setOverrides(d),
    destroy() {
      recorder.disarm(true)
      bridge.stop()
      bridge.destroy()
      void hostP.then((h) => h.dispose(), () => {})
    },
  }
}
