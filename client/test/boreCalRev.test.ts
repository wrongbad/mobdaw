// Bore presets record the bore_cal.rs revision they were tuned against (docs/matching.md).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BORE } from '@mobdaw/shared'
import { INSTRUMENT_PRESETS } from '../src/content/presets'

describe('bore calibration revision', () => {
  it('every bore preset was tuned against the current bore_cal.rs revision', () => {
    const src = readFileSync(new URL('../../engine/crates/dsp/src/bore_cal.rs', import.meta.url), 'utf8')
    const rev = Number(/pub const BORE_CAL_REV: u32 = (\d+);/.exec(src)?.[1])
    expect(Number.isInteger(rev), 'BORE_CAL_REV in bore_cal.rs').toBe(true)
    const bores = INSTRUMENT_PRESETS.filter((p) => p.type === BORE)
    expect(bores.length).toBeGreaterThan(0)
    const stale = bores.filter((p) => p.calRev !== rev).map((p) => `${p.id} (calRev ${p.calRev})`)
    expect(stale, `bore_cal.rs is at BORE_CAL_REV ${rev}: re-check these presets by ear (retune if needed), then bump their calRev in presets.ts`).toEqual([])
  })
})
