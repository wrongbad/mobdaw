// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { createSignal } from 'solid-js'
import { addAudioClip, addLooper, addMidiClip, addNote, addPad, addTrack, clipsMap, deleteClip, notesMap, padsMap, tracksMap, updateClip, updateLooper, updateNote, updateTrack, type AwarenessState } from '@mobdaw/shared'
import { createProjectStore } from '../src/project/store'
import { createSelection } from '../src/project/viewState'
import { mountLaneBody, mountSourceBody, type ClipsCtx, type SrcView } from '../src/ui/clips'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))

const RATE = 48000
function setup(readOnly = false) {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  let peers: AwarenessState[] = []
  const store = createProjectStore({ doc, awareness, remoteStates: () => peers })
  const sel = createSelection()
  const [scale, setScale] = createSignal({ pps: 100, rate: RATE })
  const [total, setTotal] = createSignal(60 * RATE)
  const [pos, setPos] = createSignal(0)
  const [take, setTake] = createSignal<{ trackId: string; start: number } | null>(null)
  const editor = () => ({ el: document.createElement('div'), update: vi.fn(), reset: vi.fn(), destroy() {} })
  const ne = editor(), dg = editor()
  const ctx = {
    doc, undo: new Y.UndoManager([tracksMap(doc), clipsMap(doc)]), readOnly, store, sel,
    geo: { rate: () => RATE, pps: () => scale().pps, position: () => 0, lane: () => undefined, lanes: () => [], content: document.body, snapLine() {} },
    select: (ids: string[]) => sel.selectClips(ids),
    scale, total, ready: () => false, peaks: () => 0, viewW: () => 1000, scrollX: () => 0, scroller: document.body, header: 146, projectId: 'p',
    ne, dg, menu: () => [], incomingLabel: () => '', myTake: take, position: pos, drawLive() {},
  } as unknown as ClipsCtx
  cleanup.push(() => store.dispose())
  const setPeers = (p: AwarenessState[]) => ((peers = p), awareness.emit('change', [{ added: [], updated: [], removed: [] }, 'test']))
  return { doc, store, sel, ctx, ne, dg, setScale, setTotal, setPos, setTake, setPeers }
}
type T = ReturnType<typeof setup>
const lane = (t: T, trackId: string, kind = 'midi') => {
  const host = document.createElement('div')
  document.body.append(host)
  const off = mountLaneBody(host, t.ctx, trackId, kind)
  cleanup.push(() => (off(), host.remove()))
  return host
}
const clips = (host: Element) => [...host.querySelectorAll<HTMLElement>('.clip:not(.recording):not(.region)')]
const px = (el: HTMLElement) => parseFloat(el.style.left)

