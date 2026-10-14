import { describe, expect, it, vi } from 'vitest'
import { actionFor, cmdForKey, debouncer, describeTrigger, getKeys, keyAllowed, setKey, parseTrigger, sameTrigger } from '../src/midi'

describe('parseTrigger', () => {
  it('accepts note-on and controller changes with a value above 0', () => {
    expect(parseTrigger([0x90, 60, 100])).toEqual({ kind: 'note', channel: 0, number: 60 })
    expect(parseTrigger([0x93, 36, 1])).toEqual({ kind: 'note', channel: 3, number: 36 })
    expect(parseTrigger([0xb1, 64, 127])).toEqual({ kind: 'cc', channel: 1, number: 64 })
  })
  it('ignores note-off, note-on at velocity 0, controllers at 0, and other messages', () => {
    expect(parseTrigger([0x80, 60, 64])).toBeNull()
    expect(parseTrigger([0x90, 60, 0])).toBeNull()
    expect(parseTrigger([0xb0, 64, 0])).toBeNull()
    expect(parseTrigger([0xc0, 5])).toBeNull() // program change
    expect(parseTrigger([0xf8])).toBeNull() // clock
    expect(parseTrigger([])).toBeNull()
  })
})

describe('debouncer', () => {
  it('drops repeats of a switch within 50 ms, but not other switches or later presses', () => {
    const ok = debouncer()
    const a = { kind: 'note' as const, channel: 0, number: 60 }
    const b = { kind: 'cc' as const, channel: 0, number: 60 }
    expect(ok(a, 1000)).toBe(true)
    expect(ok(a, 1030)).toBe(false)
    expect(ok(b, 1031)).toBe(true)
    expect(ok(a, 1100)).toBe(true)
  })
})

describe('bindings', () => {
  it('finds the action of a trigger, and tells triggers apart by kind and channel', () => {
    const t = { kind: 'cc' as const, channel: 2, number: 7 }
    expect(actionFor({ mute: t }, { ...t })).toBe('mute')
    expect(actionFor({ mute: t }, { ...t, channel: 3 })).toBeNull()
    expect(sameTrigger(t, { ...t, kind: 'note' })).toBe(false)
    expect(describeTrigger({ kind: 'note', channel: 0, number: 60 })).toBe('note c4 · ch 1')
  })
})

describe('loop command keys', () => {
  it('default to 1-4, a key means one command, and the studio\'s own keys are refused', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) })
    expect(getKeys()).toEqual({ record: '1', mute: '2', prev: '3', next: '4' })
    expect(cmdForKey(getKeys(), '2')).toBe('mute')
    setKey('record', '2') // steals it
    expect(getKeys()).toEqual({ record: '2', mute: '', prev: '3', next: '4' })
    expect(cmdForKey(getKeys(), '')).toBeNull()
    expect(keyAllowed('z')).toBe(false)
    expect(keyAllowed(' ')).toBe(false)
    expect(keyAllowed('r')).toBe(true)
    vi.unstubAllGlobals()
  })
})
