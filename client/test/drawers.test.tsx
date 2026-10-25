// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { createSignal } from 'solid-js'
import { MASTER_TRACK, REVERB, SIMPLE_FILTER, addBus, addDevice, addTrack, devicesMap, lanesMap, setParam, tracksMap, updateTrack, type AwarenessState } from '@mobdaw/shared'
import { automateParam } from '../src/project/actions'
import { createProjectStore } from '../src/project/store'
import { createAutoValues, createDrawers, createMixDrive, createTabAvailability } from '../src/project/viewState'
import { mountLaneDrawers, type DrawCtx } from '../src/ui/drawers'
import { transportControls } from '../src/ui/transport'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))

function setup() {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  let peers: AwarenessState[] = []
  const store = createProjectStore({ doc, awareness, remoteStates: () => peers })
  const drawers = createDrawers(), auto = createAutoValues()
  const [reordering, setReordering] = createSignal(false)
  const [scale] = createSignal({ pps: 100, rate: 48000 })
  const calls: string[] = []
  const ctx: DrawCtx = {
    doc, undo: new Y.UndoManager([tracksMap(doc)]), store, rec: {} as DrawCtx['rec'], drawers, avail: createTabAvailability(), drive: createMixDrive(),
    toggleTab: (id, tab) => void drawers.toggle(id, tab), autoMenu: () => {},
    auto, reordering, armed: () => null, width: () => 1000, scale,
    deps: {
      live: () => {}, drag: () => {}, commit: (d, p, v) => void calls.push(`commit ${d} ${p} ${v}`), commitMany: () => {}, bypass: () => {}, remove: () => {}, rename: () => {},
      reorderStart: () => setReordering(true), reorderDrop: () => {}, reorderEnd: () => setReordering(false),
    },
    loops: {} as DrawCtx['loops'],
    rows: { doc, grab() {}, x: (s) => s / 480, fromX: (px) => px * 480, rate: 48000 },
  }
  cleanup.push(() => store.dispose())
  return { doc, awareness, store, ctx, auto, calls, setReordering, setPeers: (p: AwarenessState[]) => ((peers = p), awareness.emit('change', [{ added: [], updated: [], removed: [] }, 'test'])) }
}
const lane = (t: ReturnType<typeof setup>, id: string, kind = 'audio') => {
  const host = document.createElement('div')
  document.body.append(host)
  const m = mountLaneDrawers(host, t.ctx, id, kind, transportControls({ title: 'x', onToggle() {}, small: true }))
  cleanup.push(() => (m.dispose(), host.remove()))
  return host
}
const knobOf = (host: Element, param: number) => host.querySelector(`[data-param="${param}"] .knob`)!
const val = (el: Element) => Number(el.getAttribute('aria-valuenow'))

describe('presets drawer', () => {
  it('buttons keep their identity across doc changes, awareness and automation ticks', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    const host = lane(t, id)
    expect(host.querySelector('.preset')).toBeNull() // shut
    t.ctx.drawers.open(id, 'presets')
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.preset')]
    expect(buttons.length).toBeGreaterThan(3)
    expect(host.querySelector('.preset-col h4')!.textContent).toBe('effects')
    // unrelated doc changes, a peer moving, the playhead's automation ticks
    updateTrack(t.doc, id, { name: 'b', muted: true })
    const other = addTrack(t.doc, 'x')
    addDevice(t.doc, id, REVERB)
    t.setPeers([{ user: { username: 'bob', color: 'red' }, playhead: 5 }])
    t.setPeers([{ user: { username: 'bob', color: 'red' }, playhead: 6 }])
    for (let i = 0; i < 5; i++) t.auto.publish(new Map([['nobody', new Map([['0', { on: true, value: i }]])]]))
    updateTrack(t.doc, other, { name: 'y' })
    expect([...host.querySelectorAll('.preset')].every((b, i) => b === buttons[i])).toBe(true)
    // applying one marks it (the same button) and rewrites the chain
    buttons[1].click()
    expect(buttons[1].classList.contains('on')).toBe(true)
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true')
    expect([...host.querySelectorAll('.preset')].every((b, i) => b === buttons[i])).toBe(true)
    // a peer recording on the track locks them
    t.setPeers([{ user: { username: 'bob', color: 'red' }, recording: { trackId: id, start: 0 } }])
    expect(buttons[0].disabled).toBe(true)
    expect(buttons[0]).toBe(host.querySelector('.preset'))
  })

  it('the tab is offered once the track has presets; none on a track kind without', () => {
    const t = setup()
    const audio = addTrack(t.doc, 'a'), scape = addTrack(t.doc, 's', 'soundscape')
    lane(t, audio)
    lane(t, scape, 'soundscape')
    expect(t.ctx.avail.has(audio, 'presets')).toBe(true)
    expect(t.ctx.avail.has(scape, 'presets')).toBe(false)
  })
})

