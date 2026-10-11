import type { AudioInfo } from '@mobdaw/shared'

export function bytes(n: number) {
  const units = ['b', 'kb', 'mb', 'gb', 'tb']
  let i = 0
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++
  return `${i === 0 ? n : n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`
}

export const dateOf = (t: number) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).toLowerCase()
export const daysLeft = (t: number) => Math.max(0, Math.ceil((t - Date.now()) / 86_400_000))

/** 90.5 -> "1:30", 3725 -> "1:02:05" */
export function clock(seconds: number) {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/** "wav · 16-bit pcm · 48 khz · stereo · 16:30"; parts that are not known are left out. */
export function describeAudio(i: AudioInfo) {
  const channels = i.channels === 1 ? 'mono' : i.channels === 2 ? 'stereo' : i.channels > 2 ? `${i.channels} channels` : ''
  return [
    i.format === 'unknown' ? '' : i.format, i.encoding, i.sampleRate ? `${+(i.sampleRate / 1000).toFixed(1)} khz` : '', channels,
    i.duration != null ? clock(i.duration) : '',
  ].filter(Boolean).join(' · ').toLowerCase()
}
