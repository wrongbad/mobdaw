import { describe, expect, it } from 'vitest'
import { encodeWav, latencySamples, placeTake, toPcm16 } from '../src/audio/wav'

describe('wav', () => {
  it('converts planar floats to clipped, interleaved 16-bit', () => {
    const pcm = toPcm16([Float32Array.of(0, 1, -1, 2), Float32Array.of(0.5, -0.5, 0, -3)])
    expect([...pcm]).toEqual([0, 16384, 32767, -16384, -32768, 0, 32767, -32768])
  })

  it('writes a canonical header around the chunks', async () => {
    const wav = encodeWav([Int16Array.of(1, 2, 3, 4), Int16Array.of(5, 6)], 2, 48000)
    expect(wav.size).toBe(44 + 12)
    const v = new DataView(await wav.arrayBuffer())
    const tag = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => v.getUint8(o + i)))
    expect([tag(0), tag(8), tag(12), tag(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
    expect(v.getUint32(4, true)).toBe(36 + 12)
    expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint32(28, true), v.getUint16(32, true), v.getUint16(34, true)])
      .toEqual([1, 2, 48000, 192000, 4, 16])
    expect(v.getUint32(40, true)).toBe(12)
    expect([...new Int16Array(await wav.slice(44).arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('take placement', () => {
  it('sums output, base, input and manual latency in samples', () => {
    expect(latencySamples({ output: 0.01, base: 0.005, input: 0.004, manualMs: 6 }, 48000)).toBe(1200)
    expect(latencySamples({ output: 0, base: 0, input: 0, manualMs: -10 }, 48000)).toBe(-480)
  })

  it('moves the clip back by the latency', () => {
    expect(placeTake(96000, 1200, 48000)).toEqual({ start: 94800, sourceOffset: 0, length: 48000 })
  })

  it('trims what would land before the project start', () => {
    expect(placeTake(500, 1200, 48000)).toEqual({ start: 0, sourceOffset: 700, length: 47300 })
    expect(placeTake(0, 100, 50)).toEqual({ start: 0, sourceOffset: 50, length: 0 })
  })

  it('a negative latency (manual offset) moves the clip later', () => {
    expect(placeTake(1000, -100, 10)).toEqual({ start: 1100, sourceOffset: 0, length: 10 })
  })
})
