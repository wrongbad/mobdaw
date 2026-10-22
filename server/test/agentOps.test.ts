import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { agentText, agentView, getLanes, getPoints, getClips, getDevices, getMarkers, getNotes, getRegions, getTracks, getKey, addTrack, MASTER_TRACK } from '@mobdaw/shared'
import { OpError, applyAtomic, parseOps, runOps } from '../src/agentOps.ts'

const run = (doc: Y.Doc, ops: unknown[]) => runOps(doc, parseOps(ops))

describe('agent ops: automation', () => {
  it('writes lanes and points in the param\'s units and shows them back', () => {
    const doc = new Y.Doc()
    const track = run(doc, [{ op: 'addTrack', name: 'Flute' }])[0] as string
    const mix = getDevices(doc).find((d) => d.trackId === track && d.type === 9)!
    const [lane, pts] = run(doc, [
      { op: 'addLane', deviceId: mix.id, param: 'volume', points: [{ t: '1', v: 1 }, { t: '3', v: 0.5, curve: 'hold' }] },
      { op: 'addPoints', laneId: '$0', points: [{ t: '5', v: 0 }] },
    ]).slice(0, 2) as [string, string[]]
    const p = getPoints(doc).sort((a, b) => a.pos - b.pos)
    expect(p.map((x) => [x.pos, x.value, x.curve])).toEqual([[0, 0.5, 'linear'], [2 * 2 * 48000, 0.25, 'hold'], [4 * 2 * 48000, 0, 'linear']])
    expect(getLanes(doc)).toMatchObject([{ id: lane, enabled: true, scope: track, owner: mix.id }])
    const txt = agentText(doc)
    expect(txt).toContain('1.1.0=1')
    expect(txt).toContain('3.1.0=0.5 hold')
    expect(agentView(doc).tracks[0].lanes![0].points.map((x) => x.v)).toEqual([1, 0.5, 0])
    run(doc, [{ op: 'updatePoints', points: [{ id: pts[0], v: 2 }] }, { op: 'updateLane', id: lane, enabled: false }, { op: 'removePoints', ids: [p[0].id] }])
    expect(getLanes(doc)[0].enabled).toBe(false)
    expect(getPoints(doc)).toHaveLength(2)
    run(doc, [{ op: 'removeLane', id: lane }])
    expect(getLanes(doc)).toEqual([])
    expect(getPoints(doc)).toEqual([])
    expect(() => run(doc, [{ op: 'addLane', deviceId: 'nope', param: 'volume' }])).toThrow('no device')
  })
})

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

  describe('notation hints', () => {
    const setup = () => {
      const doc = new Y.Doc()
      const r = run(doc, [{ op: 'addTrack', name: 'Vn', clefs: ['treble', 'bass'] }, { op: 'addMidiClip', trackId: '$0', start: '1', length: '2 bars' }])
      return { doc, trackId: r[0] as string, clipId: r[1] as string }
    }
    const fail = (doc: Y.Doc, ops: unknown[]) => {
      try {
        run(doc, ops)
      } catch (e) {
        expect(e).toBeInstanceOf(OpError)
        return (e as OpError).message
      }
      throw new Error('did not fail')
    }
    const hint = { on: [3, 4], len: [1, 4], segs: [[1, 8], [1, 8]], tup: { n: 5, of: 4, start: [1, 1], span: [1, 1] }, staff: 2, voice: 1, spell: 'B#3', art: "'>" }

    it('adds a hint with the server computing at, and stores clefs on the track', () => {
      const { doc, clipId } = setup()
      expect(getTracks(doc)[0].clefs).toEqual(['treble', 'bass'])
      run(doc, [{ op: 'addNotes', clipId, notes: [{ p: 'C4', t: 720, d: 240, hint }, { p: 'D4', t: 0, d: 480 }] }])
      const [a, b] = getNotes(doc).sort((x, y) => y.tick - x.tick)
      expect(a.hint).toEqual({ ...hint, at: [720, 240, 60] })
      expect(b.hint).toBeUndefined()
    })

    it('updates, keeps a stale hint when t/d/p change alone, and removes with null', () => {
      const { doc, clipId } = setup()
      const [ids] = run(doc, [{ op: 'addNotes', clipId, notes: [{ p: 'C4', t: 720, d: 240, hint }] }]) as [string[]]
      const id = ids[0]
      run(doc, [{ op: 'updateNotes', notes: [{ id, t: 960 }] }])
      expect(getNotes(doc)[0].hint!.at).toEqual([720, 240, 60]) // unchanged: now stale
      expect(getNotes(doc)[0].tick).toBe(960)
      run(doc, [{ op: 'updateNotes', notes: [{ id, p: 'A3', hint: { on: [1, 1], len: [1, 4], spell: 'A3' } }] }])
      expect(getNotes(doc)[0].hint).toEqual({ at: [960, 240, 57], on: [1, 1], len: [1, 4], spell: 'A3' })
      run(doc, [{ op: 'updateNotes', notes: [{ id, hint: { on: [1, 1], len: [1, 4] } }] }])
      expect(getNotes(doc)[0].hint!.at).toEqual([960, 240, 57]) // from the current note
      run(doc, [{ op: 'updateNotes', notes: [{ id, hint: null }] }])
      expect(getNotes(doc)[0].hint).toBeUndefined()
      run(doc, [{ op: 'updateTrack', id: getTracks(doc)[0].id, clefs: null }])
      expect(getTracks(doc)[0].clefs).toBeUndefined()
    })

    it('validates the hint strictly', () => {
      const { doc, clipId } = setup()
      const add = (h: unknown) => fail(doc, [{ op: 'addNotes', clipId, notes: [{ p: 'C4', t: 0, d: 240, hint: h }] }])
      const ok = { on: [0, 1], len: [1, 4] }
      expect(add(5)).toContain('hint must be an object')
      expect(add({ ...ok, at: [0, 240, 60] })).toContain('"at" is set by the server')
      expect(add({ ...ok, foo: 1 })).toContain('unknown field "foo"')
      expect(add({ len: [1, 4] })).toContain('"on" is required')
      expect(add({ on: [0, 0], len: [1, 4] })).toContain('denominator > 0')
      expect(add({ on: [0.5, 1], len: [1, 4] })).toContain('integers')
      expect(add({ on: [0, 1], len: [0, 4] })).toContain('hint.len must be > 0')
      expect(add({ ...ok, segs: [[1, 8], [1, 4]] })).toContain('add up to len')
      expect(add({ ...ok, segs: [[1, 4], [0, 4]] })).toContain('segs[1]')
      expect(add({ ...ok, tup: { n: 0, of: 4, start: [0, 1], span: [1, 1] } })).toContain('tup.n must be a positive integer')
      expect(add({ ...ok, tup: { n: 5, of: 1.5, start: [0, 1], span: [1, 1] } })).toContain('tup.of')
      expect(add({ ...ok, staff: 0 })).toContain('staff must be a positive integer')
      expect(add({ ...ok, voice: 1.5 })).toContain('voice')
      expect(add({ ...ok, spell: 'H4' })).toContain('note name')
      expect(add({ ...ok, spell: 'D4' })).toContain("does not name the note's pitch")
      expect(add({ ...ok, art: 'x' })).toContain('hint.art')
      expect(fail(doc, [{ op: 'updateTrack', id: getTracks(doc)[0].id, clefs: ['soprano'] }])).toContain('bad clefs')
      expect(getNotes(doc)).toEqual([])
    })
  })
})
