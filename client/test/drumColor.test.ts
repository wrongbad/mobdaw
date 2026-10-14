import { describe, expect, it } from 'vitest'
import { DEVICES, LOFI_DRUM, type Device } from '@mobdaw/shared'
import { deviceDrumColor, drumColor } from '../src/ui/drumColor'
import { FILTER_COLORS } from '../src/ui/filterCurve'

const drum = (id: string, key: number) => ({ id, type: LOFI_DRUM, keyLo: key, keyHi: key }) as unknown as Device

describe('drumColor', () => {
  it('is the palette, keyed by note', () => {
    expect(drumColor(36)).toBe(FILTER_COLORS[36 % FILTER_COLORS.length])
    expect(drumColor(36 + FILTER_COLORS.length)).toBe(drumColor(36))
    expect(drumColor(36)).not.toBe(drumColor(37))
  })
  it('grid and drawer agree for every drum, whatever the order', () => {
    const kit = [drum('a', 36), drum('b', 38), drum('c', 42), drum('d', 46)]
    const expected = new Map(kit.map((d) => [d.id, drumColor(d.keyLo!)]))
    for (const order of [kit, [...kit].reverse(), kit.slice(1)]) {
      order.forEach((d) => expect(deviceDrumColor(d)).toBe(expected.get(d.id)))
    }
  })
  it('melodic instruments get none', () => {
    const synth = Object.keys(DEVICES).map(Number).find((t) => DEVICES[t].instrument && t !== LOFI_DRUM)!
    expect(deviceDrumColor({ type: synth, keyLo: undefined, keyHi: undefined })).toBeNull()
  })
})