describe('clips', () => {
  it('keep their identity across unrelated doc changes, awareness and playhead ticks', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a', 'midi'), b = addTrack(t.doc, 'b', 'midi')
    addMidiClip(t.doc, { trackId: a, start: 0 })
    addMidiClip(t.doc, { trackId: a, start: 4 * RATE })
    const other = addMidiClip(t.doc, { trackId: b, start: 0 })
    const host = lane(t, a)
    const els = clips(host)
    expect(els.length).toBe(2)
    // an unrelated clip and track change, a note, a new track, a peer moving, ticks of the playhead and of a growing take
    updateClip(t.doc, other, { start: 10 })
    updateTrack(t.doc, b, { name: 'bb', muted: true })
    addNote(t.doc, { clipId: other, tick: 0, durTicks: 480, pitch: 60, velocity: 1 })
    addTrack(t.doc, 'c', 'audio')
    for (let i = 0; i < 5; i++) {
      t.setPeers([{ user: { username: 'bob', color: 'red' }, playhead: i }])
      t.setPos(i * 1000)
    }
    expect(clips(host).every((e, i) => e === els[i])).toBe(true)
    // a change to one of its own clips patches that element alone
    const id = [...clipsMap(t.doc).keys()].find((k) => clipsMap(t.doc).get(k)!.get('trackId') === a && clipsMap(t.doc).get(k)!.get('start') === 0)!
    updateClip(t.doc, id, { lengthTicks: 4 * 480 })
    expect(clips(host).every((e, i) => e === els[i])).toBe(true)
  })

  it('a clip moves when its start changes, the others stay', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a', 'midi')
    const c1 = addMidiClip(t.doc, { trackId: a, start: 0 })
    addMidiClip(t.doc, { trackId: a, start: 2 * RATE })
    const host = lane(t, a)
    const [e1, e2] = clips(host)
    expect([px(e1), px(e2)]).toEqual([0, 200])
    updateClip(t.doc, c1, { start: RATE })
    expect([px(e1), px(e2)]).toEqual([100, 200])
    // the zoom moves them all (and their widths)
    const w = parseFloat(e1.style.width)
    t.setScale({ pps: 50, rate: RATE })
    expect([px(e1), px(e2)]).toEqual([50, 100])
    expect(parseFloat(e1.style.width)).toBe(w / 2)
  })

  it('a delete removes only that clip', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a', 'midi')
    const ids = [0, 1, 2].map((i) => addMidiClip(t.doc, { trackId: a, start: i * RATE }))
    const host = lane(t, a)
    const els = clips(host)
    deleteClip(t.doc, ids[1])
    const now = clips(host)
    expect(now.length).toBe(2)
    expect(now[0]).toBe(els[0])
    expect(now[1]).toBe(els[2])
  })

  it('a clip dragged to another lane leaves the first and appears in the second', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a', 'midi'), b = addTrack(t.doc, 'b', 'midi')
    const c = addMidiClip(t.doc, { trackId: a, start: 0 })
    const ha = lane(t, a), hb = lane(t, b)
    expect([clips(ha).length, clips(hb).length]).toEqual([1, 0])
    updateClip(t.doc, c, { trackId: b, start: RATE })
    expect([clips(ha).length, clips(hb).length]).toEqual([0, 1])
    expect(px(clips(hb)[0])).toBe(100)
  })

  it('classes follow the selection, the editor, the locks and the remote selection outline', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a', 'midi')
    const c1 = addMidiClip(t.doc, { trackId: a, start: 0 }), c2 = addMidiClip(t.doc, { trackId: a, start: 2 * RATE })
    const host = lane(t, a)
    const [e1, e2] = clips(host)
    expect([e1.classList.contains('sel'), e2.classList.contains('sel')]).toEqual([false, false])
    t.sel.selectClips([c2])
    expect([e1.classList.contains('sel'), e2.classList.contains('sel')]).toEqual([false, true])
    expect(e1.classList.contains('midi')).toBe(true)
    expect(e1.classList.contains('loopable')).toBe(true)
    // editing: the editor widget moves into the clip, and leaves again
    t.sel.editing = c1
    expect(e1.classList.contains('editing')).toBe(true)
    expect(e1.contains(t.ne.el)).toBe(true)
    expect(t.ne.update).toHaveBeenCalled()
    t.sel.editing = c2
    expect(e1.classList.contains('editing')).toBe(false)
    expect(e1.contains(t.ne.el)).toBe(false)
    expect(e2.contains(t.ne.el)).toBe(true)
    t.sel.editing = null
    expect(e2.contains(t.ne.el)).toBe(false)
    // a peer selects a clip: it gets their colour as an outline; it goes when they let go
    expect(e1.style.outline).toBe('')
    t.setPeers([{ user: { username: 'bob', color: 'rgb(255, 0, 0)' }, selection: [c1] }])
    expect(e1.style.outline).toContain('rgb(255, 0, 0)')
    expect(e2.style.outline).toBe('')
    t.setPeers([{ user: { username: 'bob', color: 'rgb(255, 0, 0)' }, selection: [] }])
    expect(e1.style.outline).toBe('')
    // someone recording on the track: its clips can't be looped by hand
    t.setPeers([{ user: { username: 'bob', color: 'red' }, recording: { trackId: a, start: 0 } }])
    expect(e1.classList.contains('loopable')).toBe(false)
    expect(e1).toBe(clips(host)[0])
  })

  it('loopable is off when read-only', () => {
    const t = setup(true)
    const a = addTrack(t.doc, 'a', 'midi')
    addMidiClip(t.doc, { trackId: a, start: 0 })
    expect(clips(lane(t, a))[0].classList.contains('loopable')).toBe(false)
  })

  it('a MIDI clip previews its notes, rebuilt when they change', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a', 'midi')
    const c = addMidiClip(t.doc, { trackId: a, start: 0 })
    const host = lane(t, a)
    const e = clips(host)[0]
    expect(e.textContent).toBe('midi')
    expect(e.querySelectorAll('.mark').length).toBe(0)
    const n = addNote(t.doc, { clipId: c, tick: 0, durTicks: 480, pitch: 60, velocity: 1 })
    expect(e.querySelectorAll('.mark').length).toBe(1)
    const marks = e.querySelector('.mark')
    updateNote(t.doc, n, { velocity: 0.5 }) // (not a thing the preview shows)
    expect(e.querySelector('.mark')).toBe(marks)
    updateNote(t.doc, n, { tick: 480 })
    expect(parseFloat((e.querySelector('.mark') as HTMLElement).style.left)).toBeGreaterThan(0)
    notesMap(t.doc).delete(n)
    expect(e.querySelectorAll('.mark').length).toBe(0)
    // a drum grid clip says so
    const d = addMidiClip(t.doc, { trackId: a, start: RATE, view: 'drums', loopTicks: 480 })
    expect(clips(host).find((x) => x.textContent === 'drums')).toBeTruthy()
    expect(d).toBeTruthy()
  })

  it('a forever clip runs out to the end of the scroll area', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a', 'midi')
    addMidiClip(t.doc, { trackId: a, start: 0, lengthTicks: 4 * 480, loopTicks: 480, forever: true })
    const e = clips(lane(t, a))[0]
    expect(e.classList.contains('forever')).toBe(true)
    expect(parseFloat(e.style.width)).toBe(60 * 100)
    t.setTotal(120 * RATE)
    expect(parseFloat(e.style.width)).toBe(120 * 100)
  })

  it('audio clips are labelled, and unplayable, incoming and missing samples say so', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a', 'audio')
    const samples = t.doc.getMap<Y.Map<unknown>>('samples')
    const meta = (hash: string, extra: Record<string, unknown>) => {
      const m = new Y.Map<unknown>()
      t.doc.transact(() => { for (const [k, v] of Object.entries({ hash, name: hash, size: 10, duration: 1, ...extra })) m.set(k, v); samples.set(hash, m) })
    }
    meta('ok', {}); meta('big', { size: 2 ** 40 }); meta('inc', { status: 'incoming', byName: 'bob' }); meta('gone', { status: 'missing' })
    for (const [i, hash] of ['ok', 'big', 'inc', 'gone', 'unknown'].entries()) addAudioClip(t.doc, { trackId: a, sourceHash: hash, start: i * RATE, length: RATE })
    const [ok, big, inc, gone, unknown] = clips(lane(t, a, 'audio'))
    const label = (e: HTMLElement) => e.querySelector('.label')!.textContent
    expect(label(ok)).toBe('ok')
    expect(ok.classList.contains('unplayable')).toBe(false)
    expect(label(big)).toContain('too long to play yet')
    expect(big.classList.contains('unplayable')).toBe(true)
    expect(inc.classList.contains('incoming')).toBe(true)
    expect(label(inc)).toContain('inc')
    expect(gone.classList.contains('missing')).toBe(true)
    expect(label(gone)).toContain('audio deleted')
    expect(label(unknown)).toBe('…')
    // the sample arriving later patches the label in place
    meta('unknown', { name: 'late' })
    expect(label(unknown)).toBe('late')
  })
})

