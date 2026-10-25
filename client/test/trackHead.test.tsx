// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { createSignal } from 'solid-js'
import { MASTER_TRACK, addBus, addDevice, addTrack, getTracks, setParam, setParent, tracksMap, updateTrack, type AwarenessState } from '@mobdaw/shared'
import { createProjectStore } from '../src/project/store'
import { createCollapsed, createDrawers, createMixDrive, createTabAvailability } from '../src/project/viewState'
import { mountTrackHead, type HeadCtx } from '../src/ui/trackHead'
import { mountRemoteHeads } from '../src/ui/remoteHeads'
import { mountBar } from '../src/ui/bar'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))

function setup() {
  const doc = new Y.Doc()
  const awareness = new Awareness(doc)
  let peers: AwarenessState[] = []
  const store = createProjectStore({ doc, awareness, remoteStates: () => peers })
  const [armed, setArmed] = createSignal<string | null>(null)
  const armedCalls: string[] = []
  const rec = {
    get armedTrack() { return armed() }, get monitoring() { return false }, currentTrack: null,
    arm: async (id: string) => void armedCalls.push(id), toggleMonitoring() {},
  } as unknown as HeadCtx['rec']
  const drawers = createDrawers(), avail = createTabAvailability(), drive = createMixDrive(), collapsed = createCollapsed()
  const ctx: HeadCtx = {
    doc, undo: new Y.UndoManager([tracksMap(doc)]), store, rec, drawers, avail, drive, collapsed,
    toggleTab: (id, tab) => void drawers.toggle(id, tab), autoMenu: () => {},
  }
  cleanup.push(() => store.dispose())
  return { doc, awareness, store, ctx, collapsed, setArmed, armedCalls, setPeers: (p: AwarenessState[]) => ((peers = p), awareness.emit('change', [{ added: [], updated: [], removed: [] }, 'test'])) }
}
const head = (t: ReturnType<typeof setup>, id: string) => {
  const host = document.createElement('div')
  document.body.append(host)
  const m = mountTrackHead(host, t.ctx, id)
  cleanup.push(() => (m.dispose(), host.remove()))
  return { host, ...m }
}

describe('track header', () => {
  it('shows the track and follows the doc without being rebuilt', () => {
    const t = setup()
    const id = addTrack(t.doc, 'drums')
    const { host } = head(t, id)
    const name = host.querySelector('.name')!, mute = host.querySelector<HTMLButtonElement>('.mute')!
    expect(name.textContent).toBe('drums')
    expect(host.querySelector('.kind')!.getAttribute('title')).toBe('audio track')
    updateTrack(t.doc, id, { name: 'beats', muted: true })
    expect(host.querySelector('.name')).toBe(name) // patched, not rebuilt
    expect(name.textContent).toBe('beats')
    expect(mute.classList.contains('on')).toBe(true)
    // an unrelated track's change leaves this header alone
    const other = addTrack(t.doc, 'x')
    updateTrack(t.doc, other, { name: 'y' })
    expect(host.querySelector('.mute')).toBe(mute)
  })

  it('M and S write the doc; R arms; the meter and I follow the armed track', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    const { host } = head(t, id)
    host.querySelector<HTMLButtonElement>('.mute')!.click()
    host.querySelector<HTMLButtonElement>('.solo')!.click()
    expect(tracksMap(t.doc).get(id)!.get('muted')).toBe(true)
    expect(tracksMap(t.doc).get(id)!.get('soloed')).toBe(true)
    const meter = host.querySelector<HTMLElement>('.meter')!, listen = host.querySelector<HTMLElement>('.listen')!
    expect(meter.hidden && listen.hidden).toBe(true)
    host.querySelector<HTMLButtonElement>('.record')!.click()
    expect(t.armedCalls).toEqual([id])
    t.setArmed(id)
    expect(meter.hidden || listen.hidden).toBe(false)
    expect(host.querySelector('.record')!.classList.contains('on')).toBe(true)
    t.setArmed(null)
    expect(meter.hidden).toBe(true)
  })

  it('midi tracks have no record button and their own tabs; tabs follow the drawers and availability', () => {
    const t = setup()
    const id = addTrack(t.doc, 'm', 'midi')
    const { host } = head(t, id)
    expect(host.querySelector('.record')).toBeNull()
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('.tab')]
    expect(tabs.map((b) => b.textContent)).toEqual(['synth', 'fx', 'auto', 'presets'])
    expect(tabs[2].hidden && tabs[3].hidden).toBe(true)
    t.ctx.avail.set(id, 'auto', true)
    expect(tabs[2].hidden).toBe(false)
    tabs[1].click()
    expect(tabs[1].classList.contains('on') && tabs[1].getAttribute('aria-pressed') === 'true').toBe(true)
    t.ctx.drawers.closeAll(id)
    expect(tabs[1].classList.contains('on')).toBe(false)
  })

  it('the fader follows the mix device, and a driving lane overrides it and locks it', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    const { host } = head(t, id)
    const gain = host.querySelector<HTMLInputElement>('.gain')!
    expect(Number(gain.value)).toBeCloseTo(0.8) // unity
    setParam(t.doc, t.store.mixDevice(id)!.id, 0, 0)
    expect(Number(gain.value)).toBe(0)
    t.ctx.drive.set(id, { gain: 1, pan: -1 })
    expect(Number(gain.value)).toBeCloseTo(0.8)
    expect(gain.disabled).toBe(true)
    t.ctx.drive.set(id, { gain: null, pan: null })
    expect(gain.disabled).toBe(false)
  })

  it('rename: double-click, type, Enter writes the doc (one name, no menu rebuild)', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    const { host } = head(t, id)
    host.querySelector('.name')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    const input = host.querySelector<HTMLInputElement>('input.rename')!
    expect(input.value).toBe('a')
    input.value = '  lead '
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(host.querySelector('input.rename')).toBeNull()
    expect(tracksMap(t.doc).get(id)!.get('name')).toBe('lead')
    expect(host.querySelector('.name')!.textContent).toBe('lead')
  })

  it('header menu is offered off the controls, not on them, and not while a peer records there', () => {
    const t = setup()
    const id = addTrack(t.doc, 'a')
    const { host } = head(t, id)
    host.querySelector('.head-top')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    expect(document.querySelector('.menu, .popover')).not.toBeNull()
    document.querySelectorAll('.menu, .popover').forEach((e) => e.remove())
    t.setPeers([{ user: { username: 'bob', color: 'red' }, recording: { trackId: id, start: 0 } }])
    host.querySelector('.head-top')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    expect(document.querySelector('.menu, .popover')).toBeNull()
  })
})

