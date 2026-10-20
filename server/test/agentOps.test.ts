import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { getClips, getDevices, getMarkers, getNotes, getRegions, getTracks, getKey, addTrack, MASTER_TRACK } from '@mobdaw/shared'
import { OpError, applyAtomic, parseOps, runOps } from '../src/agentOps.ts'

const run = (doc: Y.Doc, ops: unknown[]) => runOps(doc, parseOps(ops))

describe('agent ops', () => {
  it('build a song with references, and edit it', () => {
    const doc = new Y.Doc()
    const r = run(doc, [
      { op: 'addTrack', name: 'Keys' },
      { op: 'addMidiClip', trackId: '$0', start: '1', length: '1 bar' },
      { op: 'addNotes', clipId: '$1', notes: [{ p: 'C4', t: 0, d: '1 beat' }, { p: 'E4', t: '1 beat', d: '1 beat', v: 64 }, { p: 'g4', t: '2 beats', d: '2 beats' }] },
      { op: 'updateNotes', notes: [{ id: '$2.0', p: 'D4', v: 127 }] },
      { op: 'removeNotes', ids: ['$2.2'] },
      { op: 'updateClip', id: '$1', start: '3.1', length: '2 bars', loop: '1 bar' },
      { op: 'addDevice', trackId: 'master', type: 'compressor' },
      { op: 'addRegion', bar: 5, bpm: 140, rampTo: 150 },
      { op: 'setRegion', bar: 5, meter: '7/8 2+2+3' },
      { op: 'addMarker', bar: 3, label: 'Chorus' },
      { op: 'setKey', key: 'E minor' },
      { op: 'updateTrack', id: '$0', name: 'Piano', muted: true },
    ])
    expect(r).toHaveLength(12)
    const clip = getClips(doc)[0]
    expect(clip).toMatchObject({ startTick: 7680, lengthTicks: 7680, loopTicks: 3840 })
    expect(getNotes(doc).map((n) => [n.pitch, n.tick, Math.round(n.velocity * 127)]).sort()).toEqual([[62, 0, 127], [64, 960, 64]])
    expect(getDevices(doc).find((d) => d.trackId === MASTER_TRACK)).toBeTruthy()
    expect(getRegions(doc).find((x) => x.bar === 5)).toMatchObject({ bpm: 140, rampTo: 150, num: 7, den: 8, groups: [2, 2, 3] })
    expect(getMarkers(doc)).toMatchObject([{ bar: 3, label: 'Chorus' }])
    expect(getKey(doc)).toBe('E minor')
    expect(getTracks(doc)[0]).toMatchObject({ name: 'Piano', muted: true })
    // a new midi track brings the default synth; remove it all again
    expect(getDevices(doc).filter((d) => d.trackId === getTracks(doc)[0].id).map((d) => d.type)).toEqual([2, 9])
    run(doc, [{ op: 'removeClip', id: clip.id }, { op: 'removeTrack', id: getTracks(doc)[0].id }])
    expect(getNotes(doc)).toEqual([])
    expect(getTracks(doc)).toEqual([])
  })

  it('names the failing op and the way out', () => {
    const doc = new Y.Doc()
    const fail = (ops: unknown[]) => {
      try {
        run(doc, ops)
      } catch (e) {
        expect(e).toBeInstanceOf(OpError)
        return (e as OpError).message
      }
      throw new Error('did not fail')
    }
    const t = addTrack(doc, 'A', 'audio')
    expect(fail([{ op: 'addMidiClip', trackId: t, start: '1', length: '1 bar' }])).toContain('midi tracks')
    expect(fail([{ op: 'addTrack', name: 'x' }, { op: 'addNotes', clipId: '$0', notes: [] }])).toContain('no clip')
    expect(fail([{ op: 'addTrack', name: 'x' }, { op: 'addMidiClip', trackId: '$0', start: '1', length: '1 bar' }, { op: 'addNotes', clipId: '$1', notes: [{ p: 'H9', t: 0, d: 1 }] }])).toContain('bad pitch')
    expect(fail([{ op: 'addTrack', name: 'x' }, { op: 'addMidiClip', trackId: '$0', start: '1', length: '1 bar' }, { op: 'addNotes', clipId: '$1', notes: [{ p: 'C4', t: '2 bars', d: 1 }] }])).toContain('past the end')
    expect(fail([{ op: 'addDevice', trackId: t, type: 'nope' }])).toContain('unknown device type')
    expect(fail([{ op: 'addTrack', name: 'x', kind: 'midi', foo: 1 }])).toContain('unknown field "foo"')
    expect(fail([{ op: 'addTrack', name: 'x' }, { op: 'removeTrack', id: '$1' }])).toContain('not run yet')
  })

  it('applies atomically: a failing batch leaves the document untouched', () => {
    const doc = new Y.Doc()
    addTrack(doc, 'Keep', 'audio')
    const sv = Y.encodeStateVector(doc)
    expect(() => applyAtomic(doc, parseOps([{ op: 'addTrack', name: 'New' }, { op: 'removeTrack', id: 'nope' }]))).toThrow(OpError)
    expect(Y.encodeStateAsUpdate(doc, sv).length).toBeLessThan(10)
    expect(getTracks(doc)).toHaveLength(1)
    const [id] = applyAtomic(doc, parseOps([{ op: 'addTrack', name: 'New', kind: 'audio' }]))
    expect(getTracks(doc).map((x) => x.id)).toContain(id)
  })

  it('addTrack like copies another track\'s chain, params, fader and colour', () => {
    const doc = new Y.Doc()
    const [src] = run(doc, [
      { op: 'addTrack', name: 'GM Violin', preset: 'none' },
      { op: 'addDevice', trackId: '$0', type: 'finnwave', name: 'GM Violin', params: { rolloff: 0.7 } },
      { op: 'addDevice', trackId: '$0', type: 'reverb' },
      { op: 'updateTrack', id: '$0', color: 3 },
    ]) as string[]
    run(doc, [{ op: 'addTrack', name: 'Violin 3', like: 'gm violin' }])
    const [a, b] = getTracks(doc)
    expect(b).toMatchObject({ name: 'Violin 3', color: 3 })
    const chain = (id: string) => getDevices(doc).filter((d) => d.trackId === id).sort((x, y) => x.order - y.order).map(({ type, name, params }) => ({ type, name, params }))
    expect(chain(b.id)).toEqual(chain(a.id))
    expect(chain(b.id).length).toBeGreaterThanOrEqual(3)
    expect(src).toBe(a.id)
    const msg = (ops: unknown[]) => { try { run(doc, ops) } catch (e) { return (e as OpError).message } return '' }
    expect(msg([{ op: 'addTrack', name: 'x', like: 'nobody' }])).toContain('no track "nobody"')
    expect(msg([{ op: 'addTrack', name: 'x', like: a.id, preset: 'finnwave' }])).toContain('alternatives')
  })

  it('takes a whole piece in one batch', () => {
    const doc = new Y.Doc()
    const notes = Array.from({ length: 20_000 }, (_, i) => ({ p: 40 + (i % 40), t: (i % 960) * 4, d: 1, v: 90 }))
    const t0 = Date.now()
    applyAtomic(doc, parseOps([{ op: 'addTrack', name: 'Big' }, { op: 'addMidiClip', trackId: '$0', start: '1', length: '300 bars' }, { op: 'addNotes', clipId: '$1', notes }]))
    expect(getNotes(doc)).toHaveLength(20_000)
    console.log(`20k notes applied in ${Date.now() - t0} ms`)
    expect(() => parseOps([{ op: 'addNotes', clipId: 'x', notes: new Array(100_001).fill({ p: 'C4', t: 0, d: 1 }) }])).toThrow('at most 100000 notes')
  })

  it('setRegion on the implied default region of a fresh project writes it out', () => {
    const doc = new Y.Doc()
    run(doc, [{ op: 'setRegion', bar: 1, meter: '3/4', bpm: 60 }])
    expect(getRegions(doc)).toMatchObject([{ bar: 1, kind: 'metered', bpm: 60, num: 3, den: 4 }])
    run(doc, [{ op: 'setRegion', bar: 1, meter: '7/8 2+2+3' }, { op: 'setRegion', bar: 1, meter: '4/4' }])
    expect(getRegions(doc)[0]).toMatchObject({ bpm: 60, num: 4, den: 4 })
    expect(getRegions(doc)[0]).not.toHaveProperty('groups')
  })
})
