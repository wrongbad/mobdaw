// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { createSignal } from 'solid-js'
import { MASTER_TRACK, addDevice, addTrack, setParam, tracksMap, updateTrack, type AwarenessState } from '@mobdaw/shared'
import { createProjectStore } from '../src/project/store'
import { createDrawers, createMixDrive, createTabAvailability } from '../src/project/viewState'
import { mountMasterHead, mountTrackHead, type HeadCtx } from '../src/ui/trackHead'
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
  const drawers = createDrawers(), avail = createTabAvailability(), drive = createMixDrive()
  const ctx: HeadCtx = {
    doc, undo: new Y.UndoManager([tracksMap(doc)]), store, rec, drawers, avail, drive,
    toggleTab: (id, tab) => void drawers.toggle(id, tab), autoMenu: () => {},
  }
  cleanup.push(() => store.dispose())
  return { doc, awareness, store, ctx, setArmed, armedCalls, setPeers: (p: AwarenessState[]) => ((peers = p), awareness.emit('change', [{ added: [], updated: [], removed: [] }, 'test'])) }
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
  it('has a name, a mix row and fx / auto tabs', () => {
    const t = setup()
    addDevice(t.doc, MASTER_TRACK, 1)
    const host = document.createElement('div')
    const refs: { gain?: HTMLInputElement } = {}
    cleanup.push(mountMasterHead(host, t.ctx, (r) => (refs.gain = r.gain)))
    expect(host.querySelector('.name')!.textContent).toBe('master')
    expect([...host.querySelectorAll('.tab')].map((b) => b.textContent)).toEqual(['fx', 'auto'])
    expect(refs.gain).toBe(host.querySelector('.gain'))
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
    expect(host.querySelector('.chat-btn')!.textContent).toBe('chat (2)')
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
