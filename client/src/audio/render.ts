// Offline render of a whole project: the same engine and doc bridge as playback, run in an OfflineAudioContext.
import { clipLength, getClips, getPads, getTracks, type SampleMeta } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { getSampleBuffer, playable } from '../samples'
import { Bridge } from './bridge'
import { EngineHost } from './engine-host'

/** Where the project's sound ends (samples): the last clip on the timeline or pad. Soundscape source clips live in their own time. */
export function contentEnd(doc: Y.Doc, rate: number) {
  const scapes = new Set(getTracks(doc).filter((t) => t.kind === 'soundscape').map((t) => t.id))
  return Math.max(0,
    ...getClips(doc).filter((c) => !scapes.has(c.trackId)).map((c) => c.start + clipLength(c, rate)),
    ...getPads(doc).map((p) => p.start + p.length))
}

export type RenderOptions = {
  /** Seconds of silence after the last clip, for reverb and delay tails. */
  tail: number
  onProgress?(fraction: number): void
  signal?: AbortSignal
}
export type Rendered = { channels: Float32Array[]; rate: number; /** Audio files that could not be loaded (rendered as silence). */ skipped: number }

export class RenderAborted extends Error {
  constructor() {
    super('export cancelled')
  }
}

export async function renderProject(doc: Y.Doc, projectId: string, rate: number, me: number | null | undefined, opts: RenderOptions): Promise<Rendered> {
  const end = contentEnd(doc, rate)
  if (end === 0) throw new Error('nothing to export: the project has no clips')
  const frames = Math.ceil(end + Math.max(0, opts.tail) * rate)
  const ctx = new OfflineAudioContext(2, frames, rate)
  const host = await EngineHost.create(ctx)
  host.node.connect(ctx.destination)
  const check = () => {
    if (opts.signal?.aborted) throw new RenderAborted()
  }
  let bridge: Bridge | null = null
  try {
    check()
    const loads: Promise<unknown>[] = []
    let skipped = 0
    bridge = new Bridge(
      doc,
      { call: (fn, ...args) => host.call(fn, args), source: (h, ch, n) => host.source(h, ch, n) },
      (hash: string, meta: SampleMeta) => {
        // Registered before the bridge's own continuation, so the audio is posted to the engine before we wait on `loads` settling.
        const p = (async () => {
          if (!playable(meta) || meta.status === 'missing') return (skipped++, null)
          const buf = await getSampleBuffer(projectId, hash, rate, meta.status === 'incoming')
          return Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice())
        })()
        loads.push(p.catch(() => skipped++))
        return p
      },
      rate,
      undefined,
      me,
    )
    await Promise.all(loads)
    check()
    host.call('engine_play', [0])
    await host.sync() // everything above has reached the engine before the first block is rendered

    // Render in one-second slices: the suspend points give progress and a place to stop.
    const step = Math.ceil(rate / 128) * 128
    for (let at = step; at < frames; at += step) {
      void ctx.suspend(at / rate).then(() => {
        opts.onProgress?.(at / frames)
        if (!opts.signal?.aborted) void ctx.resume()
      })
    }
    const aborted = new Promise<never>((_, reject) => opts.signal?.addEventListener('abort', () => reject(new RenderAborted())))
    const buf = await Promise.race([ctx.startRendering(), aborted])
    opts.onProgress?.(1)
    return { channels: [buf.getChannelData(0), buf.getChannelData(1)], rate, skipped }
  } finally {
    bridge?.destroy()
    host.dispose()
  }
}
