// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { createSignal } from 'solid-js'
import { COMPRESSOR, EFFECTS, FX_RECV, FX_SEND, MASTER_TRACK, addBus, addDevice, addTrack, deleteDevice, deleteTrack, getDevices, tracksMap, updateDevice, updateTrack, type AwarenessState } from '@mobdaw/shared'
import { createProjectStore } from '../src/project/store'
import { createAutoValues, createDrawers, createMixDrive, createTabAvailability } from '../src/project/viewState'
import { mountLaneDrawers, type DrawCtx } from '../src/ui/drawers'
import { tapItems } from '../src/ui/tapPicker'
import { transportControls } from '../src/ui/transport'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach((f) => f()); document.body.innerHTML = '' })

function setup() {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  const store = createProjectStore({ doc, awareness, remoteStates: () => [] as AwarenessState[] })
  const drawers = createDrawers()
  const [reordering] = createSignal(false)
  const [scale] = createSignal({ pps: 100, rate: 48000 })
  const ctx: DrawCtx = {
    doc, undo: new Y.UndoManager([tracksMap(doc)]), store, rec: {} as DrawCtx['rec'], drawers, avail: createTabAvailability(), drive: createMixDrive(),
    toggleTab: (id, tab) => void drawers.toggle(id, tab), autoMenu: () => {},
    auto: createAutoValues(), reordering, armed: () => null, width: () => 1000, scale,
    deps: {
      live: () => {}, drag: () => {}, commit: () => {}, commitMany: () => {}, bypass: () => {}, remove: (d) => deleteDevice(doc, d), rename: () => {},
      setInput: (d, input) => updateDevice(doc, d, { input }), setName: (d, name) => updateDevice(doc, d, { name }),
      reorderStart: () => {}, reorderDrop: () => {}, reorderEnd: () => {},
    },
    loops: {} as DrawCtx['loops'],
    rows: { doc, grab() {}, x: (s) => s / 480, fromX: (px) => px * 480, rate: 48000 },
  }
  cleanup.push(() => store.dispose())
  return { doc, store, ctx }
}
const open = (t: ReturnType<typeof setup>, id: string) => {
  const host = document.createElement('div')
  document.body.append(host)
  const m = mountLaneDrawers(host, t.ctx, id, 'audio', transportControls({ title: 'x', onToggle() {}, small: true }))
  cleanup.push(() => (m.dispose(), host.remove()))
  t.ctx.drawers.open(id, 'fx')
  return host
}
const card = (host: Element, dev: string) => host.querySelector(`[data-device="${dev}"]`)!
const pick = (c: Element) => c.querySelector<HTMLButtonElement>('.tap-pick')!
const menu = () => [...document.querySelectorAll<HTMLButtonElement>('.popover button')]
const texts = () => menu().map((b) => b.querySelector('span')!.textContent)

