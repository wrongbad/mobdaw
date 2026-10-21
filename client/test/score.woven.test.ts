// Smoke test on a real imported project (a string quartet from MIDI: badmidi's woven_chaconne). The project state is not committed
// (it is large): point WOVEN_STATE at an agent-API `get_state` dump and run with SLOW=1. Reports where 32nds are left.
import { existsSync, readFileSync } from 'node:fs'
import ABCJS from 'abcjs'
import { describe, expect, test } from 'vitest'
import { buildScore } from '../src/score'
import { stateToInput } from './scoreFixture'

const file = process.env.WOVEN_STATE
describe.runIf(process.env.SLOW && file && existsSync(file))('woven chaconne from a real state dump', () => {
  test('whole piece builds, parses without warnings, and 32nds are rare', () => {
    const state = JSON.parse(readFileSync(file!, 'utf8'))
    const input = stateToInput(state)
    const r = buildScore(input, { show: new Set(input.tracks.map((t) => t.id)), width: 1000 })
    expect(ABCJS.parseOnly(r.abc)[0].warnings).toBeUndefined()
    // a 32nd is `/4` in L:1/8 (a dotted one `3/8`); the voices of one system share its bars
    const tok = /([A-Ga-gz])[,']*(\/4|3\/8)/g
    const per = new Map<string, number>()
    let notes = 0, rests = 0
    for (const line of r.abc.split('\n')) {
      if (!line.startsWith('[V:')) continue
      for (const m of line.matchAll(tok)) {
        if (m[1] === 'z') rests++
        else notes++
        const k = line.slice(0, 5)
        per.set(k, (per.get(k) ?? 0) + 1)
      }
    }
    console.log(`32nd notes ${notes}, 32nd rests ${rests}, per voice`, Object.fromEntries(per))
    expect(notes + rests).toBeLessThan(500)
  })
})
