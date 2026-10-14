// Drum grid for one MIDI clip: the same notes as the piano roll, a row per drum (an instrument on a single note) and
// a column per step (4 to a beat). Click a cell to toggle a hit. Notes on pitches with no drum row are kept, just not shown.
import { DEVICES, KEY_MIN, addDrum, addNote, deleteNote, isDrum, isLooping, patternTicks, setMidiView, updateClip, updateNote, type Device, type MidiClip, type Note } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import { noteName } from './noteName'
import { FILTER_COLORS } from './filterCurve'
import { clampVelocity, gmDrum, hitOpacity, nextVelocity } from './noteOps'

const STEPS = 4 // steps per beat (a 1/16 note)

export type DrumGridDeps = { doc: Y.Doc; undo: Y.UndoManager; readOnly: boolean }

export function drumGrid({ doc, undo, readOnly }: DrumGridDeps) {
  let clip: MidiClip | null = null
  let notes: Note[] = []
  let pxBeat = 48 // follows the timeline zoom
  let extent = 0 // ticks drawn: the clip's length, or out to the end of the timeline for a `forever` clip

  const bpm = h('input', { type: 'number', min: 20, max: 400, step: 1, title: 'clip bpm', disabled: readOnly })
  const beats = h('input', { type: 'number', min: 1, step: 1, title: 'pattern length in beats (3 for 3/4)', disabled: readOnly })
  const view = h('button', { title: 'show this clip as a piano roll', disabled: readOnly, onclick: () => clip && setMidiView(doc, clip.id, 'piano') }, 'drum grid ▾')
  bpm.onchange = () => clip && Number(bpm.value) > 0 && updateClip(doc, clip.id, { bpm: Number(bpm.value) })
  // The pattern is the loop when the clip loops, else the whole clip.
  beats.onchange = () => {
    const n = Math.round(Number(beats.value))
    if (!clip || !(n >= 1)) return
    updateClip(doc, clip.id, isLooping(clip) ? { loopTicks: n * clip.ppq } : { lengthTicks: n * clip.ppq })
  }
  const head = h('div', { className: 'ne-head' }, view, h('label', {}, 'bpm ', bpm), h('label', {}, 'beats ', beats))
  // inputs must not start a clip drag / zoom-out click on the clip underneath
  head.onpointerdown = (e) => (e.target as HTMLElement).closest('input, label, button') && e.stopPropagation()
  const grid = h('div', { className: 'dg' })
  const scroll = h('div', { className: 'ne-scroll' }, grid)
  scroll.onpointerdown = (e) => e.stopPropagation() // scrollbar drags must not reach the clip
  const el = h('div', { className: 'ne' }, head, scroll)

  const step = () => clip!.ppq / STEPS
  const px = (ticks: number) => (ticks / clip!.ppq) * pxBeat

  /** Toggle the hit at the cell under the pointer: a repeat's cell is its pattern's. */
  function toggle(e: PointerEvent, row: HTMLElement, pitch: number) {
    e.stopPropagation() // the clip underneath would otherwise start dragging
    if (readOnly || e.button !== 0 || !clip) return
    const pattern = patternTicks(clip)
    const at = Math.floor((((e.clientX - row.getBoundingClientRect().left) / pxBeat) * clip.ppq) / step()) * step()
    const tick = at % pattern
    if (tick + step() > pattern + 1e-6 || at >= extent) return
    const here = notes.filter((n) => n.pitch === pitch && n.tick >= tick && n.tick < tick + step())
    undo.stopCapturing()
    if (!here.length) {
      addNote(doc, { clipId: clip.id, tick, durTicks: step(), pitch, velocity: 1 })
      undo.stopCapturing()
      return
    }
    // an existing hit: a click removes it, alt-click steps its velocity down (full, 3/4, 1/2, 1/4), a vertical drag sets it
    const x0 = e.clientX, y0 = e.clientY
    const v0 = here.map((n) => n.velocity)
    let dragged = false
    const move = (m: PointerEvent) => {
      if (!dragged && Math.abs(m.clientY - y0) < 3) return
      dragged = true
      const d = (y0 - m.clientY) / 60
      doc.transact(() => here.forEach((n, i) => updateNote(doc, n.id, { velocity: clampVelocity(v0[i] + d) })))
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      if (!dragged) {
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
    pxBeat = (pps * 60) / c.bpm
    grid.style.setProperty('--beat', `${pxBeat}px`)
    const pattern = patternTicks(c)
    const looping = isLooping(c)
    if (document.activeElement !== bpm) bpm.value = String(c.bpm)
    if (document.activeElement !== beats) beats.value = String(pattern / c.ppq)

    // a row per drum, in the synths lane's order (a wide-range instrument has none)
    const drums = instruments.filter(isDrum)
    const rows = drums.map((d, i) => {
      const key = d.keyLo ?? KEY_MIN
      const row = h('div', { className: 'dg-row' })
      row.style.width = `${px(extent)}px`
      row.onpointerdown = (e) => toggle(e, row, key)
      const color = FILTER_COLORS[i % FILTER_COLORS.length] // the same palette as the loopers and the EQ bands
      row.style.setProperty('--rc', color)
      row.append(h('i', { className: 'dg-edge' }), h('span', { className: 'dg-label' }, `${d.name ?? gmDrum(key) ?? DEVICES[d.type]?.name ?? 'drum'} · ${noteName(key)}`))
      const passes = looping ? Math.ceil(extent / pattern) : 1
      for (const n of notes) {
        if (n.pitch !== key || n.tick < 0 || n.tick >= pattern) continue
        for (let k = 0; k < passes; k++) {
          const tick = k * pattern + n.tick
          if (tick >= extent) break
          const hit = h('i', { className: k ? 'dg-hit rep' : 'dg-hit' })
          hit.style.left = `${px(tick)}px`
          hit.style.opacity = String(hitOpacity(n.velocity) * (k ? 0.35 : 1))
          hit.style.width = `${Math.max(2, px(Math.min(n.durTicks, step())) - 1)}px`
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
    const add = h('button', { className: 'dg-add', title: 'add a lofi drum on the next free note', disabled: readOnly, onclick: () => addDrum(doc, c.trackId) }, '+ add drum')
    add.onpointerdown = (e) => e.stopPropagation()
    grid.replaceChildren(...rows, add)
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
    const visible = hd ? hd.getBoundingClientRect().right : scroller.getBoundingClientRect().left + 146
    grid.style.setProperty('--stick', `${Math.max(0, visible - grid.getBoundingClientRect().left)}px`)
  }
  /** Call when the editor is closed. */
  const reset = () => { watched?.removeEventListener('scroll', stick); watched = null }
  return { el, update, reset }
}
