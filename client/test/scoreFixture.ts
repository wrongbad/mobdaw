// Hand-built ScoreInput for the score tests: tracks with one clip each, notes as [tick, durTicks, pitch].
import { timeMap, type Clip, type Device, type Note, type Region, type Track } from '@mobdaw/shared'
import type { ScoreInput } from '../src/score/flatten'

export const PPQ = 960
export const Q = PPQ

export type FixTrack = { name?: string; notes: [number, number, number][]; drumNames?: Record<number, string>; loop?: number; length?: number; role?: 'click' }

export function fixture(tracks: FixTrack[], o: { regions?: Region[]; key?: string; markers?: ScoreInput['markers'] } = {}): ScoreInput {
  const out: ScoreInput = { tracks: [], clips: [], notes: [], devices: [], map: timeMap(o.regions ?? [], 48000, PPQ), key: o.key, markers: o.markers ?? [] }
  tracks.forEach((t, i) => {
    const id = `t${i}`
    out.tracks.push({ id, name: t.name ?? `Track ${i + 1}`, kind: 'midi', order: i, muted: false, soloed: false, ...(t.role ? { role: t.role } : {}) } as Track)
    const last = Math.max(0, ...t.notes.map((n) => n[0] + n[1]))
    out.clips.push({ id: `c${i}`, trackId: id, kind: 'midi', startTick: 0, lengthTicks: t.length ?? Math.ceil(last / (4 * Q)) * 4 * Q, ...(t.loop ? { loopTicks: t.loop } : {}), ...(t.drumNames ? { view: 'drums' as const } : {}) } as Clip)
    t.notes.forEach((n, k) => out.notes.push({ id: `n${i}_${k}`, clipId: `c${i}`, tick: n[0], durTicks: n[1], pitch: n[2], velocity: 0.8 } as Note))
    for (const [key, name] of Object.entries(t.drumNames ?? {})) out.devices.push({ id: `d${i}_${key}`, trackId: id, type: 7, order: Number(key), bypass: false, params: {}, name, keyLo: Number(key), keyHi: Number(key) } as Device)
  })
  return out
}

export const metered = (bar: number, num: number, den: number, extra: Partial<Region> = {}): Region => ({ id: `r${bar}`, bar, kind: 'metered', bpm: 120, num, den, ...extra }) as Region
