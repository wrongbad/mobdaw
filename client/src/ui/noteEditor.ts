// Bare piano-roll panel for one MIDI clip: pitch x tick grid at the clip's own bpm/ppq.
import { addNote, deleteNote, isLooping, patternTicks, setMidiView, updateClip, updateNote, type MidiClip, type Note } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import { clamp, dragPointer } from './blocks'
import { lift } from './lift'
import { deleteMenu } from './popover'

const ROW_MIN = 6, ROW_MAX = 40
const PMIN = 12 // c0
const PMAX = 108
const EDGE = 6
const STEPS = 4 // snap = 1/16 note = a quarter of a beat

export type NoteEditorDeps = {
  doc: Y.Doc
  undo: Y.UndoManager
  readOnly: boolean
  selectNote(id: string | null): void
  /** Gate a key on the clip's track's instruments (on) or let it go: the sound while a note is drawn or dragged. */
  noteLive?(trackId: string, pitch: number, velocity: number, on: boolean): void
}

export function noteEditor({ doc, undo, readOnly, selectNote, noteLive }: NoteEditorDeps) {
  let clip: MidiClip | null = null
  let notes = new Map<string, Note>()
  let centered = false
  let pxBeat = 48 // follows the timeline zoom
  let row = 14 // px per pitch: pinch (ctrl/cmd + wheel) zooms it
  const els = new Map<string, HTMLElement>()

  const bpm = h('input', { type: 'number', min: 20, max: 400, step: 1, title: 'clip bpm', disabled: readOnly })
  const bars = h('input', { type: 'number', min: 1, step: 1, title: 'pattern length in bars (4/4)', disabled: readOnly })
  bpm.onchange = () => clip && Number(bpm.value) > 0 && updateClip(doc, clip.id, { bpm: Number(bpm.value) })
  bars.onchange = () => {
    if (!clip || !(Number(bars.value) >= 1)) return
    const ticks = Math.round(Number(bars.value)) * 4 * clip.ppq // the pattern: the loop's pass when the clip loops, else the whole clip
    if (!isLooping(clip)) updateClip(doc, clip.id, { lengthTicks: ticks })
    else if (ticks < clip.lengthTicks) updateClip(doc, clip.id, { loopTicks: ticks })
    else if (clip.forever) updateClip(doc, clip.id, { loopTicks: ticks, lengthTicks: ticks * 2 }) // (keeps looping)
    else updateClip(doc, clip.id, { lengthTicks: ticks, loopTicks: 0 }) // the pattern fills the clip: no repeats left
  }
  const view = h('button', { title: 'show this clip as a drum grid', disabled: readOnly, onclick: () => clip && setMidiView(doc, clip.id, 'drums') }, 'piano roll ▾')
  const head = h('div', { className: 'ne-head' },
    view, h('label', {}, 'bpm ', bpm), h('label', {}, 'bars ', bars))
  // inputs must not start a clip drag / zoom-out click on the clip underneath
  head.onpointerdown = (e) => (e.target as HTMLElement).closest('input, label, button') && e.stopPropagation()
  const grid = h('div', { className: 'ne-grid' })
  const labels: [HTMLElement, number][] = []
  for (let p = PMIN; p <= PMAX; p += 12) {
    const c = h('span', { className: 'ne-c' }, `c${p / 12 - 1}`)
    labels.push([c, p])
    grid.append(c)
  }
  // the keyboard as a 3px edge: black and white keys, one octave of rows repeated down from the top row (PMAX is a C)
  const keys = h('div', { className: 'ne-keys' })
  const BLACK = [1, 3, 6, 8, 10]
  const white = (i: number) => !BLACK.includes((12 - i) % 12)
  const octave = Array.from({ length: 12 }, (_, i) => (white(i) ? '#f4eeee' : '#000'))
  const stripes = (on: string, off: string) => (rowPx: number) =>
    `linear-gradient(to bottom, ${Array.from({ length: 12 }, (_, i) => `${white(i) ? on : off} ${i * rowPx}px, ${white(i) ? on : off} ${(i + 1) * rowPx}px`).join(', ')})`
  const tintStripes = stripes('rgba(255, 235, 230, .04)', 'transparent') // a faint lift across the white keys' rows
  const tint = h('div', { className: 'ne-tint' })
  function layoutRows() {
    grid.style.height = `${(PMAX - PMIN + 1) * row}px`
    grid.style.setProperty('--row', `${row}px`)
    for (const [c, p] of labels) c.style.top = `${(PMAX - p) * row}px`
    keys.style.backgroundImage = `linear-gradient(to bottom, ${octave.map((c, i) => `${c} ${i * row}px, ${c} ${(i + 1) * row}px`).join(', ')})`
    keys.style.backgroundSize = `100% ${12 * row}px`
    tint.style.backgroundImage = tintStripes(row)
    tint.style.backgroundSize = `100% ${12 * row}px`
  }
  layoutRows()
  grid.prepend(tint)
  grid.append(keys)
  /** The keys hug the left edge of what is visible: the clip scrolls under the timeline's sticky track header. */
  function stickKeys() {
    const scroller = grid.closest<HTMLElement>('.scroll')
    if (!scroller) return
    const head = scroller.querySelector<HTMLElement>('.head')
    const visible = head ? head.getBoundingClientRect().right : scroller.getBoundingClientRect().left + 146
    keys.style.transform = `translateX(${Math.max(0, visible - grid.getBoundingClientRect().left)}px)`
  }
  const loopEnd = h('div', { className: 'ne-loop', hidden: true }) // the pattern's end: the notes past it are ignored
  const grip = h('i', { className: 'ne-grip', title: readOnly ? '' : 'drag to change the loop length' }) // ...and its handle
  loopEnd.append(grip)
  grid.append(loopEnd)
  const scroll = h('div', { className: 'ne-scroll' }, grid)
  scroll.onpointerdown = (e) => e.stopPropagation() // scrollbar drags must not reach the clip
  scroll.addEventListener('wheel', (e) => { // pinch (a trackpad pinch arrives as ctrl + wheel): zoom the pitch axis, keeping the pitch under the pointer
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return // (shift: the timeline's horizontal zoom)
    e.preventDefault()
    e.stopPropagation()
    const y = e.clientY - scroll.getBoundingClientRect().top
    const at = (scroll.scrollTop + y) / row
    row = Math.min(ROW_MAX, Math.max(ROW_MIN, row * Math.exp(-e.deltaY * 0.01)))
    layoutRows()
    for (const [id, n] of notes) els.get(id)!.style.top = `${(PMAX - n.pitch) * row}px`
    scroll.scrollTop = at * row - y
  }, { passive: false })
  const el = h('div', { className: 'ne' }, head, scroll)

  const step = () => clip!.ppq / STEPS
  const px = (ticks: number) => (ticks / clip!.ppq) * pxBeat

  grid.onpointerdown = (e) => {
    e.stopPropagation() // the clip underneath would otherwise start dragging
    if (readOnly || e.button !== 0 || !clip) return
    // a finger long-presses to add or drag a note (until then it scrolls); a tap on a note just selects it
    lift(e, () => gridDown(e), (why) => {
      const id = why === 'tap' ? (e.target as HTMLElement).closest<HTMLElement>('.note')?.dataset.id : undefined
      if (id) selectNote(id)
    })
  }
  function gridDown(e: PointerEvent) {
    if (!clip) return
    const c = clip
    const r = grid.getBoundingClientRect()
    const noteEl = (e.target as HTMLElement).closest<HTMLElement>('.note')
    let id: string
    let n0: { tick: number; durTicks: number; pitch: number; velocity: number }
    let resize = false
    undo.stopCapturing()
    if (!noteEl) { // click empty space: add a one-beat note (and keep dragging it)
      const tick = Math.floor((((e.clientX - r.left) / pxBeat) * c.ppq) / step()) * step()
      const pitch = Math.min(PMAX, Math.max(PMIN, PMAX - Math.floor((e.clientY - r.top) / row)))
      n0 = { tick: Math.max(0, tick), durTicks: c.ppq, pitch, velocity: 0.8 }
      id = addNote(doc, { clipId: c.id, ...n0 })
      selectNote(id)
      undo.stopCapturing()
    } else {
      id = noteEl.dataset.id!
      const n = notes.get(id)
      selectNote(id)
      if (!n) return
      n0 = n
      resize = e.clientX > noteEl.getBoundingClientRect().right - EDGE
    }
    e.preventDefault()
    const x0 = e.clientX, y0 = e.clientY
    let sounding = resize ? -1 : n0.pitch // the key held down while the pointer is (-1: none)
    if (sounding >= 0) noteLive?.(c.trackId, sounding, n0.velocity, true)
    let last: PointerEvent | null = null
    let pending = 0
    const apply = () => {
      pending = 0
      if (!last) return
      const dTicks = Math.round((((last.clientX - x0) / pxBeat) * c.ppq) / step()) * step()
      if (resize) updateNote(doc, id, { durTicks: Math.max(step(), n0.durTicks + dTicks) })
      else {
        const pitch = Math.min(PMAX, Math.max(PMIN, n0.pitch - Math.round((last.clientY - y0) / row)))
        updateNote(doc, id, { tick: Math.max(0, n0.tick + dTicks), pitch })
        if (pitch !== sounding) { // a new pitch retriggers
          noteLive?.(c.trackId, sounding, n0.velocity, false)
          sounding = pitch
          noteLive?.(c.trackId, sounding, n0.velocity, true)
        }
      }
    }
    const move = (m: PointerEvent) => { last = m; if (!pending) pending = requestAnimationFrame(apply) }
    const up = () => {
      cancelAnimationFrame(pending)
      apply()
      if (sounding >= 0) noteLive?.(c.trackId, sounding, n0.velocity, false)
      undo.stopCapturing()
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  grip.onpointerdown = (e) => {
    e.stopPropagation() // not the grid's add-a-note, nor the clip underneath
    if (readOnly || e.button !== 0 || !clip) return
    const c = clip
    const loop0 = patternTicks(c)
    e.preventDefault()
    undo.stopCapturing()
    dragPointer(e, {
      onDrag: (m) => {
        const dTicks = ((m.clientX - e.clientX) / pxBeat) * c.ppq
        updateClip(doc, c.id, { loopTicks: clamp(Math.round((loop0 + dTicks) / step()) * step(), step(), c.lengthTicks) })
      },
      onEnd: () => undo.stopCapturing(),
    })
  }

  /** `extent` is how many ticks to draw (a `forever` clip is drawn out to the end of the timeline); it defaults to the clip's length. */
  function update(c: MidiClip, list: Note[], selected: string | null, pps: number, extent = c.lengthTicks) {
    clip = c
    pxBeat = (pps * 60) / c.bpm
    grid.style.setProperty('--beat', `${pxBeat}px`)
    notes = new Map(list.map((n) => [n.id, n]))
    grid.style.width = `${px(extent)}px`
    if (document.activeElement !== bpm) bpm.value = String(c.bpm)
    if (document.activeElement !== bars) bars.value = String(patternTicks(c) / (4 * c.ppq))
    const looping = isLooping(c)
    loopEnd.hidden = !looping
    if (looping) {
      loopEnd.style.left = `${px(c.loopTicks!)}px`
      loopEnd.style.width = `${px(extent - c.loopTicks!)}px`
    }
    for (const [id, e] of els) if (!notes.has(id)) { e.remove(); els.delete(id) }
    for (const n of list) {
      let e = els.get(n.id)
      if (!e) {
        e = h('div', { className: 'note', 'data-id': n.id })
        deleteMenu(e, 'delete note', () => deleteNote(doc, n.id), () => !readOnly)
        els.set(n.id, e)
        grid.append(e)
      }
      e.style.left = `${px(n.tick)}px`
      e.style.top = `${(PMAX - n.pitch) * row}px`
      e.style.width = `${Math.max(3, px(n.durTicks))}px`
      e.classList.toggle('sel', n.id === selected)
      e.classList.toggle('ignored', looping && n.tick >= c.loopTicks!)
    }
    stickKeys()
    if (!centered && el.isConnected) { // centre on the notes (C4 when empty)
      const mid = list.length ? (Math.min(...list.map((n) => n.pitch)) + Math.max(...list.map((n) => n.pitch))) / 2 : 60
      scroll.scrollTop = (PMAX - mid) * row + row / 2 - scroll.clientHeight / 2
      centered = true
    }
  }
  /** Call when the editor is closed so the next open re-centres. */
  const reset = () => { centered = false }
  return { el, update, reset }
}