describe('tap picker', () => {
  it('lists none, tracks and buses, sends by label, then the master; leaves out the chain\'s own implicit tap', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a'), b = addTrack(t.doc, 'b')
    addBus(t.doc, 'drums')
    addDevice(t.doc, b, FX_SEND, { name: 'verb' })
    addDevice(t.doc, b, FX_SEND)
    const rv = addDevice(t.doc, a, FX_RECV)
    const host = open(t, a)
    pick(card(host, rv)).click()
    // (the buses' heading follows the tracks': they share the track kind order in the list but get their own heading)
    expect(texts()).toEqual(['none', 'tracks', 'b', 'buses', 'drums', 'sends', 'verb', 'send 2', 'master'])
  })

  it('marks the chain\'s own sends and writes input on pick; none removes the field', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a'), b = addTrack(t.doc, 'b')
    addDevice(t.doc, a, FX_SEND, { name: 'mine' })
    const rv = addDevice(t.doc, a, FX_RECV)
    const host = open(t, a)
    pick(card(host, rv)).click()
    expect(menu().find((x) => x.textContent!.startsWith('mine'))!.textContent).toContain('this chain')
    menu().find((x) => x.textContent === 'b')!.click()
    expect(getDevices(t.doc).find((d) => d.id === rv)!.input).toBe(b)
    expect(pick(card(host, rv)).textContent).toContain('b')
    pick(card(host, rv)).click()
    menu().find((x) => x.textContent!.startsWith('none'))!.click()
    expect(getDevices(t.doc).find((d) => d.id === rv)!.input).toBeUndefined()
    expect(pick(card(host, rv)).classList.contains('none')).toBe(true)
  })

  it('follows renames and shows a missing state when the tap is deleted', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a'), b = addTrack(t.doc, 'b')
    const snd = addDevice(t.doc, b, FX_SEND, { name: 'verb' })
    const rv = addDevice(t.doc, a, FX_RECV, { input: snd })
    const host = open(t, a)
    const btn = pick(card(host, rv))
    expect(btn.textContent).toContain('verb')
    updateDevice(t.doc, snd, { name: 'plate' })
    expect(pick(card(host, rv))).toBe(btn) // patched, not rebuilt
    expect(btn.textContent).toContain('plate')
    updateDevice(t.doc, rv, { input: b })
    expect(btn.textContent).toContain('b')
    updateTrack(t.doc, b, { name: 'bass' })
    expect(btn.textContent).toContain('bass')
    deleteTrack(t.doc, b)
    expect(btn.classList.contains('missing')).toBe(true)
    expect(btn.textContent).toContain('missing')
    updateDevice(t.doc, rv, { input: undefined })
    expect(btn.classList.contains('missing')).toBe(false)
  })

  it('tapItems keeps the chain\'s own tap only while it is the current one', () => {
    const taps = [{ id: 'a', label: 'a', kind: 'track' as const, owner: 'a' }, { id: MASTER_TRACK, label: 'master', kind: 'master' as const, owner: MASTER_TRACK }]
    const labels = (cur?: string) => tapItems(taps, 'a', cur, 'none', () => {}).flatMap((i) => (typeof i === 'string' || Array.isArray(i) ? [] : [i.label]))
    expect(labels()).toEqual(['none', 'master'])
    expect(labels('a')).toEqual(['none', 'tracks', 'a', 'master'])
  })
})

describe('tap cards', () => {
  it('fx send: label input writes the name, placeholder is the default label, shows its readers', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a')
    const s1 = addDevice(t.doc, a, FX_SEND)
    const s2 = addDevice(t.doc, a, FX_SEND)
    const host = open(t, a)
    const c = card(host, s2)
    const input = c.querySelector<HTMLInputElement>('.tap-label')!
    expect(input.placeholder).toBe('send 2')
    expect(input.value).toBe('')
    expect(c.querySelector('.tap-readers')!.textContent).toBe('unread')
    input.value = ' echo '
    input.dispatchEvent(new Event('change'))
    expect(getDevices(t.doc).find((d) => d.id === s2)!.name).toBe('echo')
    const rv = addDevice(t.doc, a, FX_RECV, { input: s2 })
    addDevice(t.doc, a, COMPRESSOR, { input: s2 })
    expect(c.querySelector('.tap-readers')!.textContent).toBe('read by 2')
    expect(card(host, s1).querySelector('.tap-readers')!.textContent).toBe('unread')
    expect(pick(card(host, rv)).textContent).toContain('echo')
    expect(c.querySelector('[data-param="0"] .knob')).not.toBeNull() // gain
  })

  it('compressor: the key picker says self when absent and writes input', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a'), b = addTrack(t.doc, 'b')
    const comp = addDevice(t.doc, a, COMPRESSOR)
    const host = open(t, a)
    const btn = pick(card(host, comp))
    expect(btn.textContent).toContain('self')
    btn.click()
    expect(texts()[0]).toBe('self')
    menu().find((x) => x.textContent === 'b')!.click()
    expect(getDevices(t.doc).find((d) => d.id === comp)!.input).toBe(b)
  })

  it('fx recv: a gain knob and the picker; send and recv are in the fx menu with friendly names', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a')
    const rv = addDevice(t.doc, a, FX_RECV)
    const host = open(t, a)
    expect(card(host, rv).querySelector('[data-param="0"] .knob')).not.toBeNull()
    expect(pick(card(host, rv)).textContent).toContain('none')
    const names = Object.fromEntries(EFFECTS.map((e) => [e.type, e.name]))
    expect(names[FX_SEND]).toBe('fx send')
    expect(names[FX_RECV]).toBe('fx recv')
  })
})
