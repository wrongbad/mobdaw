// The imperative canvas drawing of audio clips: waveforms (the visible part only), a looping clip's seams and the take being recorded.
import { isLooping, type Clip } from '@mobdaw/shared'
import { drawWave } from '../audio/peaks'
import { h } from '../dom'

export const LANE_H = 72

/** The elements and memo of one audio clip's waveform. */
export type Wave = { cv: HTMLCanvasElement; seams: HTMLElement; first: HTMLElement; label: HTMLElement; sig: string; pk?: Float32Array; v0: number; v1: number }

export const newWave = (): Wave => ({ cv: h('canvas', { className: 'wave' }), seams: h('i', { className: 'seams' }), first: h('i', { className: 'seam-first' }), label: h('span', { className: 'label' }), sig: '', v0: 0, v1: 0 })

/** The lane's frame: its scale, its horizontal scroller, and how much of the scroller's left edge is covered. */
export type WaveFrame = { pps: number; scroller: HTMLElement; off: number }

/**
 * Waveforms are drawn for the on-screen part of the clip only (plus a viewport of margin each side),
 * at device-pixel resolution, so a 16-minute clip costs the same as a 10-second one.
 * (`w.sig` is what the canvas was last drawn for: a scroll inside its margin draws nothing.)
 */
export function drawVisibleWave(c: Clip & { kind: 'audio' }, w: Pick<Wave, 'cv' | 'sig' | 'pk' | 'v0' | 'v1'>, pk: Float32Array, width: number, f: WaveFrame, rate: number) {
  const dpr = window.devicePixelRatio || 1
  const viewW = f.scroller.clientWidth || innerWidth
  const left = f.off + (c.start / rate) * f.pps // clip's left edge in scroller-content px
  const need0 = Math.max(0, f.scroller.scrollLeft + f.off - left), need1 = Math.min(width, f.scroller.scrollLeft + viewW - left)
  if (need1 <= need0) { w.cv.style.display = 'none'; return }
  const pass = isLooping(c) ? c.loopLength! : 0
  const phase = pass ? c.loopPhase ?? 0 : 0
  const sig = `${f.pps}|${c.sourceOffset}|${c.length}|${pass}|${phase}|${width}|${dpr}`
  if (w.sig === sig && w.pk === pk && w.v0 <= need0 && w.v1 >= need1) { w.cv.style.display = ''; return }
  const v0 = Math.max(0, Math.floor(need0 - viewW)), v1 = Math.min(width, Math.ceil(need1 + viewW))
  Object.assign(w, { sig, pk, v0, v1 })
  w.cv.style.display = ''
  w.cv.style.left = `${v0}px`
  w.cv.style.width = `${v1 - v0}px`
  w.cv.width = Math.max(1, Math.round((v1 - v0) * dpr))
  w.cv.height = Math.round(LANE_H * dpr)
  const fpp = rate / f.pps // source frames per css px
  const passPx = pass / fpp
  if (!pass || passPx < 2) return drawWave(w.cv, pk, c.sourceOffset + v0 * fpp, (v1 - v0) * fpp)
  // A looping clip draws the pass once per repeat: pass k covers clip px [k * passPx - phasePx, (k + 1) * passPx - phasePx),
  // the first (cut by the clip's start) from `phase` into the pass, the repeats faded. Each piece is drawn on a scratch
  // canvas (it must be in the document for drawWave to read the colour) and copied in.
  const phasePx = phase / fpp
  const g = w.cv.getContext('2d')!
  const tmp = h('canvas', { className: 'wave' })
  w.cv.after(tmp)
  g.clearRect(0, 0, w.cv.width, w.cv.height)
  for (let k = Math.max(0, Math.floor((v0 + phasePx) / passPx)); k * passPx - phasePx < v1; k++) {
    const s0 = Math.max(0, k * passPx - phasePx) // the piece in clip px, cut to the clip's start and to what the canvas holds
    const a = Math.max(s0, v0), b = Math.min((k + 1) * passPx - phasePx, v1)
    if (b - a < 1 / dpr) continue
    tmp.width = Math.max(1, Math.round((b - a) * dpr))
    tmp.height = w.cv.height
    drawWave(tmp, pk, c.sourceOffset + (a + phasePx - k * passPx) * fpp, (b - a) * fpp)
    g.globalAlpha = k ? 0.35 : 1
    g.drawImage(tmp, Math.round((a - v0) * dpr), 0)
  }
  g.globalAlpha = 1
  tmp.remove()
}

/** A looping audio clip's seams: a faint line where each pass ends, drawn as one repeating background from the first seam on. */
export function drawSeams(c: Clip & { kind: 'audio' }, w: Pick<Wave, 'seams' | 'first'>, width: number, cpps: number, rate: number) {
  const passPx = ((c.loopLength ?? 0) / rate) * cpps
  const first = (((c.loopLength ?? 0) - (c.loopPhase ?? 0)) / rate) * cpps
  const on = isLooping(c) && passPx >= 3 && first < width
  w.seams.style.display = on ? '' : 'none'
  if (!on) return
  w.seams.style.left = `${first}px`
  w.seams.style.width = `${width - first}px`
  w.seams.style.backgroundSize = `${passPx}px 100%`
  w.first.style.left = `${first - 1}px`
}

/** The take so far, drawn into its growing region (the visible part only). */
export function drawLiveWave(region: HTMLElement, peaks: Float32Array, o: { startPx: number; widthPx: number; header: number; scroller: HTMLElement; rate: number; pps: number }) {
  let cv = region.querySelector('canvas')
  if (!cv) region.prepend((cv = h('canvas', { className: 'wave' })))
  const viewW = o.scroller.clientWidth || innerWidth
  const left = o.header + o.startPx // region's left edge in scroller-content px
  const v0 = Math.max(0, Math.floor(o.scroller.scrollLeft + o.header - left)), v1 = Math.min(Math.ceil(o.widthPx), Math.ceil(o.scroller.scrollLeft + viewW - left))
  if (v1 <= v0) { cv.style.display = 'none'; return }
  const dpr = window.devicePixelRatio || 1
  cv.style.display = ''
  cv.style.left = `${v0}px`
  cv.style.width = `${v1 - v0}px`
  cv.width = Math.max(1, Math.round((v1 - v0) * dpr))
  cv.height = Math.round(LANE_H * dpr)
  const fpp = o.rate / o.pps // frames per css px
  drawWave(cv, peaks, v0 * fpp, (v1 - v0) * fpp)
}
