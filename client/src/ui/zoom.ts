// The main timeline's zoom: buttons, ctrl-wheel and touch pinch around a point, fit-to-window, and the zoom into an open MIDI editor
// (and back). The scale itself is the timeline's (`pps`, which it keeps in step with its `scale` signal).
import { clipLength } from '@mobdaw/shared'
import type { ProjectStore } from '../project/store'
import type { Selection } from '../project/viewState'
import { editZoomPps } from './autoZoom'
import { MAX_PPS, MIN_PPS, fitPps } from './zoomFit'

export type ZoomDeps = {
  scroll: HTMLElement
  /** The ruler's body: time 0 is at its left edge. */
  rulerBody: HTMLElement
  /** The width of the track headers, which cover the scroller's left edge. */
  header: number
  store: ProjectStore
  sel: Selection
  rate(): number
  pps(): number
  /** Set the zoom (the timeline lays itself out again). */
  setPps(v: number): void
  /** Whether a track's clips are in a source lane (its own time axis: no zoom to them). */
  isSource(trackId: string): boolean
}

export function createZoom(d: ZoomDeps) {
  const { scroll, header } = d
  /** Zoom the timeline by `factor`, keeping the time under screen x `clientX` where it is. */
  function at(factor: number, clientX: number) {
    const t = (clientX - d.rulerBody.getBoundingClientRect().left) / d.pps()
    d.setPps(Math.min(MAX_PPS, Math.max(MIN_PPS, d.pps() * factor)))
    scroll.scrollLeft += header + t * d.pps() - (clientX - scroll.getBoundingClientRect().left) - scroll.scrollLeft
  }
  scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    at(Math.exp(-e.deltaY * 0.01), e.clientX)
  }, { passive: false })
  // Touch pinch: two fingers zoom around their midpoint. (The page itself cannot pinch-zoom, see styles.css; handling
  // the gesture here also keeps iOS Safari from taking it as its tab-overview pinch.)
  let pinch = 0
  const spread = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
  scroll.addEventListener('touchstart', (e) => { pinch = e.touches.length === 2 ? spread(e) : 0 }, { passive: true })
  scroll.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !pinch) return
    if (e.cancelable) e.preventDefault()
    const s = spread(e)
    if (s > 0) at(s / pinch, (e.touches[0].clientX + e.touches[1].clientX) / 2)
    pinch = s
  }, { passive: false })
  scroll.addEventListener('touchend', (e) => { pinch = e.touches.length === 2 ? spread(e) : 0 }, { passive: true })
  scroll.addEventListener('touchcancel', () => (pinch = 0), { passive: true })

  /** Zoom so everything from 0 to the last clip / pad (main timeline only; source lanes have their own time) fits the visible width. */
  let fitRaf = 0
  function fit(tries = 0) {
    cancelAnimationFrame(fitRaf)
    const view = scroll.clientWidth - header
    if (view < 100) { // not laid out yet
      if (tries < 60) fitRaf = requestAnimationFrame(() => fit(tries + 1))
      return
    }
    const rate = d.rate()
    const scapes = new Set(d.store.tracks().filter((t) => t.kind === 'soundscape').map((t) => t.id))
    const end = Math.max(0,
      ...d.store.clips().filter((c) => !scapes.has(c.trackId)).map((c) => c.start + clipLength(c, rate)),
      ...d.store.pads().map((p) => p.start + p.length))
    d.setPps(fitPps(end / rate, view))
    scroll.scrollLeft = 0
  }

  /** The buttons zoom around the middle of what is visible (right of the track headers). */
  function button(factor: number) {
    const r = scroll.getBoundingClientRect()
    at(factor, r.left + header + (r.width - header) / 2)
  }

  // Opening a MIDI clip while zoomed far out zooms in to it (editZoomPps); closing it puts the zoom back, unless the zoom was changed since.
  let zoomedFor: string | null = null
  let saved: { pps: number; left: number; auto: number } | null = null
  /** The open editor changed (an effect on `sel.editing`). */
  function editing(id: string | null) {
    if (id === zoomedFor) return
    zoomedFor = id
    const c = id ? d.store.clipById[id] : undefined
    if (!c) {
      if (saved && d.pps() === saved.auto) {
        const { pps: back, left } = saved
        d.setPps(back)
        requestAnimationFrame(() => (scroll.scrollLeft = left))
      }
      saved = null
      return
    }
    if (c.kind !== 'midi' || d.isSource(c.trackId)) return
    const rate = d.rate()
    const next = editZoomPps(d.pps(), clipLength(c, rate) / rate, 60 / c.bpm, scroll.clientWidth - header)
    if (next == null) return
    saved = saved && saved.auto === d.pps() ? { ...saved, auto: next } : { pps: d.pps(), left: scroll.scrollLeft, auto: next }
    d.setPps(next)
    const left = Math.max(0, (c.start / rate) * next - 8)
    requestAnimationFrame(() => (scroll.scrollLeft = left))
  }

  return { at, button, fit, editing, destroy: () => cancelAnimationFrame(fitRaf) }
}
