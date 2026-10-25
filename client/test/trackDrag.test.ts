// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { MASTER_TRACK } from '@mobdaw/shared'
import { anchorAt, dragTrack, type DropItem, type TrackDragDeps } from '../src/ui/trackDrag'
import type { Anchor } from '../src/project/buses'

// a(0-72); bus(80-236): its tracks start at 86, x(86-158), its own row at 164; c(242-320), an empty bus (row at 248); d(326-398), folded
const items: DropItem[] = [
  { id: 'a', top: 0, bottom: 72, bus: false },
  { id: 'bus', top: 80, bottom: 236, bus: true, head: 86, foot: 164 },
  { id: 'x', top: 86, bottom: 158, bus: false },
  { id: 'c', top: 242, bottom: 320, bus: true, head: 248, foot: 248 },
  { id: 'd', top: 326, bottom: 398, bus: true, head: 326, foot: 326 },
]

describe('what the pointer means among the lanes', () => {
  it('the top edge of any lane is in front of it; a track splits at its middle', () => {
    expect(anchorAt(items, 5)).toEqual({ id: 'a', at: 'before' })
    expect(anchorAt(items, 30)).toEqual({ id: 'a', at: 'before' })
    expect(anchorAt(items, 50)).toEqual({ id: 'a', at: 'after' })
    expect(anchorAt(items, 90)).toEqual({ id: 'x', at: 'before' })
    expect(anchorAt(items, 130)).toEqual({ id: 'x', at: 'after' })
  })

  it('a bus is a box: its top frame is in front of it, below its last track and the top of its own row are into it, the rest of the row behind it', () => {
    expect(anchorAt(items, 83)).toEqual({ id: 'bus', at: 'before' })
    expect(anchorAt(items, 160)).toEqual({ id: 'bus', at: 'end' })
    expect(anchorAt(items, 180)).toEqual({ id: 'bus', at: 'end' })
    expect(anchorAt(items, 225)).toEqual({ id: 'bus', at: 'after' })
    expect(anchorAt(items, 255)).toEqual({ id: 'c', at: 'before' })
    expect(anchorAt(items, 270)).toEqual({ id: 'c', at: 'end' })
    expect(anchorAt(items, 310)).toEqual({ id: 'c', at: 'after' })
    expect(anchorAt(items, 330)).toEqual({ id: 'd', at: 'before' })
    expect(anchorAt(items, 360)).toEqual({ id: 'd', at: 'end' })
    expect(anchorAt(items, 395)).toEqual({ id: 'd', at: 'after' })
  })

  it('nested buses: the space under the inner bus\'s last track is into the inner one, under the inner bus\'s row into the outer one', () => {
    const nested: DropItem[] = [
      { id: 'o', top: 0, bottom: 240, bus: true, head: 6, foot: 168 },
      { id: 'i', top: 6, bottom: 162, bus: true, head: 12, foot: 90 },
      { id: 't', top: 12, bottom: 84, bus: false },
    ]
    expect(anchorAt(nested, 3)).toEqual({ id: 'o', at: 'before' })
    expect(anchorAt(nested, 9)).toEqual({ id: 'i', at: 'before' })
    expect(anchorAt(nested, 87)).toEqual({ id: 'i', at: 'end' })
    expect(anchorAt(nested, 165)).toEqual({ id: 'o', at: 'end' })
    expect(anchorAt(nested, 230)).toEqual({ id: 'o', at: 'after' })
  })

  it('the gap between lanes belongs to the next lane (in front of it); below everything is the end of the master', () => {
    expect(anchorAt(items, 76)).toEqual({ id: 'bus', at: 'before' })
    expect(anchorAt(items, 240)).toEqual({ id: 'c', at: 'before' })
    expect(anchorAt(items, 500)).toEqual({ id: MASTER_TRACK, at: 'end' })
    expect(anchorAt([], 10)).toBeNull()
  })
})

