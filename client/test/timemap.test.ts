// The shared timeline (shared/src/timemap.ts): ticks <-> samples <-> bars across tempo, meter, ramps and free regions.
import { describe, expect, it } from 'vitest'
import { normalizeRegions, regionEnd, snapSampleOr, timeMap, type Region } from '@mobdaw/shared'

const R = 48000
const PPQ = 960
const m = (id: string, bar: number, bpm: number, num = 4, den = 4, extra: object = {}): Region => ({ id, bar, kind: 'metered', bpm, num, den, ...extra })
const free = (id: string, bar: number, length: number): Region => ({ id, bar, kind: 'free', length })
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('timeMap: constant tempo', () => {
  const map = timeMap([m('a', 1, 120)], R, PPQ)
  it('matches the per-clip formula the engine used', () => {
    for (const t of [0, 1, 960, 1234.5, 3840, 100000]) expect(map.tickToSample(t)).toBe(Math.round((t * 60 * R) / (120 * PPQ)))
    expect(map.tickToSample(960)).toBe(24000) // one beat at 120
  })
  it('round-trips', () => {
    for (const t of [0, 7, 960, 12345.678, 1e7]) near(map.sampleToTick(map.tickToSampleExact(t)), t, 1e-6)
    for (const s of [0, 1, 777, 48000, 5e6]) near(map.tickToSampleExact(map.sampleToTick(s)), s, 1e-6)
  })
  it('bars and positions', () => {
    expect(map.barStart(1)).toBe(0)
    expect(map.barStart(3)).toBe(2 * 4 * PPQ)
    expect(map.barStartSample(3)).toBe(4 * R)
    expect(map.position(0)).toMatchObject({ bar: 1, beat: 1, free: false })
    expect(map.position(PPQ * 4 + PPQ * 2.5)).toMatchObject({ bar: 2, beat: 3.5 })
    expect(map.regionAt(5).id).toBe('a')
    expect(map.meterAt(9)).toMatchObject({ num: 4, den: 4, groups: [4], beatTicks: PPQ, barTicks: 4 * PPQ, free: false })
  })
  it('extrapolates before the start', () => {
    expect(map.tickToSample(-960)).toBe(-24000)
    near(map.sampleToTick(-24000), -960)
  })
})

describe('timeMap: meter changes', () => {
  const regs = [m('a', 1, 120), m('b', 3, 90, 7, 8, { groups: [2, 2, 3] }), m('c', 6, 90, 3, 4)]
  const map = timeMap(regs, R, PPQ)
  it('lays bars out by each region meter', () => {
    expect(map.barStart(3)).toBe(8 * PPQ)
    // 7/8: seven eighth-note beats = 3.5 quarters per bar
    expect(map.barStart(4)).toBe(8 * PPQ + 3.5 * PPQ)
    expect(map.barStart(6)).toBe(8 * PPQ + 3 * 3.5 * PPQ)
    expect(map.barStart(7)).toBe(8 * PPQ + 3 * 3.5 * PPQ + 3 * PPQ)
    expect(map.meterAt(4)).toMatchObject({ num: 7, den: 8, groups: [2, 2, 3], beatTicks: PPQ / 2 })
    expect(map.meterAt(4).barTicks).toBe(3.5 * PPQ)
  })
  it('samples follow each tempo', () => {
    expect(map.barStartSample(3)).toBe(4 * R) // 8 beats at 120
    expect(map.barStartSample(4)).toBe(Math.round(4 * R + (3.5 * 60 * R) / 90))
  })
  it('positions across the change', () => {
    expect(map.position(map.barStart(4) + PPQ)).toMatchObject({ bar: 4, beat: 3 }) // two eighths in = beat 3
    expect(map.position(map.barStart(6) - 1).bar).toBe(5)
    expect(map.position(map.barStart(6))).toMatchObject({ bar: 6, beat: 1 })
  })
  it('round-trips every tick sample across regions', () => {
    for (let t = 0; t < 40 * PPQ; t += 137.3) near(map.sampleToTick(map.tickToSampleExact(t)), t, 1e-6)
  })
  it('defaults compound groups', () => {
    expect(timeMap([m('a', 1, 100, 6, 8)], R, PPQ).meterAt(1).groups).toEqual([3, 3])
    expect(timeMap([m('a', 1, 100, 5, 8)], R, PPQ).meterAt(1).groups).toEqual([5])
  })
})

