// Drum grid for one MIDI clip: the same notes as the piano roll, a row per drum (an instrument on a single note) and
// a column per step. A step is a 1/16 note (ppq / 4 ticks) counted from each bar line, so a 4/4 bar has 16 and a 7/8 bar 14
// (2+2+3 eighths, each eighth two steps); a bar that does not divide evenly ends with a short step. The columns follow the
// project's time map at the clip's place on the timeline, so a clip crossing a meter change is re-gridded bar by bar, and a free
// region has no columns (it cannot be clicked, existing hits there are still drawn). Click a cell to toggle a hit. Notes on
// pitches with no drum row are kept, just not shown.
import { DEVICES, KEY_MIN, addDrum, addNote, deleteNote, getPpq, getTimeMap, isDrum, isLooping, patternTicks, setMidiView, updateClip, updateNote, type Device, type Moving, type MidiClip, type Note, type TimeMap } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import { commitMoving } from '../project/draft'
import type { ProjectStore } from '../project/store'
import { drumColor } from './drumColor'
import { segmented } from './segmented'
import { barsToTicks, clampVelocity, gmDrum, hitOpacity, nextVelocity, ticksToBars } from './noteOps'
import { clipGeom, gridLayout, gridSvg, type ClipGeom } from './gridLines'
import { HEADER } from './layout'

const STEPS = 4 // steps per quarter note (a 1/16 note)

/**
 * The step cell holding the clip-local tick `t` of a clip at `startTick`: its start and length in clip ticks, or null in a free region
 * (no grid). Steps are `ppq / STEPS` long from the bar line; the last step of a bar is cut at the bar line.
 */
export function stepCell(map: TimeMap, startTick: number, t: number): { tick: number; len: number } | null {
  const g = startTick + t
  const p = map.position(g)
  if (p.free) return null
  const barTicks = map.meterAt(p.bar).barTicks
  const step = map.ppq / STEPS
  const at = Math.min(Math.floor(p.tickInBar / step + 1e-9) * step, barTicks)
  return { tick: g - p.tickInBar + at - startTick, len: Math.min(step, barTicks - at) }
}

export type DrumGridDeps = { doc: Y.Doc; undo: Y.UndoManager; store: Pick<ProjectStore, 'setDraft' | 'clearDraft'> }