describe('regions, loop boxes and takes', () => {
  it('soundscape regions follow the doc and the selection', () => {
    const t = setup()
    const s = addTrack(t.doc, 's', 'soundscape')
    const p = addPad(t.doc, s, RATE, 2 * RATE)
    addPad(t.doc, s, 5 * RATE, RATE)
    const host = lane(t, s, 'soundscape')
    const pads = [...host.querySelectorAll<HTMLElement>('.clip.region')]
    expect(pads.length).toBe(2)
    expect(pads[0].textContent).toBe('loopers on')
    expect([px(pads[0]), parseFloat(pads[0].style.width)]).toEqual([100, 200])
    t.sel.selectPad(p)
    expect(pads[0].classList.contains('sel')).toBe(true)
    padsMap(t.doc).get(p)!.set('start', 3 * RATE)
    expect(px(pads[0])).toBe(300)
    expect([...host.querySelectorAll('.clip.region')][0]).toBe(pads[0])
    padsMap(t.doc).delete(p)
    expect(host.querySelectorAll('.clip.region').length).toBe(1)
    expect(host.querySelector('.clip.region')).toBe(pads[1])
    expect(host.querySelector('.clip:not(.region):not(.recording)')).toBeNull() // (a soundscape's clips are in its source lane)
  })

  it('source clips and loop boxes are drawn in the source lane\'s own scale', () => {
    const t = setup()
    const s = addTrack(t.doc, 's', 'soundscape')
    addAudioClip(t.doc, { trackId: s, sourceHash: 'h', start: RATE, length: 2 * RATE })
    const lp = addLooper(t.doc, s, 0)
    const [pps, setPps] = createSignal(80)
    const [heads, setHeads] = createSignal(new Map<string, number>(), { equals: false })
    const src: SrcView = { pps, scrollX: () => 0, view: document.body, heads }
    const host = document.createElement('div')
    document.body.append(host)
    const off = mountSourceBody(host, t.ctx, s, src)
    cleanup.push(() => (off(), host.remove()))
    const clip = host.querySelector<HTMLElement>('.clip')!
    expect([px(clip), parseFloat(clip.style.width)]).toEqual([80, 160])
    expect(host.querySelector('.loop-box')).toBeNull() // (no region yet)
    updateLooper(t.doc, lp, { start: RATE, length: RATE })
    const box = host.querySelector<HTMLElement>('.loop-box')!
    expect([px(box), parseFloat(box.style.width)]).toEqual([80, 80])
    expect(box.querySelector('span')!.textContent).toBe('1')
    t.sel.armedLooper = lp
    expect(box.classList.contains('armed')).toBe(true)
    setPps(160)
    expect([px(clip), px(box)]).toEqual([160, 160])
    // the loopers' heads come and go with what the engine reports
    expect(host.querySelectorAll('.loop-head').length).toBe(0)
    setHeads(new Map([[lp, RATE]]))
    const head = host.querySelector<HTMLElement>('.loop-head')!
    expect(px(head)).toBe(160)
    setHeads(new Map([[lp, 2 * RATE]]))
    expect(host.querySelector('.loop-head')).toBe(head)
    expect(px(head)).toBe(320)
    setHeads(new Map())
    expect(host.querySelectorAll('.loop-head').length).toBe(0)
    expect(host.querySelector('.clip')).toBe(clip)
  })

  it('a peer\'s take grows as their playhead moves; ours follows the position', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a', 'audio')
    const host = lane(t, a, 'audio')
    expect(host.querySelector('.recording')).toBeNull()
    t.setPeers([{ user: { username: 'bob', color: 'red' }, recording: { trackId: a, start: RATE }, playhead: 2 * RATE }])
    const theirs = host.querySelector<HTMLElement>('.recording')!
    expect(theirs.textContent).toBe('bob is recording')
    expect([px(theirs), parseFloat(theirs.style.width)]).toEqual([100, 100])
    t.setPeers([{ user: { username: 'bob', color: 'red' }, recording: { trackId: a, start: RATE }, playhead: 4 * RATE }])
    expect(host.querySelector('.recording')).toBe(theirs)
    expect(parseFloat(theirs.style.width)).toBe(300)
    t.setTake({ trackId: a, start: 0 })
    t.setPos(RATE)
    const mine = [...host.querySelectorAll<HTMLElement>('.recording')].find((e) => e.textContent === 'recording')!
    expect(parseFloat(mine.style.width)).toBe(100)
    t.setPos(3 * RATE)
    expect(parseFloat(mine.style.width)).toBe(300)
    t.setPeers([])
    t.setTake(null)
    expect(host.querySelectorAll('.recording').length).toBe(0)
  })
})
