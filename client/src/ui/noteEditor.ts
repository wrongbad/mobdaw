// Bare piano-roll panel for one MIDI clip: pitch x tick grid at the clip's own bpm/ppq.
import { addNote, updateClip, updateNote, type MidiClip, type Note } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'

export const PX_BEAT = 48
const ROW = 10
const PMIN = 24
const PMAX = 108
const EDGE = 6
const STEPS = 4 // snap = 1/16 note = a quarter of a beat

export type NoteEditorDeps = {
  doc: Y.Doc
  undo: Y.UndoManager
  readOnly: boolean
  selectNote(id: string | null): void
  close(): void
}

export function noteEditor({ doc, undo, readOnly, selectNote, close }: NoteEditorDeps) {
  let clip: MidiClip | null = null
  let notes = new Map<string, Note>()
  let centered = false
  const els = new Map<string, HTMLElement>()

  const bpm = h('input', { type: 'number', min: 20, max: 400, step: 1, title: 'clip bpm', disabled: readOnly })
  const bars = h('input', { type: 'number', min: 1, step: 1, title: 'length in bars (4/4)', disabled: readOnly })
  bpm.onchange = () => clip && Number(bpm.value) > 0 && updateClip(doc, clip.id, { bpm: Number(bpm.value) })
  bars.onchange = () => clip && Number(bars.value) >= 1 && updateClip(doc, clip.id, { lengthTicks: Math.round(Number(bars.value)) * 4 * clip.ppq })
  const head = h('div', { className: 'ne-head' },
    h('span', { className: 'dim' }, 'MIDI clip'), h('label', {}, 'bpm ', bpm), h('label', {}, 'bars ', bars),
    h('span', { className: 'grow' }), h('button', { className: 'x', title: 'close', onclick: close }, '×'))
  const grid = h('div', { className: 'ne-grid' })
  grid.style.height = `${(PMAX - PMIN + 1) * ROW}px`
  for (let p = PMIN; p <= PMAX; p += 12) {
    const c = h('span', { className: 'ne-c' }, `C${p / 12 - 1}`)
    c.style.top = `${(PMAX - p) * ROW}px`
    grid.append(c)
  }
  const scroll = h('div', { className: 'ne-scroll' }, grid)
  const el = h('div', { className: 'note-ed' }, head, scroll)

  const step = () => clip!.ppq / STEPS
  const px = (ticks: number) => (ticks / clip!.ppq) * PX_BEAT

  grid.onpointerdown = (e) => {
    if (readOnly || e.button !== 0 || !clip) return
    const c = clip
    const r = grid.getBoundingClientRect()
    const noteEl = (e.target as HTMLElement).closest<HTMLElement>('.note')
    if (!noteEl) { // click empty space: add a one-beat note
      const tick = Math.floor((((e.clientX - r.left) / PX_BEAT) * c.ppq) / step()) * step()
      const pitch = Math.min(PMAX, Math.max(PMIN, PMAX - Math.floor((e.clientY - r.top) / ROW)))
      undo.stopCapturing()
      selectNote(addNote(doc, { clipId: c.id, tick: Math.max(0, tick), durTicks: c.ppq, pitch, velocity: 0.8 }))
      undo.stopCapturing()
      return
    }
    const id = noteEl.dataset.id!
    const n0 = notes.get(id)
    selectNote(id)
    if (!n0) return
    e.preventDefault()
    undo.stopCapturing()
    const resize = e.clientX > noteEl.getBoundingClientRect().right - EDGE
    const x0 = e.clientX, y0 = e.clientY
    let last: PointerEvent | null = null
    let pending = 0
    const apply = () => {
      pending = 0
      if (!last) return
      const dTicks = Math.round((((last.clientX - x0) / PX_BEAT) * c.ppq) / step()) * step()
      if (resize) updateNote(doc, id, { durTicks: Math.max(step(), n0.durTicks + dTicks) })
      else {
        const pitch = Math.min(PMAX, Math.max(PMIN, n0.pitch - Math.round((last.clientY - y0) / ROW)))
        updateNote(doc, id, { tick: Math.max(0, n0.tick + dTicks), pitch })
      }
    }
    const move = (m: PointerEvent) => { last = m; if (!pending) pending = requestAnimationFrame(apply) }
    const up = () => {
      cancelAnimationFrame(pending)
      apply()
      undo.stopCapturing()
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  function update(c: MidiClip, list: Note[], selected: string | null) {
    clip = c
    notes = new Map(list.map((n) => [n.id, n]))
    grid.style.width = `${px(c.lengthTicks)}px`
    if (document.activeElement !== bpm) bpm.value = String(c.bpm)
    if (document.activeElement !== bars) bars.value = String(c.lengthTicks / (4 * c.ppq))
    for (const [id, e] of els) if (!notes.has(id)) { e.remove(); els.delete(id) }
    for (const n of list) {
      let e = els.get(n.id)
      if (!e) {
        e = h('div', { className: 'note', 'data-id': n.id })
        els.set(n.id, e)
        grid.append(e)
      }
      e.style.left = `${px(n.tick)}px`
      e.style.top = `${(PMAX - n.pitch) * ROW}px`
      e.style.width = `${Math.max(3, px(n.durTicks))}px`
      e.classList.toggle('sel', n.id === selected)
    }
    if (!centered && el.isConnected) { // start centred on C4
      scroll.scrollTop = (PMAX - 60) * ROW + ROW / 2 - scroll.clientHeight / 2
      centered = true
    }
  }
  return { el, update }
}
