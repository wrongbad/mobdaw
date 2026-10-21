// The score pane: the doc's MIDI tracks as sheet music (docs/SCORE-PLAN.md, layer 4). `mountScore` reads the doc through the schema getters,
// builds ABC with the pure core (`buildScore`), draws it with abcjs (loaded on first use) and highlights the playing bar.
import { getClips, getDevices, getKey, getMarkers, getNotes, getTimeMap, getTracks } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import { buildScore, scoreTracks, type BuiltScore, type ScoreInput, type ScoreTrack } from './index'

export type ScoreDeps = { doc: Y.Doc; projectId: string }
export type ScoreView = { setPosition(sample: number): void; resize(): void; dispose(): void }

/** Where a tick is in the built score: the index in `bars`, the line (system) holding it and the measure within that line. */
export type Place = { bar: number; line: number; measure: number }

/** The bar holding `tick` (before the first bar: the first; at or past the end: none), its line and its measure within the line. */
export function locate(built: Pick<BuiltScore, 'bars' | 'lines'>, tick: number): Place | null {
  const { bars, lines } = built
  if (!bars.length) return null
  if (tick >= bars[bars.length - 1].endTick) return null
  let lo = 0, hi = bars.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (bars[mid].startTick <= tick) lo = mid
    else hi = mid - 1
  }
  const line = lines.findIndex((l) => l.first <= lo && lo <= l.last)
  return line < 0 ? null : { bar: lo, line, measure: lo - lines[line].first }
}

const hiddenKey = (projectId: string) => `mobdaw.score.hidden.${projectId}`
export function loadHidden(projectId: string): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(hiddenKey(projectId)) ?? '[]')
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}
function saveHidden(projectId: string, hidden: Set<string>) {
  try {
    if (hidden.size) localStorage.setItem(hiddenKey(projectId), JSON.stringify([...hidden]))
    else localStorage.removeItem(hiddenKey(projectId))
  } catch { /* storage blocked: the choice lasts until the page closes */ }
}

type Abcjs = typeof import('abcjs')
let abcjs: Promise<Abcjs> | null = null
const loadAbcjs = () => (abcjs ??= import('abcjs').then((m) => (m as unknown as { default?: Abcjs }).default ?? m))