describe('device cards', () => {
  const open = (t: ReturnType<typeof setup>, id: string) => {
    const host = lane(t, id)
    t.ctx.drawers.open(id, 'fx')
    return host
  }
  it('a knob follows a doc change, a remote drag and an automation value, in that order of strength', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    const dev = addDevice(t.doc, id, REVERB)
    const host = open(t, id)
    const card = host.querySelector('.dev')!
    const k = knobOf(card, 0)
    const def = val(k)
    setParam(t.doc, dev, 0, 0.9)
    expect(val(k)).toBeCloseTo(0.9)
    expect(host.querySelector('.dev')).toBe(card) // patched, not rebuilt
    t.setPeers([{ user: { username: 'bob', color: 'red' }, dragging: [{ deviceId: dev, paramId: 0, value: 0.4 }] }])
    expect(val(k)).toBeCloseTo(0.4)
    t.setPeers([{ user: { username: 'bob', color: 'red' } }])
    expect(val(k)).toBeCloseTo(0.9) // the drag ended
    const label = card.querySelector('[data-param="0"] .dim')!
    t.auto.publish(new Map([[dev, new Map([['0', { on: true, value: 0.2 }]])]]))
    expect(val(k)).toBeCloseTo(0.2)
    expect(k.classList.contains('disabled')).toBe(true)
    expect(label.classList.contains('driven')).toBe(true)
    t.auto.publish(new Map([[dev, new Map([['0', { on: true, value: 0.3 }]])]]))
    expect(val(k)).toBeCloseTo(0.3)
    t.auto.publish(new Map())
    expect(val(k)).toBeCloseTo(0.9)
    expect(k.classList.contains('disabled')).toBe(false)
    expect(label.classList.contains('driven')).toBe(false)
    expect(def).not.toBeCloseTo(0.9)
  })

  it('adding and removing a device adds and removes a card, the others stay', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    const a = addDevice(t.doc, id, REVERB)
    const host = open(t, id)
    const first = host.querySelector('.dev')!
    const b = addDevice(t.doc, id, SIMPLE_FILTER)
    expect([...host.querySelectorAll('.dev')].map((e) => e.getAttribute('data-device'))).toEqual([a, b])
    expect(host.querySelector('.dev')).toBe(first)
    devicesMap(t.doc).delete(a)
    expect([...host.querySelectorAll('.dev')].map((e) => e.getAttribute('data-device'))).toEqual([b])
  })

  it('adjacent filters share one curve, hosted by the first; a reorder drag splits them', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    const a = addDevice(t.doc, id, SIMPLE_FILTER), b = addDevice(t.doc, id, SIMPLE_FILTER)
    const host = open(t, id)
    const slots = () => [...host.querySelectorAll('.fslot')].map((s) => s.querySelectorAll('svg.fcurve').length)
    expect(host.querySelectorAll('.dev.filter').length).toBe(2)
    expect(slots()).toEqual([1, 0])
    expect(host.querySelectorAll('.node').length).toBe(2)
    t.setReordering(true)
    expect(slots()).toEqual([1, 1])
    t.setReordering(false)
    expect(slots()).toEqual([1, 0])
    // a change to the second moves its node on the shared curve without redrawing the first card's curve elsewhere
    const node = host.querySelectorAll('.node')[1].getAttribute('cx')
    setParam(t.doc, b, 1, 4000)
    expect(host.querySelectorAll('.node')[1].getAttribute('cx')).not.toBe(node)
    expect(a).not.toBe(b)
  })

  it('a filter is not redrawn when an unrelated device changes', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    addDevice(t.doc, id, SIMPLE_FILTER)
    const r = addDevice(t.doc, id, REVERB)
    const host = open(t, id)
    const node = host.querySelector('.node')!
    setParam(t.doc, r, 0, 0.7)
    t.auto.publish(new Map([[r, new Map([['0', { on: true, value: 0.5 }]])]]))
    expect(host.querySelector('.node')).toBe(node) // (the circle is replaced on every curve.draw)
  })

  it('the master bus has its own row', () => {
    const t = setup()
    addDevice(t.doc, MASTER_TRACK, REVERB)
    const host = document.createElement('div')
    cleanup.push(mountLaneDrawers(host, t.ctx, MASTER_TRACK, 'bus').dispose)
    t.ctx.drawers.open(MASTER_TRACK, 'fx')
    expect(host.querySelector('.fx-toggle')!.textContent).toBe('master fx (1)')
    expect(host.querySelector('.dev .knob')!.classList.contains('disabled')).toBe(false)
    expect(host.querySelector<HTMLButtonElement>('.add-fx')!.disabled).toBe(false)
  })

  it('a bus has effects, automation and presets like a track, and no instruments or loopers', () => {
    const t = setup()
    const id = addBus(t.doc, 'drums bus')
    addDevice(t.doc, id, REVERB)
    const host = lane(t, id, 'bus')
    expect([...host.querySelectorAll('.fx-toggle')].map((n) => n.textContent)).toEqual(['fx', 'automation (0)', 'presets'])
    t.ctx.drawers.open(id, 'fx')
    expect(host.querySelectorAll('.dev').length).toBe(1)
    expect(host.querySelector('.add-fx')!.getAttribute('title')).toBe('add effect')
    t.ctx.drawers.open(id, 'presets')
    expect(host.querySelector('.preset-col h4')!.textContent).toBe('effects')
    expect(t.ctx.avail.has(id, 'presets')).toBe(true)
  })
})

