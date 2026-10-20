// @vitest-environment jsdom
// The pointer gestures write the doc once, on release: while the pointer moves there is a draft in the store and no doc update.
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { addAudioClip, addMidiClip, addNote, addPad, addTrack, getClips, getNotes, getPads, timeMap, undoScope, type AudioClip, type MidiClip } from '@mobdaw/shared'
import { createProjectStore } from '../src/project/store'
import { createSelection } from '../src/project/viewState'
import { clipDown, padDown, type GestureCtx, type LaneGeo } from '../src/ui/gestures'
import { noteEditor } from '../src/ui/noteEditor'

const RATE = 48000
const PPS = 100 // px per second
const rect = (left: number, width: number, top = 0, height = 20) => ({ left, right: left + width, width, top, bottom: top + height, height, x: left, y: top }) as DOMRect
const box = (r: DOMRect) => { const e = document.createElement('div'); e.getBoundingClientRect = () => r; return e }

const rig = () => {
  const doc = new Y.Doc()
  const undo = new Y.UndoManager(undoScope(doc), { captureTimeout: 500 })
  const awareness = new Awareness(doc)
  const store = createProjectStore({ doc, awareness, remoteStates: () => [] })
  const a = addTrack(doc, 'a', 'audio')
  const m = addTrack(doc, 'm', 'midi')
  const map = timeMap([], RATE, 960)
  const lane = (): LaneGeo => ({ row: box(rect(0, 4000, 0, 100)), body: box(rect(0, 4000, 0, 100)), src: null })
  const lanes = new Map([[a, lane()], [m, lane()]])
  const g: GestureCtx = {
    doc, undo, store, sel: createSelection(), select: () => {},
    geo: {
      rate: () => RATE, map: () => map, pps: () => PPS, position: () => 0, content: box(rect(0, 4000)),
      lane: (id) => lanes.get(id), lanes: () => lanes.entries(), snapLine: () => {},
    },
  }
  let updates = 0
  doc.on('update', () => updates++)
  const press = (x: number, el: HTMLElement) => ({ button: 0, clientX: x, clientY: 10, pointerType: 'mouse', pointerId: 1, currentTarget: el, target: el, preventDefault() {}, stopPropagation() {} }) as unknown as PointerEvent
  const move = (x: number, y = 10, extra: MouseEventInit = {}) => window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, ...extra }))
  const up = () => window.dispatchEvent(new MouseEvent('pointerup'))
  return { doc, undo, store, g, a, m, press, move, up, updates: () => updates, depth: () => undo.undoStack.length }
}

describe('dragging an audio clip', () => {
  it('shows the move at once but writes the doc (one undo step) only on release', () => {
    const r = rig()
    const id = addAudioClip(r.doc, { trackId: r.a, sourceHash: 'h', start: 0, length: RATE })
    r.undo.stopCapturing()
    const base = r.depth(), before = r.updates()
    const el = box(rect(0, 100)) // 1 s at 100 px/s
    clipDown(r.g, r.press(50, el), id)
    r.move(150)
    r.move(250)
    r.move(250) // (the frame flush runs on release)
    r.up()
    expect(r.store.clipById[id]).toBeDefined()
    // released: written once
    expect((getClips(r.doc)[0] as AudioClip).start).toBe(2 * RATE)
    expect(r.updates()).toBe(before + 1)
    expect(r.depth()).toBe(base + 1)
    expect(r.store.clipById[id]).toMatchObject({ start: 2 * RATE })
  })

  it('writes nothing while the pointer is down', () => {
    const r = rig()
    const id = addAudioClip(r.doc, { trackId: r.a, sourceHash: 'h', start: 0, length: RATE })
    const before = r.updates()
    clipDown(r.g, r.press(50, box(rect(0, 100))), id)
    const raf = globalThis.requestAnimationFrame
    r.move(250)
    // a frame later the draft is on the store, the doc untouched
    return new Promise<void>((done) => raf(() => {
      expect((r.store.clipById[id] as AudioClip).start).toBe(2 * RATE)
      expect((getClips(r.doc)[0] as AudioClip).start).toBe(0)
      expect(r.updates()).toBe(before)
      r.up()
      expect(r.updates()).toBe(before + 1)
      done()
    }))
  })

  it('a click without a drag writes nothing', () => {
    const r = rig()
    const id = addAudioClip(r.doc, { trackId: r.a, sourceHash: 'h', start: 0, length: RATE })
    const before = r.updates()
    clipDown(r.g, r.press(50, box(rect(0, 100))), id)
    r.up()
    expect(r.updates()).toBe(before)
    expect(r.store.clipById[id].start).toBe(0)
  })
})