export function drumGrid({ doc, undo, store }: DrumGridDeps) {
  let clip: MidiClip | null = null
  let notes: Note[] = []
  let map: TimeMap = getTimeMap(doc)
  let ppq = getPpq(doc)
  let geom: ClipGeom = clipGeom(map, 0, 48) // the clip's ticks on the x axis; follows the timeline zoom
  let extent = 0 // ticks drawn: the clip's length, or out to the end of the timeline for a `forever` clip

  const bars = h('input', { type: 'number', min: 1, step: 1, title: 'pattern length in bars of the project meter' })
  const view = segmented([{ value: 'piano', label: 'piano roll' }, { value: 'drums', label: 'drums' }], 'drums',
    (v) => clip && setMidiView(doc, clip.id, v === 'drums' ? 'drums' : 'piano'), 'show this clip as a piano roll or a drum grid')
  const field = (label: string, ...kids: (Node | string)[]) => h('label', { className: 'ne-field' }, h('span', { className: 'ne-lbl' }, label), ...kids)
  // The pattern is the loop when the clip loops, else the whole clip.
  bars.onchange = () => {
    const n = Math.round(Number(bars.value))
    if (!clip || !(n >= 1)) return
    const ticks = barsToTicks(map, clip.startTick, n)
    updateClip(doc, clip.id, isLooping(clip) ? { loopTicks: ticks } : { lengthTicks: ticks })
  }
  const head = h('div', { className: 'ne-head' }, view.el, h('span', { className: 'ne-sep' }), field('bars', bars))
  // inputs must not start a clip drag / zoom-out click on the clip underneath
  head.onpointerdown = (e) => (e.target as HTMLElement).closest('input, label, button, .seg') && e.stopPropagation()
  const grid = h('div', { className: 'dg' })
  grid.style.background = 'var(--bg)'
  const scroll = h('div', { className: 'ne-scroll' }, grid)
  scroll.onpointerdown = (e) => e.stopPropagation() // scrollbar drags must not reach the clip
  const el = h('div', { className: 'ne' }, head, scroll)

  const px = (ticks: number) => geom.x(ticks)

  /** Toggle the hit at the cell under the pointer: a repeat's cell is its pattern's. */
  function toggle(e: PointerEvent, row: HTMLElement, pitch: number) {
    e.stopPropagation() // the clip underneath would otherwise start dragging
    if (e.button !== 0 || !clip) return
    const pattern = patternTicks(clip)
    const at = geom.tick(e.clientX - row.getBoundingClientRect().left)
    if (at < 0 || at >= extent) return
    const cell = stepCell(map, clip.startTick, at % pattern) // (a repeat's cell is the pattern's)
    if (!cell || cell.tick + cell.len > pattern + 1e-6) return
    const { tick, len } = cell
    const here = notes.filter((n) => n.pitch === pitch && n.tick >= tick - 1e-6 && n.tick < tick + len - 1e-6)
    undo.stopCapturing()
    if (!here.length) {
      addNote(doc, { clipId: clip.id, tick, durTicks: len, pitch, velocity: 1 })
      undo.stopCapturing()
      return
    }
    // an existing hit: a click removes it, alt-click steps its velocity down (full, 3/4, 1/2, 1/4), a vertical drag sets it
    const y0 = e.clientY
    const v0 = here.map((n) => n.velocity)
    let dragged = false
    let draft: Moving | null = null // (the velocity under the pointer: the notes are written on release)
    const move = (m: PointerEvent) => {
      if (!dragged && Math.abs(m.clientY - y0) < 3) return
      dragged = true
      const d = (y0 - m.clientY) / 60
      store.setDraft((draft = { notes: Object.fromEntries(here.map((n, i) => [n.id, { velocity: clampVelocity(v0[i] + d) }])) }))
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      if (dragged) {
        if (draft) commitMoving(doc, undo, draft)
        store.clearDraft()
      } else {
        if (e.altKey) doc.transact(() => here.forEach((n) => updateNote(doc, n.id, { velocity: nextVelocity(n.velocity) })))
        else doc.transact(() => here.forEach((n) => deleteNote(doc, n.id)))
      }
      undo.stopCapturing()
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  function update(c: MidiClip, list: Note[], instruments: Device[], pps: number, ticks = c.lengthTicks) {
    clip = c
    extent = ticks
    notes = list
    map = getTimeMap(doc)
    ppq = getPpq(doc)
    geom = clipGeom(map, c.startTick, pps)
    const pattern = patternTicks(c)
    const looping = isLooping(c)
    if (document.activeElement !== bars) bars.value = String(Math.round(ticksToBars(map, c.startTick, pattern) * 100) / 100)

    // a row per drum, in the synths lane's order (a wide-range instrument has none)
    const drums = instruments.filter(isDrum)
    const rows = drums.map((d) => {
      const key = d.keyLo ?? KEY_MIN
      const row = h('div', { className: 'dg-row' })
      row.style.width = `${px(extent)}px`
      row.style.backgroundImage = 'none' // (the columns are one SVG behind the rows)
      row.style.backgroundColor = 'transparent'
      row.onpointerdown = (e) => toggle(e, row, key)
      const color = drumColor(key) // shared with the synth drawer's drum cards
      row.style.setProperty('--rc', color)
      row.append(h('i', { className: 'dg-edge' }), h('span', { className: 'dg-label' }, `${d.name ?? gmDrum(key) ?? DEVICES[d.type]?.name ?? 'drum'}`))
      const passes = looping ? Math.ceil(extent / pattern) : 1
      for (const n of notes) {
        if (n.pitch !== key || n.tick < 0 || n.tick >= pattern) continue
        for (let k = 0; k < passes; k++) {
          const tick = k * pattern + n.tick
          if (tick >= extent) break
          const hit = h('i', { className: k ? 'dg-hit rep' : 'dg-hit' })
          hit.style.left = `${px(tick)}px`
          hit.style.opacity = String(hitOpacity(n.velocity) * (k ? 0.35 : 1))
          hit.style.width = `${Math.max(2, px(tick + Math.min(n.durTicks, ppq / STEPS)) - px(tick) - 1)}px`
          row.append(hit)
        }
      }
      if (looping) {
        const rep = h('i', { className: 'dg-rep' }) // the repeats: shaded, and not a place of their own
        rep.style.left = `${px(pattern)}px`
        row.append(rep)
      }
      return row
    })
    const add = h('button', { className: 'dg-add', title: 'add a lofi drum on the next free note', onclick: () => addDrum(doc, c.trackId) }, '+ add drum')
    add.onpointerdown = (e) => e.stopPropagation()
    grid.replaceChildren(gridSvg(gridLayout(map, c.startTick, extent, pps, ppq / STEPS, 3), px(extent)), ...rows, add)
    grid.style.width = `${px(extent)}px`
    stick()
  }
  /** The row hints and names hug the left edge of what is visible: the clip scrolls under the timeline's sticky track header. */
  let watched: HTMLElement | null = null
  function stick() {
    const scroller = grid.closest<HTMLElement>('.scroll')
    if (!scroller) return
    if (scroller !== watched) { watched?.removeEventListener('scroll', stick); scroller.addEventListener('scroll', stick, { passive: true }); watched = scroller }
    const hd = scroller.querySelector<HTMLElement>('.head')
    const visible = hd ? hd.getBoundingClientRect().right : scroller.getBoundingClientRect().left + HEADER
    grid.style.setProperty('--stick', `${Math.max(0, visible - grid.getBoundingClientRect().left)}px`)
  }
  /** Call when the editor is closed. */
  const reset = () => { watched?.removeEventListener('scroll', stick); watched = null }
  return { el, update, reset }
}
