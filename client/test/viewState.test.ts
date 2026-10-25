import { describe, expect, it } from 'vitest'
import { createCollapsed, createDrawers, createSelection } from '../src/project/viewState'

describe('drawers', () => {
  it('toggles per track and tab', () => {
    const d = createDrawers()
    expect(d.isOpen('a', 'fx')).toBe(false)
    expect(d.toggle('a', 'fx')).toBe(true)
    expect(d.isOpen('a', 'fx')).toBe(true)
    expect(d.isOpen('b', 'fx')).toBe(false)
    expect(d.isOpen('a', 'auto')).toBe(false)
    expect(d.toggle('a', 'fx')).toBe(false)
    expect(d.isOpen('a', 'fx')).toBe(false)
  })
  it('open is idempotent and closeAll shuts every tab of one track', () => {
    const d = createDrawers()
    d.open('a', 'synth'); d.open('a', 'synth'); d.open('a', 'presets'); d.open('b', 'synth')
    expect(d.toggle('a', 'synth')).toBe(false)
    d.open('a', 'synth')
    d.closeAll('a')
    expect(d.isOpen('a', 'synth') || d.isOpen('a', 'presets')).toBe(false)
    expect(d.isOpen('b', 'synth')).toBe(true)
  })
})

describe('collapsed buses', () => {
  it('are open until folded, per bus, and only a change fires', () => {
    const c = createCollapsed()
    expect(c.isCollapsed('b')).toBe(false)
    expect(c.toggle('b')).toBe(true)
    expect(c.isCollapsed('b')).toBe(true)
    expect(c.isCollapsed('other')).toBe(false)
    c.set('b', false)
    expect(c.isCollapsed('b')).toBe(false)
    c.set('b', false)
    expect(c.toggle('b')).toBe(true)
  })
})

describe('selection', () => {
  const full = () => {
    const s = createSelection()
    s.clips = ['c']; s.editing = 'e'; s.note = 'n'; s.pad = 'p'; s.armedLooper = 'l'
    return s
  }
  it('an empty lane click keeps only the armed looper', () => {
    const s = full()
    s.clickEmptyLane()
    expect(s).toMatchObject({ clips: [], editing: null, note: null, pad: null, armedLooper: 'l' })
  })
  it('an empty source click clears only the pad (and clips)', () => {
    const s = full()
    s.clickEmptySource()
    expect(s).toMatchObject({ clips: [], editing: 'e', note: 'n', pad: null, armedLooper: 'l' })
  })
  it('selecting a pad leaves the editor and the note', () => {
    const s = full()
    s.selectPad('q')
    expect(s).toMatchObject({ clips: [], editing: null, note: null, pad: 'q', armedLooper: 'l' })
  })
  it('pressing a clip drops the note and the pad, keeps the editor', () => {
    const s = full()
    s.pressClip()
    expect(s).toMatchObject({ editing: 'e', note: null, pad: null })
  })
  it('toggleEditing opens, switches and closes', () => {
    const s = createSelection()
    s.toggleEditing('a'); expect(s.editing).toBe('a')
    s.toggleEditing('b'); expect(s.editing).toBe('b')
    s.toggleEditing('b'); expect(s.editing).toBe(null)
  })
  it('toggleArm and forgetLooper', () => {
    const s = createSelection()
    s.toggleArm('l'); expect(s.armedLooper).toBe('l')
    s.forgetLooper('x'); expect(s.armedLooper).toBe('l')
    s.toggleArm('l'); expect(s.armedLooper).toBe(null)
    s.toggleArm('l'); s.forgetLooper('l'); expect(s.armedLooper).toBe(null)
  })
  it('escape clears the lot, but only reports when there was something', () => {
    const s = full()
    expect(s.escape()).toBe(true)
    expect(s).toMatchObject({ clips: ['c'], editing: null, note: null, pad: null, armedLooper: null })
    expect(s.escape()).toBe(false)
    const t = createSelection()
    t.note = 'n' // a lone note does not count
    expect(t.escape()).toBe(false)
    expect(t.note).toBe('n')
  })
  it('takeDelete takes the note first, then the pad, else nothing', () => {
    const s = full()
    expect(s.takeDelete()).toEqual({ note: 'n' })
    expect(s.pad).toBe('p')
    expect(s.takeDelete()).toEqual({ pad: 'p' })
    expect(s.takeDelete()).toBe(null)
    expect(s.clips).toEqual(['c'])
  })
  it('prune methods drop what has gone and keep the rest', () => {
    const s = full()
    s.pruneClips((i) => i === 'c'); s.pruneEditing(() => true); s.prunePad(() => true); s.pruneNote(() => true)
    expect(s).toMatchObject({ clips: ['c'], editing: 'e', note: 'n', pad: 'p' })
    s.pruneClips(() => false); s.pruneEditing(() => false); s.prunePad(() => false); s.pruneNote(() => false)
    expect(s).toMatchObject({ clips: [], editing: null, note: null, pad: null, armedLooper: 'l' })
  })
})

describe('reactive drawers and tab availability', () => {
  it('a header following one tab runs only when that tab changes', async () => {
    const { createEffect, createRoot } = await import('solid-js')
    const { createTabAvailability } = await import('../src/project/viewState')
    const d = createDrawers()
    const av = createTabAvailability()
    const seen: boolean[] = []
    let other = 0
    const off = createRoot((dispose) => {
      createEffect(() => seen.push(d.isOpen('a', 'fx')))
      createEffect(() => { av.has('a', 'auto'); other++ })
      return dispose
    })
    d.toggle('a', 'auto'); d.toggle('b', 'fx')
    d.toggle('a', 'fx')
    d.closeAll('a')
    av.set('a', 'auto', true); av.set('a', 'auto', true)
    expect(seen).toEqual([false, true, false])
    expect(other).toBe(2)
    off()
  })
})

describe('reactive selection', () => {
  it('fields are signals: effects follow them, and pruning only writes on a change', async () => {
    const { createRoot, createEffect } = await import('solid-js')
    const s = createSelection()
    const seen: string[][] = []
    const dispose = createRoot((d) => (createEffect(() => seen.push(s.clips)), d))
    s.selectClips(['a'])
    s.selectClips(['a', 'b'])
    expect(seen).toEqual([[], ['a'], ['a', 'b']])
    s.pruneClips(() => true) // nothing to drop: no write
    expect(seen.length).toBe(3)
    s.pruneClips((id) => id === 'b')
    expect(seen.at(-1)).toEqual(['b'])
    dispose()
  })
})
