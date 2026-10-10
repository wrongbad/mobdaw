// Waveform peaks for clip rendering: max |x| per BUCKET frames (channels folded), drawn on a dB-ish scale.
import { getSampleBuffer } from '../samples'
import { shape } from './probe'

export const BUCKET = 64

const cache = new Map<string, Float32Array>()
const pending = new Set<string>()
const failed = new Set<string>()
const listeners = new Set<() => void>()

/** Called whenever a new set of peaks becomes available. Returns an unsubscribe. */
export function onPeaks(fn: () => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

function compute(buf: AudioBuffer) {
  const out = new Float32Array(Math.ceil(buf.length / BUCKET))
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < out.length; i++) {
      let m = out[i]
      for (let j = i * BUCKET, end = Math.min(j + BUCKET, d.length); j < end; j++) {
        const a = Math.abs(d[j])
        if (a > m) m = a
      }
      out[i] = m
    }
  }
  return out
}

/** Peaks if already computed; otherwise starts the (cached) decode and returns undefined until `onPeaks` fires. */
export function peaksFor(projectId: string, hash: string, rate: number): Float32Array | undefined {
  const k = `${rate}:${hash}`
  const hit = cache.get(k)
  if (hit || pending.has(k) || failed.has(k)) return hit
  pending.add(k)
  getSampleBuffer(projectId, hash, rate)
    .then((buf) => void cache.set(k, compute(buf)), () => void failed.add(k))
    .finally(() => {
      pending.delete(k)
      listeners.forEach((fn) => fn())
    })
  return undefined
}

/** One 1px column per canvas pixel, mirrored about the centre line. */
export function drawWave(cv: HTMLCanvasElement, peaks: Float32Array, fromFrame: number, frames: number) {
  const g = cv.getContext('2d')!
  const { width: w, height: hgt } = cv
  g.clearRect(0, 0, w, hgt)
  g.fillStyle = getComputedStyle(cv).color
  const mid = hgt / 2
  const per = frames / w / BUCKET
  const first = fromFrame / BUCKET
  for (let i = 0; i < w; i++) {
    const a = Math.floor(first + i * per)
    const b = Math.max(a + 1, Math.floor(first + (i + 1) * per))
    let m = 0
    for (let j = a; j < b && j < peaks.length; j++) if (peaks[j] > m) m = peaks[j]
    const half = Math.round(shape(m) * mid)
    g.fillRect(i, mid - half, 1, Math.max(1, half * 2))
  }
}
