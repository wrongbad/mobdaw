import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addAudioClip, addMidiClip, addPad, addTrack, ensureTimeline, setRegion, updateClip, updateTrack } from '@mobdaw/shared'
import { contentEnd, contentStart } from '../src/audio/range'

const SR = 48000
const BAR = 4 * 960 // ticks; at the default 120 bpm 4/4 map, 2 s

describe('export range', () => {
  const setup = () => {
    const doc = new Y.Doc()
    const click = addTrack(doc, 'click', 'midi', undefined, 'click')
    const song = addTrack(doc, 'song')
    const other = addTrack(doc, 'other')
    // a one-bar count-in on the click track, the song from bar 2 to bar 4, something else from bar 1 to bar 6
    addMidiClip(doc, { trackId: click, startTick: 0, lengthTicks: BAR })
    addAudioClip(doc, { trackId: song, sourceHash: 'h', start: 2 * SR, length: 4 * SR })
    addAudioClip(doc, { trackId: other, sourceHash: 'h', start: 0, length: 10 * SR })
    return { doc, click, song, other }
  }

  it('covers every clip while nothing is muted or soloed', () => {
    const { doc } = setup()
    expect([contentStart(doc, SR), contentEnd(doc, SR)]).toEqual([0, 10 * SR])
  })

  it('skips muted tracks: a muted count-in is trimmed off the front, a muted tail off the end', () => {
    const { doc, click, other } = setup()
    updateTrack(doc, click, { muted: true })
    updateTrack(doc, other, { muted: true })
    expect([contentStart(doc, SR), contentEnd(doc, SR)]).toEqual([2 * SR, 6 * SR])
  })

  it('with a track soloed only it and the click track count, and a muted click never does', () => {
    const { doc, click, song } = setup()
    updateTrack(doc, song, { soloed: true })
    expect([contentStart(doc, SR), contentEnd(doc, SR)]).toEqual([0, 6 * SR]) // the click's count-in is audible
    updateTrack(doc, click, { muted: true })
    expect([contentStart(doc, SR), contentEnd(doc, SR)]).toEqual([2 * SR, 6 * SR])
  })

  it('a looping MIDI clip counts at its full extent, and pads follow their track', () => {
    const { doc, click, other } = setup()
    const loop = addMidiClip(doc, { trackId: click, startTick: 10 * BAR, lengthTicks: 4 * BAR, loopTicks: BAR })
    expect(contentEnd(doc, SR)).toBe(28 * SR) // 4 bars of 2 s
    updateClip(doc, loop, { loopTicks: 0 })
    expect(contentEnd(doc, SR)).toBe(28 * SR)
    const scape = addTrack(doc, 'scape', 'soundscape')
    addPad(doc, scape, 30 * SR, 2 * SR)
    expect(contentEnd(doc, SR)).toBe(32 * SR)
    updateTrack(doc, scape, { muted: true })
    updateTrack(doc, other, { soloed: true })
    expect(contentEnd(doc, SR)).toBe(28 * SR) // (the click's loop still counts; the muted soundscape does not)
  })

  it('MIDI extents follow the tempo map: a tempo edit moves a clip\'s samples and leaves audio where it is', () => {
    const { doc, click } = setup()
    updateTrack(doc, click, { muted: false })
    const clipId = addMidiClip(doc, { trackId: click, startTick: 20 * BAR, lengthTicks: BAR })
    expect(contentEnd(doc, SR)).toBe(42 * SR) // bar 21 starts at 40 s, one bar of 2 s
    ensureTimeline(doc)
    setRegion(doc, 'default', { bpm: 240 })
    expect(contentEnd(doc, SR)).toBe(21 * SR) // twice as fast: 20 s + 1 s
    expect(clipId).toBeTruthy()
  })

  it('is empty when nothing is audible', () => {
    const doc = new Y.Doc()
    expect([contentStart(doc, SR), contentEnd(doc, SR)]).toEqual([0, 0])
  })
})
