// Recorded takes: planar float -> 16-bit PCM, a WAV file around it, and where the clip lands on the timeline.

/** Planar floats (one array per channel) to interleaved 16-bit PCM, clipped to [-1, 1]. */
export function toPcm16(channels: Float32Array[], frames = channels[0]?.length ?? 0): Int16Array {
  const n = channels.length
  const out = new Int16Array(frames * n)
  for (let c = 0; c < n; c++) {
    const src = channels[c]
    for (let i = 0; i < frames; i++) {
      const v = Math.max(-1, Math.min(1, src[i]))
      out[i * n + c] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff)
    }
  }
  return out
}

/** A canonical 44-byte-header WAV (PCM, 16-bit) around interleaved chunks. */
export function encodeWav(chunks: Int16Array[], channels: number, rate: number): Blob {
  const bytes = chunks.reduce((n, c) => n + c.byteLength, 0)
  const head = new DataView(new ArrayBuffer(44))
  const tag = (o: number, s: string) => [...s].forEach((ch, i) => head.setUint8(o + i, ch.charCodeAt(0)))
  tag(0, 'RIFF')
  head.setUint32(4, 36 + bytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  head.setUint32(16, 16, true)
  head.setUint16(20, 1, true) // PCM
  head.setUint16(22, channels, true)
  head.setUint32(24, rate, true)
  head.setUint32(28, rate * channels * 2, true)
  head.setUint16(32, channels * 2, true)
  head.setUint16(34, 16, true)
  tag(36, 'data')
  head.setUint32(40, bytes, true)
  return new Blob([head, ...(chunks as Int16Array<ArrayBuffer>[])], { type: 'audio/wav' })
}

export type WavDepth = 16 | 24 | 32

/**
 * A WAV of planar floats: 16 or 24-bit PCM (clipped to [-1, 1]) or 32-bit float. Encoded a block at a time, so a long
 * render is never held twice in one allocation.
 */
export function encodeWavPlanar(channels: Float32Array[], rate: number, depth: WavDepth = 16): Blob {
  const n = channels.length
  const frames = channels[0]?.length ?? 0
  const width = depth / 8
  const bytes = frames * n * width
  const float = depth === 32
  const head = new DataView(new ArrayBuffer(44))
  const tag = (o: number, s: string) => [...s].forEach((ch, i) => head.setUint8(o + i, ch.charCodeAt(0)))
  tag(0, 'RIFF')
  head.setUint32(4, 36 + bytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  head.setUint32(16, 16, true)
  head.setUint16(20, float ? 3 : 1, true) // 1 PCM, 3 IEEE float
  head.setUint16(22, n, true)
  head.setUint32(24, rate, true)
  head.setUint32(28, rate * n * width, true)
  head.setUint16(32, n * width, true)
  head.setUint16(34, depth, true)
  tag(36, 'data')
  head.setUint32(40, bytes, true)
  const parts: BlobPart[] = [head]
  const BLOCK = 1 << 16
  for (let at = 0; at < frames; at += BLOCK) {
    const len = Math.min(BLOCK, frames - at)
    const out = new DataView(new ArrayBuffer(len * n * width))
    for (let c = 0; c < n; c++) {
      const src = channels[c]
      for (let i = 0; i < len; i++) {
        const o = (i * n + c) * width
        const v = src[at + i]
        if (float) out.setFloat32(o, v, true)
        else {
          const x = Math.max(-1, Math.min(1, v))
          if (depth === 16) out.setInt16(o, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true)
          else {
            const q = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff)
            out.setUint8(o, q & 0xff), out.setUint8(o + 1, (q >> 8) & 0xff), out.setUint8(o + 2, (q >> 16) & 0xff)
          }
        }
      }
    }
    parts.push(out)
  }
  return new Blob(parts, { type: 'audio/wav' })
}

export type Latency = { output: number; base: number; input: number; manualMs: number }

/** Delay between a sound happening and its frame reaching the engine, in samples (docs/engine.md §9.2). */
export const latencySamples = (l: Latency, rate: number) => Math.round((l.output + l.base + l.input + l.manualMs / 1000) * rate)

/**
 * Where a take of `frames` frames goes. Frame 0 was captured at timeline sample `pos`, `latency` samples late, so the clip
 * starts that much earlier. Whatever would land before sample 0 is trimmed off the front (sourceOffset).
 */
export function placeTake(pos: number, latency: number, frames: number) {
  const at = pos - latency
  const cut = Math.max(0, -at)
  return { start: Math.max(0, at), sourceOffset: Math.min(cut, frames), length: Math.max(0, frames - cut) }
}
