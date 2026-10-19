// Piano-roll panel for one MIDI clip, inline in the track view: pitch x time, a 3px key hint down the left edge, bar / beat /
// beat-group / sub-beat lines with snap, box select, group edits, a velocity lane and key shortcuts (the pure edits are in
// noteOps.ts). Time is the project's: the x axis follows the timeline's scale through the time map (so bar lines match the ruler,
// 7/8 shows its 2+2+3 groups, a free region has no lines), and notes snap to the map's grid at the clip's place on the timeline.
import { addNote, getPpq, getTimeMap, isLooping, patternTicks, setMidiView, updateClip, updateNote, type MidiClip, type Note, type TimeMap } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import { clamp, dragPointer } from './blocks'
import { lift } from './lift'
import { segmented } from './segmented'
import { deleteMenu } from './popover'
import { HEADER } from './layout'
import { noteName } from './noteName'
import { clipGeom, gridLayout, gridSvg, type ClipGeom } from './gridLines'
import {
  DEFAULT_GRID, GRIDS, PITCH_MAX as PMAX, PITCH_MIN as PMIN, applyPatches, barsToTicks, cancelNoteDrag, centrePitch, clampVelocity, gridTicks, inMarquee, localSnap,
  moveGroup, nudgeVelocity, quantize, removeNotes, resizeGroup, shift, ticksToBars, transpose, velocityAt, type Grid,
} from './noteOps'

const ROW_MIN = 6, ROW_MAX = 40
const EDGE = 6
const VELH = 44 // the velocity lane's height
const SLOP = 3 // px before a press becomes a drag
const BLACK = [1, 3, 6, 8, 10]

export type NoteEditorDeps = {
  doc: Y.Doc
  undo: Y.UndoManager
  selectNote(id: string | null): void
  /** Gate a key on the clip's track's instruments (on) or let it go: the sound while a note is drawn or dragged. */
  noteLive?(trackId: string, pitch: number, velocity: number, on: boolean): void
}