describe('dragging a header', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => cleanup.splice(0).forEach((f) => f()))
  // jsdom has no PointerEvent: a mouse event with the fields the code reads
  const ptr = (type: string, y: number, init: Record<string, unknown> = {}) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY: y, button: 0 })
    Object.assign(e, { pointerId: 1, pointerType: 'mouse', ...init })
    return e
  }
  function setup() {
    const handle = document.createElement('div')
    const lane = document.createElement('div')
    const line = document.createElement('div')
    document.body.append(handle, lane, line)
    handle.setPointerCapture = () => {}
    cleanup.push(() => (handle.remove(), lane.remove(), line.remove()))
    const calls: string[] = []
    let preview: ReturnType<TrackDragDeps['preview']> = { y: 50, depth: 1 }
    const deps: TrackDragDeps = {
      items: () => items,
      moving: () => [lane],
      preview: (id, a) => (calls.push(`preview ${id} ${a.id} ${a.at}`), preview),
      drop: (id, a: Anchor) => calls.push(`drop ${id} ${a.id} ${a.at}`),
      line,
      start: () => calls.push('start'),
      end: () => calls.push('end'),
    }
    dragTrack(handle, 't', deps)
    return { handle, lane, line, calls, noPlace: () => (preview = null) }
  }

  it('moves the lane with the pointer, shows the line, and drops where it points', () => {
    const t = setup()
    t.handle.dispatchEvent(ptr('pointerdown', 40))
    t.handle.dispatchEvent(ptr('pointermove', 42)) // (under the threshold: still a press)
    expect(t.calls).toEqual([])
    t.handle.dispatchEvent(ptr('pointermove', 120))
    expect(t.calls).toEqual(['start', 'preview t x before'])
    expect(t.lane.style.transform).toBe('translateY(80px)')
    expect(t.lane.classList.contains('reordering')).toBe(true)
    expect(t.line.hidden).toBe(false)
    expect(t.line.style.top).toBe('50px')
    expect(t.line.style.getPropertyValue('--depth')).toBe('1')
    t.handle.dispatchEvent(ptr('pointerup', 120))
    expect(t.calls.slice(-2)).toEqual(['drop t x before', 'end'])
    expect(t.lane.style.transform).toBe('')
    expect(t.lane.classList.contains('reordering')).toBe(false)
    expect(t.line.hidden).toBe(true)
  })

  it('swallows the click that ends a drag (it would open the header menu), but not a plain click', () => {
    const t = setup()
    let clicks = 0
    t.handle.addEventListener('click', () => clicks++)
    t.handle.dispatchEvent(ptr('pointerdown', 40))
    t.handle.dispatchEvent(ptr('pointerup', 40))
    t.handle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(clicks).toBe(1)
    t.handle.dispatchEvent(ptr('pointerdown', 40))
    t.handle.dispatchEvent(ptr('pointermove', 120))
    t.handle.dispatchEvent(ptr('pointerup', 120))
    t.handle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(clicks).toBe(1)
  })

  it('Escape cancels, a place that changes nothing hides the line, and buttons are not handles', () => {
    const t = setup()
    t.handle.dispatchEvent(ptr('pointerdown', 40))
    t.handle.dispatchEvent(ptr('pointermove', 120))
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(t.calls.some((c) => c.startsWith('drop'))).toBe(false)
    expect(t.calls.at(-1)).toBe('end')
    t.handle.dispatchEvent(ptr('pointerup', 120))
    expect(t.calls.some((c) => c.startsWith('drop'))).toBe(false)

    const u = setup()
    u.noPlace()
    u.handle.dispatchEvent(ptr('pointerdown', 40))
    u.handle.dispatchEvent(ptr('pointermove', 120))
    expect(u.line.hidden).toBe(true)

    const b = setup()
    const button = document.createElement('button')
    b.handle.append(button)
    button.dispatchEvent(ptr('pointerdown', 40))
    b.handle.dispatchEvent(ptr('pointermove', 120))
    expect(b.calls).toEqual([])
  })
})