describe('timeMap: ramps', () => {
  // a ramp 60 -> 120 over 4 bars of 4/4 then constant 120
  const map = timeMap([m('a', 1, 60, 4, 4, { rampTo: 120 }), m('b', 5, 120)], R, PPQ)
  const L = 16 * PPQ
  const numeric = (t: number, n = 200000) => {
    let sec = 0
    const dt = t / n
    for (let i = 0; i < n; i++) {
      const b = 60 + (60 * (i + 0.5) * dt) / L
      sec += (60 / (PPQ * b)) * dt
    }
    return sec * R
  }
  it('closed form agrees with the numeric integral', () => {
    for (const t of [PPQ, 5 * PPQ, 9.3 * PPQ, L]) near(map.tickToSampleExact(t), numeric(t), 0.05)
  })
  it('the ramp region lasts L ticks of mean-log tempo time', () => {
    const exp = ((60 * L) / (PPQ * 60)) * Math.log(2) * R
    near(map.barStartSample(5), Math.round(exp), 0.6)
  })
  it('inverts with exp, no drift', () => {
    for (const t of [0, 1, 3000, L / 2, L - 1, L + 5000, 10 * L]) near(map.sampleToTick(map.tickToSampleExact(t)), t, 1e-5)
    for (const s of [0, 100, 90000, 400000]) near(map.tickToSampleExact(map.sampleToTick(s)), s, 1e-5)
  })
  it('starts at bpm and is continuous into the next region', () => {
    near(map.tickToSampleExact(1) - map.tickToSampleExact(0), (60 * R) / (60 * PPQ), 5e-3)
    const eps = 1e-3
    near(map.tickToSampleExact(L + eps) - map.tickToSampleExact(L - eps), (2 * eps * 60 * R) / (120 * PPQ), 1e-4)
  })
  it('bpm == rampTo is linear and a ramp in the last region is ignored', () => {
    const flat = timeMap([m('a', 1, 100, 4, 4, { rampTo: 100 }), m('b', 3, 100)], R, PPQ)
    expect(flat.tickToSample(5000)).toBe(Math.round((5000 * 60 * R) / (100 * PPQ)))
    const last = timeMap([m('a', 1, 100, 4, 4, { rampTo: 200 })], R, PPQ)
    expect(last.tickToSample(5000)).toBe(Math.round((5000 * 60 * R) / (100 * PPQ)))
  })
})

describe('timeMap: free regions', () => {
  // bar 1 at 100 bpm, bar 2 free for 3 s, then bars continue at 100 from bar 3, with a tempo change at 5
  const regs = [m('a', 1, 100), free('f', 2, 3 * R), m('c', 3, 100), m('d', 5, 150)]
  const map = timeMap(regs, R, PPQ)
  it('is a bijection with nominal ticks at the previous tempo', () => {
    const barTicks = 4 * PPQ
    const nominal = (3 * R * 100 * PPQ) / (60 * R)
    expect(map.barStart(3)).toBe(barTicks + nominal)
    expect(map.barStartSample(3)).toBe(Math.round((barTicks * 60 * R) / (100 * PPQ)) + 3 * R)
    for (const t of [barTicks, barTicks + 10, barTicks + nominal - 1, barTicks + nominal + 1]) near(map.sampleToTick(map.tickToSampleExact(t)), t, 1e-6)
  })
  it('has no beats and says so', () => {
    const t = map.barStart(2) + 100
    expect(map.regionAt(t).kind).toBe('free')
    expect(map.position(t)).toMatchObject({ bar: 2, beat: 1, free: true })
    expect(map.meterAt(2).free).toBe(true)
    expect(map.snapSample(map.tickToSample(t), 'beat')).toBeNull()
    expect(snapSampleOr(map, map.tickToSample(t), 'beat')).toBe(map.tickToSample(t))
  })
  it('uses 120 when first and fills after a lone free bar with the previous meter', () => {
    const first = timeMap([free('f', 1, R), ], R, PPQ)
    expect(first.barStart(2)).toBe(PPQ * 2) // 1 s at 120 bpm = 2 beats
    expect(first.meterAt(2)).toMatchObject({ num: 4, den: 4, bpm: 120, free: false })
    expect(first.regionAt(first.barStart(2)).kind).toBe('metered')
    const gap = timeMap([m('a', 1, 90, 3, 4), free('f', 2, R)], R, PPQ)
    expect(gap.meterAt(5)).toMatchObject({ num: 3, bpm: 90 })
  })
  it('regionEnd', () => {
    expect(regionEnd(map, 'a')).toEqual({ bar: 2, tick: map.barStart(2), sample: map.barStartSample(2) })
    expect(regionEnd(map, 'd')).toBeNull()
  })
})