export function noteEditor({ doc, undo, selectNote, noteLive }: NoteEditorDeps) {
  let clip: MidiClip | null = null
  let notes = new Map<string, Note>()
  let centered = false
  let gridSel: Grid = DEFAULT_GRID
  let sel = new Set<string>() // the selected notes; the timeline is told the first (its delete key and its own state)
  let reported: string | null = null
  let map: TimeMap = getTimeMap(doc)
  let ppq = getPpq(doc)
  let geom: ClipGeom = clipGeom(map, 0, 48) // the clip's ticks on the x axis; follows the timeline zoom
  let linesKey = ''
  let row = 14 // px per pitch: pinch (ctrl/cmd + wheel) zooms it
  const els = new Map<string, HTMLElement>()
  const bars = new Map<string, HTMLElement>()

  const barsIn = h('input', { type: 'number', min: 1, step: 1, title: 'pattern length in bars of the project meter' })
  barsIn.onchange = () => {
    if (!clip || !(Number(barsIn.value) >= 1)) return
    const ticks = barsToTicks(map, clip.startTick, Math.round(Number(barsIn.value))) // the pattern: the loop's pass when the clip loops, else the whole clip
    if (!isLooping(clip)) updateClip(doc, clip.id, { lengthTicks: ticks })
    else if (ticks < clip.lengthTicks) updateClip(doc, clip.id, { loopTicks: ticks })
    else if (clip.forever) updateClip(doc, clip.id, { loopTicks: ticks, lengthTicks: ticks * 2 }) // (keeps looping)
    else updateClip(doc, clip.id, { lengthTicks: ticks, loopTicks: 0 }) // the pattern fills the clip: no repeats left
  }
  const view = segmented([{ value: 'piano', label: 'piano roll' }, { value: 'drums', label: 'drums' }], 'piano',
    (v) => clip && setMidiView(doc, clip.id, v === 'drums' ? 'drums' : 'piano'), 'show this clip as a piano roll or a drum grid')
  const gridPick = segmented(GRIDS.map(([g, label]) => ({ value: String(g), label })), String(gridSel),
    (v) => { gridSel = v === 'bar' ? 'bar' : Number(v); linesKey = ''; layoutLines() }, 'grid and snap (hold alt or ctrl while dragging to place freely)')
  const field = (label: string, ...kids: (Node | string)[]) => h('label', { className: 'ne-field' }, h('span', { className: 'ne-lbl' }, label), ...kids)
  const head = h('div', { className: 'ne-head' },
    view.el, h('span', { className: 'ne-sep' }), field('bars', barsIn), h('span', { className: 'ne-sep' }), field('grid', gridPick.el))
  // inputs must not start a clip drag / zoom-out click on the clip underneath
  head.onpointerdown = (e) => (e.target as HTMLElement).closest('input, label, button, select, .seg') && e.stopPropagation()
  const grid = h('div', { className: 'ne-grid' })
  // the vertical lines are an SVG from the time map (layoutLines); the stylesheet's beat-wide gradients are replaced by the pitch rows alone
  grid.style.backgroundImage = 'linear-gradient(to bottom, var(--grid-beat) 1px, transparent 1px)'
  // the keyboard as a 3px edge: black and white keys, one octave of rows repeated down from the top row (PMAX is a C), with a faint
  // octave label on each C row; both hug the left edge of what is visible
  const keys = h('div', { className: 'ne-keys' })
  const octs = new Map<number, HTMLElement>()
  for (let p = PMAX; p >= PMIN; p--) if (p % 12 === 0) { const c = h('span', { className: 'ne-oct' }, noteName(p)); octs.set(p, c); keys.append(c) }
  /** Sound a pitch until released. */
  function audition(pitch: number, velocity: number) {
    if (!clip) return () => {}
    const trackId = clip.trackId
    noteLive?.(trackId, pitch, velocity, true)
    return () => noteLive?.(trackId, pitch, velocity, false)
  }
  const tint = h('div', { className: 'ne-tint' })
  const white = (i: number) => !BLACK.includes((12 - i) % 12)
  const stripes = (on: string, off: string) =>
    `linear-gradient(to bottom, ${Array.from({ length: 12 }, (_, i) => `${white(i) ? on : off} ${i * row}px, ${white(i) ? on : off} ${(i + 1) * row}px`).join(', ')})`
  function layoutRows() {
    grid.style.height = `${(PMAX - PMIN + 1) * row}px`
    grid.style.setProperty('--row', `${row}px`)
    for (const [p, c] of octs) { c.style.top = `${(PMAX - p) * row}px`; c.style.height = `${row}px`; c.style.lineHeight = `${row}px` }
    keys.style.fontSize = `${Math.min(9, Math.max(6, row - 3))}px`
    keys.style.backgroundImage = stripes('#f4eeee', '#000')
    keys.style.backgroundSize = `3px ${12 * row}px`
    tint.style.backgroundImage = stripes('rgba(255, 235, 230, .04)', 'transparent')
    tint.style.backgroundSize = `100% ${12 * row}px`
  }
  layoutRows()
  grid.append(tint, keys)
  /** The keys hug the left edge of what is visible: the clip scrolls under the timeline's sticky track header. */
  function stickKeys() {
    const scroller = grid.closest<HTMLElement>('.scroll')
    if (!scroller) return
    if (scroller !== watched) { watched?.removeEventListener('scroll', stickKeys); scroller.addEventListener('scroll', stickKeys, { passive: true }); watched = scroller }
    const hd = scroller.querySelector<HTMLElement>('.head')
    const visible = hd ? hd.getBoundingClientRect().right : scroller.getBoundingClientRect().left + HEADER
    keys.style.transform = `translateX(${Math.max(0, visible - grid.getBoundingClientRect().left)}px)`
  }
  let watched: HTMLElement | null = null
  /** A note's name inside its block, when the block is big enough to hold it. */
  function labelNote(e: HTMLElement, n: Note) {
    const ok = row >= 10 && parseFloat(e.style.width) >= 24
    e.dataset.n = ok ? noteName(n.pitch) : ''
    e.classList.toggle('named', ok)
  }
  const loopEnd = h('div', { className: 'ne-loop', hidden: true }) // the pattern's end: the notes past it are ignored
  const grip = h('i', { className: 'ne-grip', title: 'drag to change the loop length' }) // ...and its handle
  loopEnd.append(grip)
  const marq = h('div', { className: 'ne-marq', hidden: true })
  grid.append(loopEnd, marq)
  const scroll = h('div', { className: 'ne-scroll' }, grid)
  scroll.onpointerdown = (e) => e.stopPropagation() // scrollbar drags must not reach the clip
  scroll.addEventListener('wheel', (e) => { // ctrl/cmd + wheel (a trackpad pinch) zooms time: it is left to the timeline. With shift it zooms the pitch axis, keeping the pitch under the pointer
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return
    e.preventDefault()
    e.stopPropagation()
    const y = e.clientY - scroll.getBoundingClientRect().top
    const at = (scroll.scrollTop + y) / row
    row = Math.min(ROW_MAX, Math.max(ROW_MIN, row * Math.exp(-e.deltaY * 0.01)))
    layoutRows()
    for (const [id, n] of notes) { const e = els.get(id)!; e.style.top = `${(PMAX - n.pitch) * row}px`; labelNote(e, n) }
    scroll.scrollTop = at * row - y
  }, { passive: false })
  const vel = h('div', { className: 'ne-vel', title: 'velocity: drag a bar (with several notes selected the change is relative)' })
  vel.style.backgroundImage = 'none' // (its bar lines are the same SVG as the grid's)
  const el = h('div', { className: 'ne' }, head, scroll, vel)

  const px = (ticks: number) => geom.x(ticks)
  /** The ticks of one 'bar' grid step at the clip's start (the meter there). */
  const barTicksHere = () => map.meterAt(map.position(clip!.startTick).bar).barTicks
  /** The snap step in ticks (0: off); a note is never shorter than one 1/16 when the grid is off or coarser. */
  const step = () => gridTicks(gridSel, ppq, gridSel === 'bar' ? barTicksHere() : undefined)
  const minDur = () => Math.max(1, Math.min(step() || ppq / 4, ppq / 4))
  const snapOff = (e: { ctrlKey: boolean; altKey: boolean }) => e.ctrlKey || e.altKey
  /** Snap a clip-local tick to the project grid (a whole tick when snapping is off or the clip is in a free region). */
  const snapper = (off: boolean, mode: 'round' | 'floor' = 'round') => (off || !step() ? (t: number) => (mode === 'floor' ? Math.floor(t) : Math.round(t)) : localSnap(map, clip!.startTick, gridSel, mode))
  /** The lines of bars, beats, groups and the grid's own steps, drawn from the map into the grid and the velocity lane. */
  function layoutLines() {
    if (!clip || !lastExtent) return
    const sub = typeof gridSel === 'number' && gridSel > 0 ? step() : 0
    const key = [lastExtent, sub, clip.startTick, lastPps, ppq, lastMapId(map)].join()
    if (key === linesKey) return
    linesKey = key
    const lay = gridLayout(map, clip.startTick, lastExtent, lastPps, sub)
    const width = px(lastExtent)
    grid.querySelector('.ne-lines')?.remove()
    vel.querySelector('.ne-lines')?.remove()
    grid.prepend(gridSvg(lay, width))
    vel.prepend(gridSvg(lay, width, { sub: false }))
  }
  let lastExtent = 0, lastPps = 48
  const mapIds = new WeakMap<TimeMap, number>()
  let mapCount = 0
  const lastMapId = (m: TimeMap) => mapIds.get(m) ?? (mapIds.set(m, ++mapCount), mapCount)

  // --- selection
  function paint() {
    for (const [id, e] of els) {
      e.classList.toggle('sel', sel.has(id))
      bars.get(id)?.classList.toggle('sel', sel.has(id))
    }
  }
  function report() {
    const first = sel.size ? [...sel][0] : null
    reported = first
    selectNote(first)
  }
  function setSel(ids: Iterable<string>, tell = true) {
    sel = new Set(ids)
    paint()
    if (tell) report()
  }
  const selected = () => [...sel].map((id) => notes.get(id)).filter((n): n is Note => !!n)

  // A second pointer (a pinch starting) cancels the note / marquee gesture in progress, leaving nothing behind.
  let active: { id: number; cancel(): void } | null = null
  addEventListener('pointerdown', (e) => { if (active && e.pointerId !== active.id) active.cancel() }, true)
  grid.onpointerdown = (e) => {
    e.stopPropagation() // the clip underneath would otherwise start dragging
    if (e.button !== 0 || !clip || !e.isPrimary) return
    // a finger long-presses to add or drag a note (until then it scrolls); a tap on a note just selects it
    const token = { id: e.pointerId, dead: false, cancel() { this.dead = true; if (active === token) active = null } }
    active = token // (covers the finger's long-press wait)
    lift(e, () => { if (!token.dead) gridDown(e) }, (why) => {
      if (active === token) active = null
      const id = why === 'tap' && !token.dead ? (e.target as HTMLElement).closest<HTMLElement>('.note')?.dataset.id : undefined
      if (id) setSel([id])
    })
  }
  function gridDown(e: PointerEvent) {
    if (!clip) return
    const c = clip
    const r = grid.getBoundingClientRect()
    const noteEl = (e.target as HTMLElement).closest<HTMLElement>('.note')
    e.preventDefault()
    const toggle = e.shiftKey || e.metaKey
    if (!noteEl) return emptyDown(e, c, r, toggle)
    const id = noteEl.dataset.id!
    const n = notes.get(id)
    if (!n) return
    const before = new Set(sel)
    const wasIn = sel.has(id)
    if (!wasIn) setSel(toggle ? [...sel, id] : [id])
    const resize = e.clientX > noteEl.getBoundingClientRect().right - EDGE
    const copying = e.altKey && !resize
    const x0 = e.clientX, y0 = e.clientY
    let group = selected().map((g) => ({ ...g })) // the notes as they were when pressed
    const lead = group.find((g) => g.id === id)!
    let moved = false
    let release: (() => void) | null = resize ? null : audition(n.pitch, n.velocity)
    let sounding = n.pitch
    undo.stopCapturing()
    const depth = undo.undoStack.length // (the drag's first write is the next step)
    const original = group.map((g) => ({ ...g }))
    let copies: string[] = []
    let last: PointerEvent | null = null
    let pending = 0
    const apply = () => {
      pending = 0
      if (!last) return
      const m = last
      if (!moved) {
        if (Math.hypot(m.clientX - x0, m.clientY - y0) < SLOP) return
        moved = true
        if (copying) { // drag the copies; the originals stay
          const ids: string[] = []
          doc.transact(() => group.forEach(({ id: _id, ...g }) => ids.push(addNote(doc, g))))
          group = group.map((g, i) => ({ ...g, id: ids[i] }))
          copies = ids
          setSel(ids)
        }
      }
      const snap = snapper(snapOff(copying ? { ctrlKey: m.ctrlKey, altKey: false } : m))
      const dx = m.clientX - x0
      if (resize) {
        const end0 = lead.tick + lead.durTicks
        const d = snap(geom.tick(geom.x(end0) + dx)) - end0
        patch(resizeGroup(group, d, minDur()))
      } else {
        const d = snap(geom.tick(geom.x(lead.tick) + dx)) - lead.tick
        const dp = -Math.round((m.clientY - y0) / row)
        const moves = moveGroup(group, d, dp)
        patch(moves)
        const to = moves.find((p) => p.id === lead.id)?.pitch ?? sounding
        if (to !== sounding) { // a new pitch retriggers
          release?.()
          sounding = to
          release = audition(sounding, lead.velocity)
        }
      }
    }
    const patch = (ps: { id: string; tick?: number; durTicks?: number; pitch?: number }[]) =>
      doc.transact(() => ps.forEach(({ id: pid, ...p }) => updateNote(doc, pid, p)))
    const move = (m: PointerEvent) => { last = m; if (!pending) pending = requestAnimationFrame(apply) }
    const stop = () => {
      active = null
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
    }
    active = { id: e.pointerId, cancel() { // a second finger: put back whatever the gesture did, without leaving an undo step or touching earlier ones
      cancelAnimationFrame(pending)
      last = null
      stop()
      release?.()
      if (moved) cancelNoteDrag(doc, undo, original, copies, depth)
      undo.stopCapturing()
      setSel(before)
    } }
    const up = () => {
      stop()
      cancelAnimationFrame(pending)
      apply()
      release?.()
      if (!moved && wasIn && toggle) setSel([...sel].filter((s) => s !== id)) // shift-click a selected note: deselect
      else if (!moved && wasIn && !toggle && sel.size > 1) setSel([id]) // a plain click inside a group narrows to that note
      undo.stopCapturing()
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }
  /** Empty space: a drag boxes notes in; a plain click adds a one-beat note at the snapped start (and selects it). */
  function emptyDown(e: PointerEvent, c: MidiClip, r: DOMRect, toggle: boolean) {
    const x0 = e.clientX, y0 = e.clientY
    const base = toggle ? new Set(sel) : new Set<string>()
    const at = (ev: PointerEvent) => [Math.max(0, geom.tick(ev.clientX - r.left)), PMAX - Math.floor((ev.clientY - r.top) / row)] as const
    const [t0, p0] = at(e)
    let boxed = false
    const move = (m: PointerEvent) => {
      if (!boxed && Math.hypot(m.clientX - x0, m.clientY - y0) < SLOP) return
      boxed = true
      const [t1, p1] = at(m)
      marq.hidden = false
      marq.style.left = `${Math.min(m.clientX, x0) - r.left}px`
      marq.style.top = `${Math.min(m.clientY, y0) - r.top}px`
      marq.style.width = `${Math.abs(m.clientX - x0)}px`
      marq.style.height = `${Math.abs(m.clientY - y0)}px`
      const hit = inMarquee([...notes.values()], t0, t1, p0, p1).map((n) => n.id)
      setSel([...base, ...hit], false)
    }
    const stop = () => {
      active = null
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      marq.hidden = true
    }
    const before = new Set(sel)
    active = { id: e.pointerId, cancel() { stop(); if (boxed) setSel(before) } } // (a pinch: no note, the selection as it was)
    const up = () => {
      stop()
      if (boxed) return report()
      const st = snapOff(e) ? 0 : step()
      const tick = Math.max(0, snapper(snapOff(e), 'floor')(t0))
      const pitch = Math.min(PMAX, Math.max(PMIN, p0))
      undo.stopCapturing()
      const id = addNote(doc, { clipId: c.id, tick, durTicks: st >= ppq / 4 && st <= ppq * 4 ? st : ppq, pitch, velocity: 0.8 })
      undo.stopCapturing()
      setSel([id])
      const off = audition(pitch, 0.8)
      setTimeout(off, 180)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  // --- the velocity lane
  vel.onpointerdown = (e) => {
    e.stopPropagation()
    if (e.button !== 0 || !clip) return
    const r = vel.getBoundingClientRect()
    // the bar nearest the pointer, within a few px (a later note on top of an earlier one wins)
    let hit: Note | undefined
    let best = 6
    for (const n of notes.values()) {
      const d = Math.abs(r.left + px(n.tick) - e.clientX)
      if (d <= best) { best = d; hit = n }
    }
    if (!hit) return
    e.preventDefault()
    const group = sel.has(hit.id) && sel.size > 1 ? selected().map((n) => ({ ...n })) : null
    if (!group) setSel([hit.id])
    const v0 = hit.velocity, id = hit.id
    undo.stopCapturing()
    dragPointer(e, {
      onDrag: (m) => {
        const v = velocityAt(m.clientY - r.top, r.height)
        if (group) doc.transact(() => nudgeVelocity(group, v - v0).forEach((p) => updateNote(doc, p.id, { velocity: p.velocity })))
        else updateNote(doc, id, { velocity: v })
      },
      onEnd: () => undo.stopCapturing(),
    })
  }

  grip.onpointerdown = (e) => {
    e.stopPropagation() // not the grid's add-a-note, nor the clip underneath
    if (e.button !== 0 || !clip) return
    const c = clip
    const loop0 = patternTicks(c)
    e.preventDefault()
    undo.stopCapturing()
    const st = () => step() || ppq / 4
    dragPointer(e, {
      onDrag: (m) => {
        const to = snapper(snapOff(m))(geom.tick(geom.x(loop0) + (m.clientX - e.clientX)))
        updateClip(doc, c.id, { loopTicks: clamp(to, st(), c.lengthTicks) })
      },
      onEnd: () => undo.stopCapturing(),
    })
  }

  // --- keys, only while this editor is open: q quantize, arrows transpose / nudge, cmd-a select all, cmd-d duplicate, delete
  const key = (e: KeyboardEvent) => {
    if (!clip || !el.isConnected) return
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()
    const mine = selected()
    const st = step() || ppq / 4
    const done = () => { e.preventDefault(); e.stopImmediatePropagation() }
    if (mod && k === 'a') { done(); setSel(notes.keys()) }
    else if (mod && k === 'd' && mine.length) {
      done()
      const from = Math.min(...mine.map((n) => n.tick)), to = Math.max(...mine.map((n) => n.tick + n.durTicks))
      const span = Math.max(st, Math.ceil((to - from) / st) * st)
      undo.stopCapturing()
      const ids: string[] = []
      doc.transact(() => mine.forEach(({ id: _id, ...n }) => ids.push(addNote(doc, { ...n, tick: n.tick + span }))))
      undo.stopCapturing()
      setSel(ids)
    } else if (mod || e.altKey) return
    else if ((k === 'delete' || k === 'backspace') && mine.length) {
      done()
      removeNotes(doc, undo, mine.map((n) => n.id))
      setSel([])
    } else if (k === 'q') { done(); applyPatches(doc, undo, quantize(mine.length ? mine : [...notes.values()], localSnap(map, clip.startTick, step() ? gridSel : 0.25), 1, false, st)) }
    else if (mine.length && (k === 'arrowup' || k === 'arrowdown')) {
      done()
      const p = transpose(mine, (k === 'arrowup' ? 1 : -1) * (e.shiftKey ? 12 : 1))
      if (p) applyPatches(doc, undo, p)
    } else if (mine.length && (k === 'arrowleft' || k === 'arrowright')) {
      done()
      applyPatches(doc, undo, shift(mine, (k === 'arrowright' ? 1 : -1) * st))
    }
  }
  addEventListener('keydown', key)

  /** `extent` is how many ticks to draw (a `forever` clip is drawn out to the end of the timeline); it defaults to the clip's length. */
  function update(c: MidiClip, list: Note[], selectedId: string | null, pps: number, extent = c.lengthTicks) {
    if (clip && clip.id !== c.id) sel = new Set()
    clip = c
    map = getTimeMap(doc)
    ppq = getPpq(doc)
    geom = clipGeom(map, c.startTick, pps)
    lastExtent = extent
    lastPps = pps
    notes = new Map(list.map((n) => [n.id, n]))
    if (selectedId !== reported) { // changed from outside (cleared on another click, a note deleted)
      sel = new Set(selectedId ? [selectedId] : [])
      reported = selectedId
    }
    for (const id of [...sel]) if (!notes.has(id)) sel.delete(id)
    layoutLines()
    grid.style.width = `${px(extent)}px`
    vel.style.width = `${px(extent)}px`
    if (document.activeElement !== barsIn) barsIn.value = String(Math.round(ticksToBars(map, c.startTick, patternTicks(c)) * 100) / 100)
    gridPick.set(String(gridSel))
    const looping = isLooping(c)
    loopEnd.hidden = !looping
    if (looping) {
      loopEnd.style.left = `${px(c.loopTicks!)}px`
      loopEnd.style.width = `${px(extent - c.loopTicks!)}px`
    }
    for (const [id, e] of els) if (!notes.has(id)) { e.remove(); els.delete(id); bars.get(id)?.remove(); bars.delete(id) }
    for (const n of list) {
      let e = els.get(n.id)
      if (!e) {
        e = h('div', { className: 'note', 'data-id': n.id })
        deleteMenu(e, 'delete note', () => removeNotes(doc, undo, sel.has(n.id) ? [...sel] : [n.id]))
        els.set(n.id, e)
        grid.append(e)
        const b = h('i', { className: 'ne-bar' })
        bars.set(n.id, b)
        vel.append(b)
      }
      e.style.left = `${px(n.tick)}px`
      e.style.top = `${(PMAX - n.pitch) * row}px`
      e.style.width = `${Math.max(3, px(n.durTicks))}px`
      labelNote(e, n)
      e.style.setProperty('--vel', String(0.45 + 0.55 * clampVelocity(n.velocity)))
      e.classList.toggle('ignored', looping && n.tick >= c.loopTicks!)
      const b = bars.get(n.id)!
      b.style.left = `${px(n.tick)}px`
      b.style.height = `${clampVelocity(n.velocity) * (VELH - 4)}px`
      b.classList.toggle('ignored', looping && n.tick >= c.loopTicks!)
    }
    paint()
    stickKeys()
    centre(list)
  }
  /** Centre on the notes (c4 when empty) once the panel has a height: before it is laid out there is nothing to measure. */
  function centre(list: Note[] = [...notes.values()]) {
    if (centered || !el.isConnected || !scroll.clientHeight) return
    scroll.scrollTop = (PMAX - centrePitch(list)) * row + row / 2 - scroll.clientHeight / 2
    centered = true
  }
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { centre(); stickKeys() })
  ro?.observe(scroll)
  /** Call when the editor is closed so the next open re-centres. */
  const reset = () => { centered = false; sel = new Set(); reported = null }
  const destroy = () => { removeEventListener('keydown', key); ro?.disconnect(); watched?.removeEventListener('scroll', stickKeys) }
  return { el, update, reset, destroy }
}