describe('master header', () => {
  it('is the bus header: a name, a mix row and fx / auto tabs, with no mute, solo or menu', () => {
    const t = setup()
    addDevice(t.doc, MASTER_TRACK, 1)
    const host = document.createElement('div')
    document.body.append(host)
    const m = mountTrackHead(host, t.ctx, MASTER_TRACK)
    cleanup.push(() => (m.dispose(), host.remove()))
    expect(host.querySelector('.name')!.textContent).toBe('master')
    expect([...host.querySelectorAll<HTMLElement>('.tab')].map((b) => b.textContent)).toEqual(['fx', 'auto', 'presets']) // (auto and presets show once there is something to open)
    expect([...host.querySelectorAll<HTMLElement>('.tab')].filter((b) => !b.hidden).map((b) => b.textContent)).toEqual(['fx'])
    expect(m.refs.gain).toBe(host.querySelector('.gain'))
    expect(host.querySelector('.mute, .solo, .record, .fold')).toBeNull()
    host.querySelector('.name')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    expect(document.querySelector('.popover')).toBeNull()
  })
})

describe('bus header', () => {
  const items = () => [...document.querySelectorAll<HTMLButtonElement>('.popover button')]
  const pick = (label: string) => items().find((b) => b.textContent!.includes(label))!.click()
  const menu = (host: HTMLElement) => host.querySelector('.head-top')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
  afterEach(() => document.querySelectorAll('.popover').forEach((e) => e.remove()))

  it('has a fold button, mute and solo, and fx / auto / presets tabs, but no record button or input meter', () => {
    const t = setup()
    const id = addBus(t.doc, 'drums bus')
    const { host } = head(t, id)
    expect(host.querySelector('.name')!.textContent).toBe('drums bus')
    expect(host.querySelector('.kind')).toBeNull()
    expect(host.querySelector('.record, .listen, .meter')).toBeNull()
    expect([...host.querySelectorAll<HTMLElement>('.tab')].map((b) => b.textContent)).toEqual(['fx', 'auto', 'presets'])
    host.querySelector<HTMLButtonElement>('.mute')!.click()
    host.querySelector<HTMLButtonElement>('.solo')!.click()
    expect(tracksMap(t.doc).get(id)!.get('muted')).toBe(true)
    expect(tracksMap(t.doc).get(id)!.get('soloed')).toBe(true)
  })

  it('the fold button folds and opens the bus (local view state, not in the doc)', () => {
    const t = setup()
    const id = addBus(t.doc, 'b')
    const { host } = head(t, id)
    const fold = host.querySelector<HTMLButtonElement>('.fold')!
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    fold.click()
    expect(t.collapsed.isCollapsed(id)).toBe(true)
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    fold.click()
    expect(t.collapsed.isCollapsed(id)).toBe(false)
    expect(tracksMap(t.doc).get(id)!.has('collapsed')).toBe(false)
  })

  it('a track\'s menu moves it into a bus and out again, and makes a bus from it', () => {
    const t = setup()
    const a = addTrack(t.doc, 'a'), b = addTrack(t.doc, 'b')
    const bus = addBus(t.doc, 'room')
    const { host } = head(t, a)
    menu(host)
    expect(items().map((i) => i.textContent)).toEqual(['rename', 'move to bus \u25b8', 'new bus from this track', 'delete track'])
    pick('move to bus')
    expect(items().map((i) => i.textContent)).toEqual(['\u2713 master (no bus)', 'room'])
    expect(items()[0].disabled).toBe(true)
    pick('room')
    expect(tracksMap(t.doc).get(a)!.get('parent')).toBe(bus)
    menu(host)
    pick('move to bus')
    expect(items().map((i) => i.textContent)).toEqual(['master (no bus)', '\u2713 room'])
    pick('master')
    expect(tracksMap(t.doc).get(a)!.has('parent')).toBe(false)
    // a bus from b: at b's place, with b in it
    const other = head(t, b)
    menu(other.host)
    pick('new bus from this track')
    const made = getTracks(t.doc).find((x) => x.kind === 'bus' && x.id !== bus)!
    expect(made.name).toBe('b bus')
    expect(tracksMap(t.doc).get(b)!.get('parent')).toBe(made.id)
    expect(made.order).toBeLessThan(getTracks(t.doc).find((x) => x.id === bus)!.order)
  })

  it('a bus\'s menu lists the buses it could move into without itself or the ones inside it', () => {
    const t = setup()
    const outer = addBus(t.doc, 'outer'), inner = addBus(t.doc, 'inner'), other = addBus(t.doc, 'other')
    setParent(t.doc, inner, outer)
    const { host } = head(t, outer)
    menu(host)
    expect(items().map((i) => i.textContent)).toContain('delete bus')
    pick('move to bus')
    expect(items().map((i) => i.textContent)).toEqual(['\u2713 master (no bus)', 'other'])
    void inner; void other
  })
})

