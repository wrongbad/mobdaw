// Regenerates agent/tests/timemap_fixture.json from shared/src/timemap.ts, the reference for badmidi's Timeline seconds math:
//   npx tsx agent/tests/gen_timemap_fixture.ts > agent/tests/timemap_fixture.json
import { timeMap } from '../../shared/src/timemap.ts'
import type { Region } from '../../shared/src/schema.ts'

const RATE = 48000, PPQ = 960
type R = Record<string, any>
// regions in the agent view's spelling (docs/agent-api.md)
const cases: Record<string, { regions: R[]; bars: number }> = {
  constant: { regions: [{ id: 'a', bar: 1, kind: 'metered', bpm: 120, meter: '4/4' }], bars: 6 },
  meterChange: { regions: [{ id: 'a', bar: 1, kind: 'metered', bpm: 90, meter: '3/4' }, { id: 'b', bar: 5, kind: 'metered', bpm: 100, meter: '7/8' }, { id: 'c', bar: 8, kind: 'metered', bpm: 100, meter: '6/8' }], bars: 11 },
  ramp: { regions: [{ id: 'a', bar: 1, kind: 'metered', bpm: 100, meter: '4/4', rampTo: 140 }, { id: 'b', bar: 5, kind: 'metered', bpm: 140, meter: '4/4' }, { id: 'c', bar: 7, kind: 'metered', bpm: 80, meter: '5/8', rampTo: 60 }, { id: 'd', bar: 10, kind: 'metered', bpm: 60, meter: '5/8' }], bars: 12 },
  freeBar: { regions: [{ id: 'a', bar: 1, kind: 'metered', bpm: 80, meter: '3/4', rampTo: 120 }, { id: 'b', bar: 3, kind: 'free', seconds: 2.5 }, { id: 'c', bar: 6, kind: 'metered', bpm: 90, meter: '4/4' }], bars: 8 },
  freeFirst: { regions: [{ id: 'a', bar: 1, kind: 'free', seconds: 3 }, { id: 'b', bar: 2, kind: 'metered', bpm: 100, meter: '2/4' }], bars: 5 },
}
const toRegion = (r: R): Region => {
  if (r.kind === 'free') return { id: r.id, bar: r.bar, kind: 'free', length: Math.round(r.seconds * RATE) } as Region
  const [num, den] = r.meter.split('/').map(Number)
  return { id: r.id, bar: r.bar, kind: 'metered', bpm: r.bpm, num, den, ...(r.rampTo != null ? { rampTo: r.rampTo } : {}) } as Region
}
const out: Record<string, unknown> = { ppq: PPQ, sampleRate: RATE }
for (const [name, c] of Object.entries(cases)) {
  const m = timeMap(c.regions.map(toRegion), RATE, PPQ)
  const ticks = [0, 1, 480, 960, 2500, 3840, 7000, 11520, 15000, 20000, 26880, 33333, 50000, 70000, 100000]
  const lines = m.bars(0, 1e12).lines.filter((l) => l.bar < c.bars)
  const secs = ticks.map((t) => m.tickToSampleExact(t) / RATE)
  out[name] = {
    regions: c.regions,
    ticks: ticks.map((t, i) => [t, secs[i]]),
    seconds: [0, 0.01, 0.5, 1, 2.2, 3.7, 6, 9.99, 15, 25, 40].map((s) => [s, m.sampleToTick(s * RATE)]),
    bars: [1, 2, 3, 4, 5, 6, 8].map((b) => [b, m.barStart(b)]),
    grid: lines.map((l) => [l.tick, m.tickToSampleExact(l.tick) / RATE, l.bar, l.isBar]),
    toBar: c.bars,
  }
}
console.log(JSON.stringify(out, null, 1))
