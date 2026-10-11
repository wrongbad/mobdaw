import { describe, expect, it } from 'vitest'
import { analyzeAudio, PEAK_BUCKETS, shape } from '../src/audio/probe'
import { describeAudio } from '../src/format'

/** A PCM WAV with `frames` frames; sample (frame, channel) comes from `at`. */
function wav(opts: { rate: number; channels: number; bits: 16 | 24 | 32; float?: boolean; frames: number; at: (f: number, c: number) => number }) {
  const bytes = opts.bits / 8, align = bytes * opts.channels, dataLen = opts.frames * align
  const b = new ArrayBuffer(44 + dataLen), v = new DataView(b)
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)))
  str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true)
  v.setUint16(20, opts.float ? 3 : 1, true); v.setUint16(22, opts.channels, true); v.setUint32(24, opts.rate, true)
  v.setUint32(28, opts.rate * align, true); v.setUint16(32, align, true); v.setUint16(34, opts.bits, true)
  str(36, 'data'); v.setUint32(40, dataLen, true)
  for (let f = 0; f < opts.frames; f++)
    for (let c = 0; c < opts.channels; c++) {
      const o = 44 + f * align + c * bytes, x = opts.at(f, c)
      if (opts.float) v.setFloat32(o, x, true)
      else if (bytes === 2) v.setInt16(o, Math.round(x * 32767), true)
      else if (bytes === 3) {
        const n = Math.round(x * 8388607)
        v.setUint8(o, n & 255); v.setUint8(o + 1, (n >> 8) & 255); v.setUint8(o + 2, (n >> 16) & 255)
      } else v.setInt32(o, Math.round(x * 2147483647), true)
    }
  return new Blob([b])
}

describe('analyzeAudio', () => {
  it('reads format, rate, channels and duration from a 16-bit stereo WAV', async () => {
    const a = await analyzeAudio(wav({ rate: 48000, channels: 2, bits: 16, frames: 48000, at: () => 0 }))
    expect(a.info).toEqual({ format: 'WAV', encoding: '16-bit PCM', sampleRate: 48000, channels: 2, duration: 1 })
    expect(describeAudio(a.info)).toBe('wav · 16-bit pcm · 48 khz · stereo · 0:01')
  })

  it('draws silence flat and a loud second half tall, folding channels', async () => {
    const frames = PEAK_BUCKETS * 10
    const a = await analyzeAudio(wav({ rate: 44100, channels: 2, bits: 16, frames, at: (f, c) => (f >= frames / 2 && c === 1 ? 0.5 : 0) }))
    expect(a.peaks).toHaveLength(PEAK_BUCKETS)
    expect(a.peaks[0]).toBe(0)
    expect(a.peaks[PEAK_BUCKETS - 1]).toBe(Math.round(shape(0.5) * 255))
  })

  it('handles 24-bit and 32-bit float', async () => {
    const f24 = await analyzeAudio(wav({ rate: 96000, channels: 1, bits: 24, frames: 1000, at: () => -0.5 }))
    expect(f24.info).toMatchObject({ encoding: '24-bit PCM', sampleRate: 96000, channels: 1 })
    expect(f24.peaks[0]).toBe(Math.round(shape(0.5) * 255))
    const fl = await analyzeAudio(wav({ rate: 44100, channels: 1, bits: 32, float: true, frames: 1000, at: () => 0.25 }))
    expect(fl.info.encoding).toBe('32-bit float')
    expect(fl.peaks[0]).toBe(Math.round(shape(0.25) * 255))
  })

  it('recognises a FLAC header without decoding', async () => {
    const b = new Uint8Array(64)
    b.set([0x66, 0x4c, 0x61, 0x43]) // fLaC
    // STREAMINFO: 44100 Hz (0x0AC44), 2 channels, 16 bits, 88200 samples
    b.set([0, 0, 0, 34, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0a, 0xc4, 0x42, 0xf0, 0, 1, 0x58, 0x88], 4)
    const a = await analyzeAudio(new Blob([b]))
    expect(a.info).toEqual({ format: 'FLAC', encoding: '16-bit lossless', sampleRate: 44100, channels: 2, duration: 2 })
  })

  it('reports an unreadable file as unknown', async () => {
    const a = await analyzeAudio(new Blob(['not audio at all']))
    expect(a.info.format).toBe('unknown')
    expect(a.peaks).toHaveLength(0)
  })
})
