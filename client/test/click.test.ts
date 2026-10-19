import { describe, expect, it } from 'vitest'
import { timeMap, type Region } from '@mobdaw/shared'
import { CLICK_ACCENT_KEY, CLICK_GROUP_VELOCITY, CLICK_TICK_KEY, clickEvents } from '../src/audio/click'

const SR = 48000
const PPQ = 960
const metered = (o: Partial<Extract<Region, { kind: 'metered' }>> & { id: string; bar: number }): Region => ({ kind: 'metered', bpm: 120, num: 4, den: 4, ...o })

/** The accent-drum hits as [beat index from the start, velocity]; `ticks` are the tick-drum hits' beat indexes. */
const accents = (regions: Region[], seconds: number) => {
  const map = timeMap(regions, SR, PPQ)
  const ev = clickEvents(map, 0, seconds * SR)
  return { map, ev, ticks: ev.filter((e) => e.pitch === CLICK_TICK_KEY), acc: ev.filter((e) => e.pitch === CLICK_ACCENT_KEY) }
}

describe('click track generated from the time map', () => {
  it('4/4: a tick on every beat, the accent (velocity 1) on the bar line only', () => {
    const { ticks, acc } = accents([metered({ id: 'a', bar: 1 })], 4.1)
    expect(ticks.map((e) => e.sample)).toEqual(Array.from({ length: 9 }, (_, i) => i * 24000)) // 120 bpm: a beat every 0.5 s
    expect(ticks.every((e) => e.velocity === 1)).toBe(true)
    expect(acc.map((e) => [e.sample, e.velocity])).toEqual([[0, 1], [96000, 1], [192000, 1]])
  })

  it('6/8 in two groups of three: a softer accent on beat 4', () => {
    const { ticks, acc } = accents([metered({ id: 'a', bar: 1, num: 6, den: 8, bpm: 120 })], 2.01)
    expect(ticks).toHaveLength(9) // eighths at 120 quarter/min: 0.25 s apart; 2 s = 8 beats + the one at 2.0
    expect(acc.map((e) => [e.sample, e.velocity])).toEqual([[0, 1], [36000, CLICK_GROUP_VELOCITY], [72000, 1]]) // beat 4 is 36000 samples in
  })

  it('2+2+3/8: group starts on beats 3 and 5 of every bar', () => {
    const { acc } = accents([metered({ id: 'a', bar: 1, num: 7, den: 8, groups: [2, 2, 3] })], 3.4)
    const beat = 12000 // an eighth at 120 quarter notes/min
    expect(acc.map((e) => [e.sample / beat, e.velocity])).toEqual([[0, 1], [2, 0.5], [4, 0.5], [7, 1], [9, 0.5], [11, 0.5]])
  })

  it('a free region is silent, then the click resumes on the next bar', () => {
    const { ev } = accents([{ id: 'f', bar: 1, kind: 'free', length: 96000 }, metered({ id: 'm', bar: 2 })], 6)
    expect(Math.min(...ev.map((e) => e.sample))).toBe(96000)
    expect(ev.filter((e) => e.sample < 96000)).toEqual([])
  })

  it('under a ramp every hit sits at map.tickToSample of its beat, and the beats get closer', () => {
    const regions = [metered({ id: 'a', bar: 1, bpm: 60, rampTo: 180 }), metered({ id: 'b', bar: 5, bpm: 180 })]
    const { map, ticks } = accents(regions, 12)
    expect(ticks.length).toBeGreaterThan(16)
    for (const e of ticks) expect(e.sample).toBe(map.tickToSample(e.tick))
    const gaps = ticks.slice(1, 16).map((e, i) => e.sample - ticks[i].sample)
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeLessThanOrEqual(gaps[i - 1])
    expect(gaps[0]).toBeGreaterThan(gaps.at(-1)!)
  })

  it('a window only returns its own hits', () => {
    const map = timeMap([metered({ id: 'a', bar: 1 })], SR, PPQ)
    const ev = clickEvents(map, 96000, 120000)
    expect(ev.map((e) => [e.sample, e.pitch])).toEqual([[96000, CLICK_TICK_KEY], [96000, CLICK_ACCENT_KEY]])
  })
})
