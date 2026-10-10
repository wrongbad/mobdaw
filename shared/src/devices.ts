// Device catalogue shared by the UI. Ids and ranges must match docs/engine-api.md.
export type ParamDef = {
  id: number
  name: string
  min: number
  max: number
  def: number
  /** How a 0..1 slider maps to the value: linear, logarithmic (min > 0) or cubic (fine control near min). */
  scale: 'lin' | 'log' | 'pow'
  unit?: string
  /** Discrete choices (value = index); rendered as a select. */
  options?: string[]
}
export type DeviceDef = { type: number; name: string; instrument: boolean; params: ParamDef[] }

export const SIMPLE_FILTER = 1
export const FINNWAVE = 2
export const REVERB = 3
export const COMPRESSOR = 4
export const TREMOLO = 5

export const DEVICES: Record<number, DeviceDef> = {
  [SIMPLE_FILTER]: {
    type: SIMPLE_FILTER, name: 'Simple filter', instrument: false,
    params: [
      { id: 0, name: 'mode', min: 0, max: 4, def: 0, scale: 'lin', options: ['LP', 'HP', 'BP', 'Notch', 'Peak'] },
      { id: 1, name: 'cutoff', min: 20, max: 20000, def: 1000, scale: 'log', unit: 'Hz' },
      { id: 2, name: 'damping', min: 0.05, max: 2, def: 0.7071, scale: 'lin' },
    ],
  },
  [REVERB]: {
    type: REVERB, name: 'Reverb', instrument: false,
    params: [
      { id: 0, name: 'mix', min: 0, max: 1, def: 0.3, scale: 'lin' },
      { id: 1, name: 'size', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 2, name: 'damping', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 3, name: 'predelay', min: 0, max: 200, def: 0, scale: 'pow', unit: 'ms' },
    ],
  },
  [COMPRESSOR]: {
    type: COMPRESSOR, name: 'Compressor', instrument: false,
    params: [
      { id: 0, name: 'threshold', min: -60, max: 0, def: -18, scale: 'lin', unit: 'dB' },
      { id: 1, name: 'ratio', min: 1, max: 20, def: 4, scale: 'log', unit: ':1' },
      { id: 2, name: 'attack', min: 0.1, max: 100, def: 10, scale: 'log', unit: 'ms' },
      { id: 3, name: 'release', min: 10, max: 1000, def: 100, scale: 'log', unit: 'ms' },
      { id: 4, name: 'makeup', min: 0, max: 24, def: 0, scale: 'lin', unit: 'dB' },
    ],
  },
  [TREMOLO]: {
    type: TREMOLO, name: 'Tremolo', instrument: false,
    params: [
      { id: 0, name: 'rate', min: 0.1, max: 20, def: 4, scale: 'log', unit: 'Hz' },
      { id: 1, name: 'depth', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 2, name: 'shape', min: 0, max: 2, def: 0, scale: 'lin', options: ['Sine', 'Triangle', 'Square'] },
      { id: 3, name: 'spread', min: 0, max: 1, def: 0, scale: 'lin' },
    ],
  },
  [FINNWAVE]: {
    type: FINNWAVE, name: 'Finnwave', instrument: true,
    params: [
      { id: 0, name: 'rolloff', min: 0.001, max: 3, def: 0.3, scale: 'log' },
      { id: 1, name: 'env→rolloff', min: 0, max: 3, def: 0.5, scale: 'lin' },
      { id: 2, name: 'attack', min: 0, max: 5000, def: 5, scale: 'pow', unit: 'ms' },
      { id: 3, name: 'decay', min: 0, max: 5000, def: 300, scale: 'pow', unit: 'ms' },
      { id: 4, name: 'sustain', min: 0, max: 1, def: 0.6, scale: 'lin' },
      { id: 5, name: 'release', min: 0, max: 10000, def: 200, scale: 'pow', unit: 'ms' },
      { id: 6, name: 'gain', min: 0, max: 2, def: 0.5, scale: 'lin' },
    ],
  },
}

/** Effects offered by the "+" dialog (instruments are inserted with their track). */
export const EFFECTS = Object.values(DEVICES).filter((d) => !d.instrument)

export function paramToValue(p: ParamDef, t: number): number {
  if (p.options) return Math.round(p.min + t * (p.max - p.min))
  if (p.scale === 'log') return p.min * (p.max / p.min) ** t
  if (p.scale === 'pow') return p.min + (p.max - p.min) * t ** 3
  return p.min + t * (p.max - p.min)
}
export function paramToPos(p: ParamDef, v: number): number {
  const c = Math.min(p.max, Math.max(p.min, v))
  if (p.scale === 'log') return Math.log(c / p.min) / Math.log(p.max / p.min)
  if (p.scale === 'pow') return Math.cbrt((c - p.min) / (p.max - p.min))
  return (c - p.min) / (p.max - p.min)
}