export function mountScore(host: HTMLElement, deps: ScoreDeps): ScoreView {
  const { doc, projectId } = deps
  host.classList.add('score')
  const chips = h('div', { className: 'score-chips' })
  const hint = h('div', { className: 'score-hint dim' })
  const sheet = h('div', { className: 'score-sheet' })
  const playbar = h('div', { className: 'score-playbar' })
  const body = h('div', { className: 'score-body' }, sheet, playbar, hint)
  host.append(chips, body)

  const hidden = loadHidden(projectId)
  let tracks: ScoreTrack[] = []
  let built: BuiltScore | null = null
  let lastAbc = '', lastWidth = 0
  let dirty = true
  let disposed = false, raf = 0, rendering = false, again = false
  let sample = 0
  let place: Place | null = null

  const input = (): ScoreInput => ({ tracks: getTracks(doc), clips: getClips(doc), notes: getNotes(doc), devices: getDevices(doc), map: getTimeMap(doc), key: getKey(doc), markers: getMarkers(doc) })

  function drawChips() {
    const sig = tracks.map((t) => `${t.id}\0${t.name}\0${t.drums}\0${hidden.has(t.id)}`).join('\n')
    if (chips.dataset.sig === sig) return
    chips.dataset.sig = sig
    chips.replaceChildren(...tracks.map((t) => {
      const b = h('button', { className: 'score-chip', title: `show / hide ${t.name} in the score` }, t.name, ...(t.drums ? [h('span', { className: 'score-chip-hint' }, 'drums')] : []))
      b.classList.toggle('on', !hidden.has(t.id))
      b.onclick = () => {
        if (!hidden.delete(t.id)) hidden.add(t.id)
        saveHidden(projectId, hidden)
        schedule()
      }
      return b
    }))
    chips.hidden = !tracks.length
  }

  function schedule() {
    dirty = true
    if (!raf && !disposed) raf = requestAnimationFrame(() => { raf = 0; void render() })
  }

  async function render() {
    if (disposed || !dirty) return
    const width = body.clientWidth
    if (width <= 0) return // hidden (or not laid out yet): the resize observer calls back when it shows
    if (rendering) { again = true; return }
    rendering = true
    dirty = false
    try {
      const inp = input()
      tracks = scoreTracks(inp)
      drawChips()
      const show = new Set(tracks.filter((t) => !hidden.has(t.id)).map((t) => t.id))
      const next = show.size ? buildScore(inp, { show, width }) : null
      if (!next || next.empty) {
        built = null
        lastAbc = ''
        sheet.replaceChildren()
        hint.textContent = tracks.length ? 'pick a track above' : 'no MIDI notes to show'
        hint.hidden = false
        hidePlaybar()
        return
      }
      hint.hidden = true
      if (next.abc !== lastAbc || width !== lastWidth) {
        const lib = await loadAbcjs()
        if (disposed) return
        const top = body.scrollTop, left = body.scrollLeft
        lib.renderAbc(sheet, next.abc, { staffwidth: next.staffWidth, add_classes: true, responsive: undefined, paddingleft: 0, paddingright: 0, paddingtop: 8, paddingbottom: 8 })
        lastAbc = next.abc
        lastWidth = width
        built = next
        body.scrollTop = top
        body.scrollLeft = left
        place = null // (the elements are new)
        playbar.hidden = true
      } else built = next
      placePlayhead(false)
    } catch (e) {
      console.warn('score:', e)
    } finally {
      rendering = false
      if (again || dirty) { again = false; schedule() }
    }
  }

  function hidePlaybar() {
    playbar.hidden = true
    place = null
  }

  /** The highlight of the bar the transport is in; `follow`: scroll its line into view when the line changed. */
  function placePlayhead(follow: boolean) {
    if (!built || disposed) return
    const p = locate(built, getTimeMap(doc).sampleToTick(sample))
    if (p && place && p.bar === place.bar && !playbar.hidden) return // (the same bar: nothing moves)
    if (!p) return hidePlaybar()
    const wasLine = place?.line
    place = p
    const els = sheet.querySelectorAll<SVGGraphicsElement>(`.abcjs-l${p.line}.abcjs-m${p.measure}`)
    if (!els.length) return void (playbar.hidden = true)
    const host0 = body.getBoundingClientRect()
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity
    for (const e of els) {
      const q = e.getBoundingClientRect()
      if (!q.width && !q.height) continue
      l = Math.min(l, q.left); r = Math.max(r, q.right); t = Math.min(t, q.top); b = Math.max(b, q.bottom)
    }
    if (!isFinite(l)) return void (playbar.hidden = true)
    const x = l - host0.left + body.scrollLeft, y = t - host0.top + body.scrollTop
    playbar.style.cssText = `left:${x - 4}px;top:${y - 6}px;width:${r - l + 8}px;height:${b - t + 12}px`
    playbar.hidden = false
    if (follow || wasLine !== p.line) {
      const top = y - 6, bottom = y + (b - t) + 6
      if (top < body.scrollTop || bottom > body.scrollTop + body.clientHeight) body.scrollTop = Math.max(0, top - 12)
    }
  }

  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { if (dirty || body.clientWidth !== lastWidth) schedule() })
  ro?.observe(body)
  const onUpdate = () => schedule()
  doc.on('update', onUpdate)
  schedule()

  return {
    setPosition(smp) {
      sample = smp
      placePlayhead(false)
    },
    resize() {
      if (dirty || body.clientWidth !== lastWidth) schedule()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      ro?.disconnect()
      doc.off('update', onUpdate)
      host.replaceChildren()
      host.classList.remove('score')
    },
  }
}
