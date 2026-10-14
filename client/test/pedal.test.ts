import { describe, expect, it } from 'vitest'
import { heardPosition } from '../src/audio/pedal'

const RATE = 1000

describe('heardPosition', () => {
  it('maps a performance.now stamp through the output timestamp and the engine report', () => {
    // the engine stood at timeline 5000 when context frame 10000 was rendered; the speaker plays context time 9.95 s
    // (50 ms behind) at performance time 1000 ms, so a press at 1020 ms is at context time 9.97 s = frame 9970
    const heard = heardPosition({ pos: 5000, frame: 10000 }, { contextTime: 9.95, performanceTime: 1000 }, 1020, RATE)
    expect(heard).toBe(5000 + (9970 - 10000))
  })
  it('is exact at the timestamp itself and moves with time', () => {
    const r = { pos: 777, frame: 1234 }
    const ts = { contextTime: 1.234, performanceTime: 50 }
    expect(heardPosition(r, ts, 50, RATE)).toBe(777)
    expect(heardPosition(r, ts, 80, RATE)).toBe(807)
  })
})