describe('bars()', () => {
  const map = timeMap([m('a', 1, 120), m('b', 3, 60, 3, 4)], R, PPQ)
  it('lists bar lines and beats in a window', () => {
    const { lines, free } = map.bars(0, 4 * R)
    expect(free).toEqual([])
    expect(lines.length).toBe(8) // bars 1-2: 4 beats each at 0.5 s; bar 3 starts at 4 s (excluded)
    expect(lines.map((l) => l.sample)).toEqual([0, 24000, 48000, 72000, 96000, 120000, 144000, 168000])
    expect(lines.filter((l) => l.isBar).map((l) => l.bar)).toEqual([1, 2])
    expect(lines[5]).toMatchObject({ bar: 2, beat: 2, isBar: false, isGroup: false })
  })
  it('straddles a region change', () => {
    const { lines } = map.bars(3 * R, 7 * R)
    expect(lines.map((l) => [l.bar, l.beat])).toEqual([[2, 3], [2, 4], [3, 1], [3, 2], [3, 3]])
    expect(lines.find((l) => l.bar === 3 && l.beat === 1)!.sample).toBe(4 * R)
    expect(lines.find((l) => l.bar === 3 && l.beat === 2)!.sample).toBe(5 * R) // beats now 1 s
  })
  it('marks group starts', () => {
    const g = timeMap([m('a', 1, 120, 7, 8, { groups: [2, 2, 3] })], R, PPQ)
    const { lines } = g.bars(0, 3 * R)
    expect(lines.slice(0, 7).map((l) => l.isGroup)).toEqual([true, false, true, false, true, false, false])
    expect(lines.slice(0, 7).filter((l) => l.isBar).length).toBe(1)
  })
  it('reports free spans and omits their beats', () => {
    const f = timeMap([m('a', 1, 120), free('f', 2, 3 * R), m('c', 3, 120)], R, PPQ)
    const { lines, free: spans } = f.bars(0, 12 * R)
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({ bar: 2, fromSample: 2 * R, toSample: 5 * R })
    expect(lines.filter((l) => l.bar === 2)).toHaveLength(1)
    expect(lines.find((l) => l.bar === 2)).toMatchObject({ free: true, isBar: true })
    expect(lines.find((l) => l.bar === 3 && l.beat === 1)!.sample).toBe(5 * R)
    // a window wholly inside the free span still reports it
    expect(f.bars(3 * R, 4 * R)).toEqual({ lines: [], free: [expect.objectContaining({ bar: 2 })] })
  })
  it('handles empty and reversed windows', () => {
    expect(map.bars(10, 10)).toEqual({ lines: [], free: [] })
    expect(map.bars(10, 5)).toEqual({ lines: [], free: [] })
  })
})

describe('snapping', () => {
  const map = timeMap([m('a', 1, 120), m('b', 3, 60)], R, PPQ)
  it('snaps to bars, beats and subdivisions', () => {
    expect(map.snapSample(2 * R - 1000, 'bar')).toBe(2 * R)
    expect(map.snapSample(2 * R + 1000, 'bar')).toBe(2 * R)
    expect(map.snapSample(24000 + 3000, 'beat')).toBe(24000)
    expect(map.snapSample(24000 + 13000, 'beat')).toBe(48000)
    expect(map.snapSample(24000 + 7000, 2)).toBe(36000) // half beats
  })
  it('snaps to the region end bar from below and uses the new tempo after', () => {
    expect(map.snapSample(4 * R - 100, 'beat')).toBe(4 * R)
    expect(map.snapSample(4 * R + 100, 'beat')).toBe(4 * R)
    expect(map.snapSample(4 * R + 30000, 'beat')).toBe(5 * R) // beats are 1 s here
  })
})

describe('editing a region mid-song', () => {
  it('moves every later bar', () => {
    const before = timeMap([m('a', 1, 120), m('b', 5, 120)], R, PPQ)
    const after = timeMap([m('a', 1, 60), m('b', 5, 120)], R, PPQ)
    expect(after.barStartSample(5)).toBe(2 * before.barStartSample(5))
    expect(after.barStart(9)).toBe(before.barStart(9)) // ticks don't move
    expect(after.barStartSample(9)).toBe(Math.round(after.barStartSample(5) + (4 * 4 * 60 * R) / 120))
  })
})

describe('normalizeRegions', () => {
  it('synthesizes bar 1, sorts and keeps a later first region', () => {
    expect(normalizeRegions([])).toEqual([{ id: 'default', bar: 1, kind: 'metered', bpm: 120, num: 4, den: 4 }])
    const r = normalizeRegions([m('z', 9, 90), m('y', 5, 100)])
    expect(r.map((x) => [x.id, x.bar])).toEqual([['default', 1], ['y', 5], ['z', 9]])
  })
  it('keeps the smallest id per bar, in any input order', () => {
    const a = normalizeRegions([m('b', 1, 90), m('a', 1, 100), m('c', 1, 80), m('q', 4, 1)])
    const b = normalizeRegions([m('q', 4, 1), m('c', 1, 80), m('a', 1, 100), m('b', 1, 90)])
    expect(a).toEqual(b)
    expect(a.map((x) => x.id)).toEqual(['a', 'q'])
  })
  it('clamps junk and does not mutate its input', () => {
    const input: Region[] = [{ id: 'a', bar: 0.4, kind: 'metered', bpm: NaN, num: 0, den: 4, groups: [1, 1], rampTo: -3 }]
    const r = normalizeRegions(input)
    expect(r[0]).toEqual({ id: 'a', bar: 1, kind: 'metered', bpm: 120, num: 1, den: 4 })
    expect(input[0].bar).toBe(0.4)
  })
})
