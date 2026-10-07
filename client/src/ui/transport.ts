// Reusable transport controls: a play/pause button and an elapsed-time readout. The main bar and
// the soundscape lanes (source and loops previews) each have one, bound to their own transport.
import { h } from '../dom'

export const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`

export type TransportControls = ReturnType<typeof transportControls>

export function transportControls(opts: { title: string; onToggle(): void; small?: boolean }) {
  const btn = h('button', { className: 'play', title: opts.title, onclick: opts.onToggle })
  const time = h('span', { className: 'time' }, fmt(0))
  const el = h('div', { className: `transport${opts.small ? ' sm' : ''}` }, btn, time)
  return {
    el,
    /** Shows the pause icon while playing. */
    setPlaying(playing: boolean) {
      if (playing) btn.dataset.playing = ''
      else delete btn.dataset.playing
    },
    setTime(seconds: number) {
      const t = fmt(seconds)
      if (time.textContent !== t) time.textContent = t
    },
  }
}
