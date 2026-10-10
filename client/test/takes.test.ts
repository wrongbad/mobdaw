import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addAudioClip, addSample, addTrack, deleteClip, getSamples, type SampleMeta } from '@mobdaw/shared'
import { isMine, myTakes, sweepUnusedTakes, type TakeCtx } from '../src/takes'

const take = (hash: string, by: number): SampleMeta => ({ hash, name: hash, duration: 1, size: 10, mime: 'audio/wav', status: 'incoming', by, byName: `u${by}` })
const ctx = (doc: Y.Doc, id: number | null): TakeCtx => ({ doc, projectId: 'p', me: id == null ? null : { id, name: `u${id}` }, rate: 48000 })

describe('incoming takes', () => {
  it('are mine by user id, and never mine in a project on this device', () => {
    const doc = new Y.Doc()
    expect(isMine(ctx(doc, 1), take('a', 1))).toBe(true)
    expect(isMine(ctx(doc, 2), take('a', 1))).toBe(false)
    expect(isMine(ctx(doc, null), take('a', 1))).toBe(false)
  })

  it('an undone take (no clip plays it) is not uploaded, and is swept when the project next opens', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'a')
    addSample(doc, take('kept', 1))
    addSample(doc, take('undone', 1))
    addSample(doc, take('theirs', 2))
    addAudioClip(doc, { trackId: t, sourceHash: 'kept', start: 0, length: 10 })
    deleteClip(doc, addAudioClip(doc, { trackId: t, sourceHash: 'undone', start: 0, length: 10 }))
    expect(myTakes(ctx(doc, 1)).map((m) => m.hash)).toEqual(['kept'])
    sweepUnusedTakes(ctx(doc, 1))
    expect(Object.keys(getSamples(doc)).sort()).toEqual(['kept', 'theirs']) // (someone else's are theirs to sweep)
  })
})