describe('remote playheads and the bar', () => {
  it('playheads are patched in place and removed when the peer stops', () => {
    const t = setup()
    const host = document.createElement('div')
    const [scale] = createSignal({ pps: 100, rate: 1000 })
    cleanup.push(mountRemoteHeads(host, { store: t.store, offset: 10, scale }))
    const bob = { user: { username: 'bob', color: 'red' }, playhead: 2000 } as AwarenessState
    t.setPeers([bob])
    const line = host.querySelector<HTMLElement>('.remote-head')!
    expect(line.style.left).toBe('210px')
    t.setPeers([{ ...bob, playhead: 3000 }])
    expect(host.querySelector('.remote-head')).toBe(line)
    expect(line.style.left).toBe('310px')
    t.setPeers([{ ...bob, playhead: null }])
    expect(host.querySelector('.remote-head')).toBeNull()
  })

  it('presence dots keep their elements as people come and go', () => {
    const t = setup()
    const host = document.createElement('header')
    const transport = document.createElement('div')
    const [status] = createSignal({ text: '', bad: false })
    cleanup.push(mountBar(host, {
      store: t.store, live: true, snapshot: false, user: { username: 'me', color: 'blue' }, transport, status, cpu: () => null, loopText: () => null,
      unread: () => 2, chatOpen: () => false, onStatus() {}, onClickTrack() {}, onZoom() {}, onExport() {}, onChat() {},
    }))
    const me = host.querySelector('.dot')!
    expect(me.textContent).toBe('M')
    t.setPeers([{ user: { username: 'ann.lee', color: 'red' } }])
    expect([...host.querySelectorAll('.dot')].map((d) => d.textContent)).toEqual(['M', 'AL'])
    expect(host.querySelector('.dot')).toBe(me)
    expect(host.querySelector('.chat-btn')!.textContent).toBe('2')
    expect(host.querySelector('.pedal-st')!.hasAttribute('hidden')).toBe(true)
    expect(transport.querySelector('.metro')).not.toBeNull()
  })

  it('without collaborators there is no presence, no chat, and a snapshot says its changes stay on the page', () => {
    const t = setup()
    const bar = (snapshot: boolean) => {
      const host = document.createElement('header')
      const [status] = createSignal({ text: '', bad: false })
      const [edited, setEdited] = createSignal(false)
      cleanup.push(mountBar(host, {
        store: t.store, live: false, snapshot, user: { username: 'me', color: 'blue' }, transport: document.createElement('div'), status, cpu: () => null, loopText: () => null,
        unread: () => 0, chatOpen: () => false, onStatus() {}, onClickTrack() {}, onZoom() {}, onExport() {}, onChat() {},
        saveCopy: snapshot ? { shown: edited, onSave() {} } : undefined,
      }))
      return { host, setEdited }
    }
    const local = bar(false)
    expect(local.host.querySelector('.dot')).toBeNull()
    expect(local.host.querySelector('.chat-btn')).toBeNull()
    expect(local.host.textContent).not.toContain('stay on this page')
    const snap = bar(true)
    expect(snap.host.querySelector('.dot')).toBeNull()
    expect(snap.host.textContent).toContain('changes stay on this page')
    expect(snap.host.textContent).not.toContain('save a copy')
    snap.setEdited(true)
    expect(snap.host.textContent).toContain('save a copy')
  })
})
