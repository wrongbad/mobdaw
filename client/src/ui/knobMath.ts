// Pure maths for the rotary knob: position (0..1) <-> sweep angle, the bipolar origin, and unit-aware value text.
import type { ParamDef } from '@mobdaw/shared'

export const KNOB_ARC = 135 // degrees either side of 12 o'clock
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** Sweep angle (degrees from 12 o'clock, -135..135) for a 0..1 position. */
export const posToAngle = (pos: number) => clamp(pos, 0, 1) * 2 * KNOB_ARC - KNOB_ARC
export const angleToPos = (deg: number) => (clamp(deg, -KNOB_ARC, KNOB_ARC) + KNOB_ARC) / (2 * KNOB_ARC)

/** A param whose range straddles 0 (pan, EQ gain) draws its arc from the centre value instead of from the minimum. */
export const isBipolar = (p: Pick<ParamDef, 'min' | 'max' | 'scale'>) => p.min < 0 && p.max > 0 && p.scale === 'lin'

const sig = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2))

/** The value as shown on a knob readout: dB, Hz / kHz, ms / s, ratio, or a percentage for plain 0..1 params. */
export function formatParam(p: Pick<ParamDef, 'min' | 'max' | 'unit'>, v: number): string {
  switch (p.unit) {
    case 'db': return `${v > 0.05 && p.min < 0 ? '+' : ''}${v.toFixed(1)} dB`
    case 'hz': return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${sig(v)} Hz`
    case 'ms': return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ms`
    case ':1': return `${sig(v)}:1`
    case undefined: case '':
      if (p.min === 0 && p.max <= 1) return `${Math.round(v * 100)}%`
      if (p.min === -1 && p.max === 1) return Math.abs(v) < 0.005 ? 'C' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`
      return sig(v)
    default: return `${sig(v)} ${p.unit}`
  }
}
