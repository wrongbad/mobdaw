import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { MIX, addTrack, getDevices } from '@mobdaw/shared'
import { MATCHED_PRESETS } from '../src/content/presets.matched'
import { applyPreset, clampParams, presetsFor } from '../src/content/presets'

describe('matched presets', () => {
  it('are offered on MIDI tracks and apply as bore -> filter -> EQ -> reverb', () => {
    const doc = new Y.Doc()
    const t = addTrack(doc, 'midi', 'midi')
    expect(MATCHED_PRESETS).toHaveLength(5)
    for (const p of MATCHED_PRESETS) {
      expect(presetsFor(doc, t).find((x) => x.id === p.id)?.group).toBe('matched')
      applyPreset(doc, t, p.id)
      const devs = getDevices(doc).filter((d) => d.trackId === t && d.type !== MIX)
      expect(devs).toHaveLength(4)
      expect(devs.map((d) => d.type)).toEqual([p.type, ...p.fx.map((f) => f.type)])
    }
  })

  it('keep every param inside its device range', () => {
    for (const p of MATCHED_PRESETS) {
      for (const d of [{ type: p.type, params: p.params }, ...p.fx]) {
        const c = clampParams(d.type, d.params)
        expect(c, p.id).toEqual(Object.fromEntries(Object.entries(d.params).map(([k, v]) => [k, v])))
      }
    }
  })
})