describe('dragging a MIDI clip', () => {
  it('is a draft of ticks until release, then one write', () => {
    const r = rig()
    const id = addMidiClip(r.doc, { trackId: r.m, startTick: 0, lengthTicks: 3840 })
    r.undo.stopCapturing()
    const before = r.updates(), base = r.depth()
    clipDown(r.g, r.press(50, box(rect(0, 200))), id)
    r.move(250) // 2 s: one bar at 120 bpm
    r.up()
    expect((getClips(r.doc)[0] as MidiClip).startTick).toBe(3840)
    expect(r.updates()).toBe(before + 1)
    expect(r.depth()).toBe(base + 1)
  })
  it('trimming the left edge moves the notes in the same transaction', () => {
    const r = rig()
    const id = addMidiClip(r.doc, { trackId: r.m, startTick: 0, lengthTicks: 3840 })
    const n = addNote(r.doc, { clipId: id, tick: 1920, durTicks: 240, pitch: 60, velocity: 1 })
    r.undo.stopCapturing()
    const before = r.updates()
    clipDown(r.g, r.press(1, box(rect(0, 200))), id) // the left edge
    r.move(101) // one second: two beats
    r.up()
    expect(r.updates()).toBe(before + 1)
    const c = getClips(r.doc)[0] as MidiClip
    expect(c.startTick).toBe(1920)
    expect(getNotes(r.doc).find((x) => x.id === n)!.tick).toBe(0)
  })
})

describe('dragging a soundscape region', () => {
  it('writes once on release', () => {
    const r = rig()
    const s = addTrack(r.doc, 's', 'soundscape')
    const id = addPad(r.doc, s, 0, RATE)
    const before = r.updates()
    padDown(r.g, r.press(50, box(rect(0, 100))), id)
    r.move(250)
    expect(r.updates()).toBe(before)
    r.up()
    expect(r.updates()).toBe(before + 1)
    expect(getPads(r.doc)[0].start).toBe(2 * RATE)
  })
})

describe('the note editor', () => {
  const setup = () => {
    const r = rig()
    const clipId = addMidiClip(r.doc, { trackId: r.m, startTick: 0, lengthTicks: 3840 })
    const n = addNote(r.doc, { clipId, tick: 0, durTicks: 480, pitch: 60, velocity: 1 })
    r.undo.stopCapturing()
    const ed = noteEditor({ doc: r.doc, undo: r.undo, store: r.store, selectNote: () => {} })
    document.body.append(ed.el)
    const clip = () => getClips(r.doc)[0] as MidiClip
    const refresh = () => ed.update(r.store.clipById[clipId] as MidiClip, r.store.notesByClip(clipId)().map((x) => ({ ...x })), null, 96)
    refresh()
    const grid = ed.el.querySelector('.ne-grid') as HTMLElement
    grid.getBoundingClientRect = () => rect(0, 2000, 0, 1000)
    const note = ed.el.querySelector('.note') as HTMLElement
    note.getBoundingClientRect = () => rect(0, 20, 100, 10)
    const down = (altKey = false) => {
      const e = new MouseEvent('pointerdown', { clientX: 5, clientY: 105, button: 0, altKey, bubbles: true }) as MouseEvent & { isPrimary: boolean; pointerId: number; pointerType: string }
      Object.assign(e, { isPrimary: true, pointerId: 1, pointerType: 'mouse' })
      note.dispatchEvent(e)
    }
    return { ...r, ed, n, clipId, clip, refresh, down, note }
  }
  const frame = () => new Promise<void>((d) => requestAnimationFrame(() => d()))

  it('a note drag is a draft in the store and one transaction on drop', async () => {
    const r = setup()
    const before = r.updates(), base = r.depth()
    r.down()
    r.move(105)
    await frame()
    expect(r.store.noteById[r.n].tick).toBeGreaterThan(0) // moved in the view...
    expect(getNotes(r.doc)[0].tick).toBe(0) // ...not in the doc
    expect(r.updates()).toBe(before)
    r.up()
    expect(r.updates()).toBe(before + 1)
    expect(r.depth()).toBe(base + 1)
    expect(getNotes(r.doc)[0].tick).toBe(r.store.noteById[r.n].tick)
  })

  it('alt-dragging copies: the copies exist only in the draft until the drop', async () => {
    const r = setup()
    const before = r.updates(), base = r.depth()
    r.down(true)
    r.move(105)
    await frame()
    expect(r.store.notes()).toHaveLength(2)
    expect(getNotes(r.doc)).toHaveLength(1)
    r.up()
    expect(getNotes(r.doc)).toHaveLength(2)
    expect(r.updates()).toBe(before + 1)
    expect(r.depth()).toBe(base + 1)
  })

  it('a second finger cancels the drag and leaves the doc and the undo stack alone', async () => {
    const r = setup()
    const before = r.updates(), base = r.depth()
    r.down(true)
    r.move(105)
    await frame()
    window.dispatchEvent(Object.assign(new MouseEvent('pointerdown'), { pointerId: 2 }))
    expect(r.store.notes()).toHaveLength(1)
    expect(r.store.noteById[r.n].tick).toBe(0)
    r.up()
    expect(r.updates()).toBe(before)
    expect(r.depth()).toBe(base)
    expect(getNotes(r.doc)).toHaveLength(1)
  })
})
