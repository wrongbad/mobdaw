// Glue for one open project: the wasm engine host + the doc bridge + transport.
import type * as Y from 'yjs'
import { Bridge, type Drag } from './bridge'
import { getCtx } from './context'
import { EngineHost } from './engine-host'
import { getSampleBuffer, playable } from '../samples'

export type Playback = ReturnType<typeof openPlayback>

export function openPlayback(doc: Y.Doc, projectId: string, rate: number) {
  const ctx = getCtx(rate)
  const hostP = EngineHost.create(ctx).then((h) => {
    h.node.connect(ctx.destination)
    h.onpos = (m) => bridge.onPos(m)
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
      if (!playable(meta)) return null
      const buf = await getSampleBuffer(projectId, hash, rate)
      return Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice())
    },
    rate,
  )
  return {
    rate,
    get playing() { return bridge.isPlaying },
    position: () => bridge.position(),
    play(from?: number) {
      void ctx.resume()
      bridge.play(from)
    },
    stop: () => bridge.stop(),
    seek: (pos: number) => bridge.seek(pos),
    live: (deviceId: string, paramId: number, v: number) => bridge.live(deviceId, paramId, v),
    setOverrides: (d: Drag[]) => bridge.setOverrides(d),
    destroy() {
      bridge.stop()
      bridge.destroy()
      void hostP.then((h) => h.dispose(), () => {})
    },
  }
}
