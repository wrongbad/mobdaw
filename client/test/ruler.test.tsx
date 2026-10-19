// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createSignal } from 'solid-js'
import { timeMap, type Marker, type Region } from '@mobdaw/shared'
import { drawnWindow, mountRuler } from '../src/ui/ruler'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))
const RATE = 48000

function setup(regions: Region[], markers: Marker[] = []) {
  const [map, setMap] = createSignal(timeMap(regions, RATE, 960))
  const [mk, setMk] = createSignal(markers)
  const [pps, setPps] = createSignal(80)
  const [key, setKey] = createSignal<string | undefined>(undefined)
  const menus: unknown[] = []
  const box = document.createElement('div')
  document.body.append(box)
  const off = mountRuler(box, { map, markers: mk, keyText: key, pps, scrollX: () => 0, viewW: () => 800, onMenu: (t) => menus.push(t) })
  cleanup.push(() => (off(), box.remove()))
  return { box, setMap, setMk, setPps, setKey, menus }
}
const m = (id: string, bar: number, bpm: number, num = 4, den = 4): Region => ({ id, bar, kind: 'metered', bpm, num, den })

describe('ruler', () => {
  it('draws bar numbers, a badge per region and the markers; a click on one asks for the menu', () => {
    const t = setup([m('a', 1, 120), m('b', 3, 90, 7, 8)], [{ id: 'k', bar: 2, label: 'A', text: 'verse' }])
    expect([...t.box.querySelectorAll('.rl.bar')].slice(0, 3).map((e) => e.textContent)).toEqual(['1', '2', '3'])
    expect([...t.box.querySelectorAll('.rl-badge')].map((e) => e.textContent?.trim())).toEqual(['♩=120 4/4', '♩=90 7/8'])
    const mk = t.box.querySelector<HTMLElement>('.rl-marker')!
    expect(mk.title).toBe('A: verse')
    mk.click()
    t.box.querySelectorAll<HTMLElement>('.rl-badge')[1].click()
    expect(t.menus).toEqual([{ bar: 2, markerId: 'k' }, { bar: 3, regionId: 'b' }])
  })
  it('follows the map, the markers and the key', () => {
    const t = setup([m('a', 1, 120)])
    expect(t.box.querySelectorAll('.rl-badge')).toHaveLength(1)
    t.setMap(timeMap([m('a', 1, 120), m('b', 4, 60)], RATE, 960))
    expect(t.box.querySelectorAll('.rl-badge')).toHaveLength(2)
    t.setMk([{ id: 'k', bar: 1, label: 'Intro' }])
    expect(t.box.querySelector('.rl-marker')!.textContent).toBe('Intro')
    t.setKey('D minor')
    expect(t.box.querySelector('.rl-badge')!.textContent).toContain('· D minor')
  })
  it('shows a ramp as a slope and a free region as seconds', () => {
    const t = setup([{ ...m('a', 1, 120), rampTo: 60 }, m('b', 3, 60), { id: 'f', bar: 6, kind: 'free', length: 3 * RATE }])
    expect(t.box.querySelectorAll('.rl-ramp')).toHaveLength(1)
    expect(t.box.querySelector('.rl-free')).not.toBeNull()
    expect([...t.box.querySelectorAll('.rl-badge')].at(-1)!.textContent).toContain('free 3s')
  })
  it('draws a window around the view that moves in steps', () => {
    expect(drawnWindow(0, 800)).toEqual([-800, 1600])
    expect(drawnWindow(100, 800)).toEqual(drawnWindow(150, 800))
    expect(drawnWindow(100, 800)[0]).toBeLessThan(100 - 800 + 1)
  })
})