describe('automation rows', () => {
  const rows = (host: Element) => [...host.querySelectorAll('.auto-row .auto-title .name')].map((n) => n.textContent)
  it('add, remove and reorder, with the count in the toggle', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    const dev = addDevice(t.doc, id, REVERB)
    const host = lane(t, id)
    const section = host.querySelector<HTMLElement>('.auto-section[data-title="automation"]')!
    const toggle = () => section.querySelector('.fx-toggle')!.textContent
    const target = (owner: string, param: number) => ({ scope: id, kind: 'effect' as const, owner, param: String(param) })
    const rowEls = () => [...host.querySelectorAll('.auto-row')]
    expect(section.hidden).toBe(true)
    expect(t.ctx.avail.has(id, 'auto')).toBe(false)
    automateParam(t.doc, target(dev, 1))
    expect(t.ctx.avail.has(id, 'auto')).toBe(true)
    expect(section.hidden).toBe(true) // shut until opened
    expect(toggle()).toBe('automation (1)')
    t.ctx.drawers.open(id, 'auto')
    expect(section.hidden).toBe(false)
    expect(rows(host)).toEqual(['reverb · size'])
    const [second] = rowEls()
    // lanes follow their order in the doc; the row that was there is kept
    automateParam(t.doc, target(dev, 0))
    expect(rows(host)).toEqual(['reverb · size', 'reverb · mix'])
    expect(rowEls()[0]).toBe(second)
    expect(toggle()).toBe('automation (2)')
    // the fader's lane leads the section, and has no owner prefix
    automateParam(t.doc, target(t.store.mixDevice(id)!.id, 0))
    expect(rows(host)).toEqual(['volume', 'reverb · size', 'reverb · mix'])
    expect(rowEls()[1]).toBe(second)
    // remove: the row goes, the others stay
    const gone = Object.values(t.store.laneById).find((l) => l.owner === dev && l.param === '0')!
    lanesMap(t.doc).delete(gone.id)
    expect(rows(host)).toEqual(['volume', 'reverb · size'])
    expect(rowEls()[1]).toBe(second)
    expect(toggle()).toBe('automation (2)')
  })

  it('a lane whose device is gone disappears', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    const dev = addDevice(t.doc, id, REVERB)
    automateParam(t.doc, { scope: id, kind: 'effect', owner: dev, param: '1' })
    const host = lane(t, id)
    t.ctx.drawers.open(id, 'auto')
    expect(host.querySelectorAll('.auto-row').length).toBe(1)
    devicesMap(t.doc).delete(dev)
    expect(host.querySelectorAll('.auto-row').length).toBe(0)
    expect(t.ctx.avail.has(id, 'auto')).toBe(false)
  })
})
