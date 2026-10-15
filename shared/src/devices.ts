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
/** `hidden` devices are pinned by the document (see `MIX`) and never offered in the fx menus. */
export type DeviceDef = { type: number; name: string; instrument: boolean; hidden?: boolean; params: ParamDef[] }

export const SIMPLE_FILTER = 1
export const FINNWAVE = 2
export const REVERB = 3
export const COMPRESSOR = 4
export const TREMOLO = 5
export const DELAY = 6
export const LOFI_DRUM = 7
export const EQ = 8
/** The track's (or master's) fader and pan: hidden, pinned last in its chain, one per track and one for the master bus. */
export const MIX = 9
export const BORE = 10
/** Body resonator: the EQ's engine device with eight bells (docs/engine-api.md kind 11). */
export const BODY = 11
export const MIX_GAIN = 0
export const MIX_PAN = 1

const EQ_BANDS = [
  { name: 'low', hz: 100 },
  { name: 'bell 1', hz: 500 },
  { name: 'bell 2', hz: 2000 },
  { name: 'high', hz: 8000 },
]
const BODY_BANDS = [275, 400, 460, 540, 700, 1000, 2500, 3200].map((hz, i) => ({ name: `peak ${i + 1}`, hz }))
const eqParams = (bands: { name: string; hz: number }[] = EQ_BANDS, damping = 0.7071): ParamDef[] => [
  ...bands.flatMap((b, i): ParamDef[] => [
    { id: i * 3, name: `${b.name} freq`, min: 20, max: 20000, def: b.hz, scale: 'log', unit: 'hz' },
    { id: i * 3 + 1, name: `${b.name} gain`, min: -24, max: 24, def: 0, scale: 'lin', unit: 'db' },
    { id: i * 3 + 2, name: `${b.name} damping`, min: 0.05, max: 2, def: damping, scale: 'lin' },
  ]),
  { id: bands.length * 3, name: 'output', min: -24, max: 24, def: 0, scale: 'lin', unit: 'db' },
]

export const DEVICES: Record<number, DeviceDef> = {
  [SIMPLE_FILTER]: {
    type: SIMPLE_FILTER, name: 'filter / eq', instrument: false,
    params: [
      { id: 0, name: 'mode', min: 0, max: 7, def: 0, scale: 'lin', options: ['lowpass', 'highpass', 'bandpass', 'notch', 'peak', 'bell', 'low shelf', 'high shelf'] },
      { id: 1, name: 'cutoff', min: 20, max: 20000, def: 1000, scale: 'log', unit: 'hz' },
      { id: 2, name: 'damping', min: 0.05, max: 2, def: 0.7071, scale: 'lin' },
      { id: 3, name: 'gain', min: -24, max: 24, def: 0, scale: 'lin', unit: 'db' },
    ],
  },
  [MIX]: {
    type: MIX, name: 'mix', instrument: false, hidden: true,
    params: [
      { id: MIX_GAIN, name: 'volume', min: 0, max: 2, def: 1, scale: 'lin' }, // linear, as the fader's `posToGain`: 1 is unity, 2 is +6 dB
      { id: MIX_PAN, name: 'pan', min: -1, max: 1, def: 0, scale: 'lin' },
    ],
  },
  [EQ]: { type: EQ, name: 'EQ', instrument: false, params: eqParams() },
  [BODY]: { type: BODY, name: 'body', instrument: false, params: eqParams(BODY_BANDS, 0.1) },
  [REVERB]: {
    type: REVERB, name: 'reverb', instrument: false,
    params: [
      { id: 0, name: 'mix', min: 0, max: 1, def: 0.3, scale: 'lin' },
      { id: 1, name: 'size', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 2, name: 'damping', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 3, name: 'predelay', min: 0, max: 200, def: 0, scale: 'pow', unit: 'ms' },
    ],
  },
  [COMPRESSOR]: {
    type: COMPRESSOR, name: 'compressor', instrument: false,
    params: [
      { id: 0, name: 'threshold', min: -60, max: 0, def: -18, scale: 'lin', unit: 'db' },
      { id: 1, name: 'ratio', min: 1, max: 20, def: 4, scale: 'log', unit: ':1' },
      { id: 2, name: 'attack', min: 0.1, max: 100, def: 10, scale: 'log', unit: 'ms' },
      { id: 3, name: 'release', min: 10, max: 1000, def: 100, scale: 'log', unit: 'ms' },
      { id: 4, name: 'makeup', min: 0, max: 24, def: 0, scale: 'lin', unit: 'db' },
    ],
  },
  [TREMOLO]: {
    type: TREMOLO, name: 'tremolo', instrument: false,
    params: [
      { id: 0, name: 'rate', min: 0.1, max: 20, def: 4, scale: 'log', unit: 'hz' },
      { id: 1, name: 'depth', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 2, name: 'shape', min: 0, max: 2, def: 0, scale: 'lin', options: ['sine', 'triangle', 'square'] },
      { id: 3, name: 'spread', min: 0, max: 1, def: 0, scale: 'lin' },
    ],
  },
  [DELAY]: {
    type: DELAY, name: 'tape delay', instrument: false,
    params: [
      { id: 0, name: 'mix', min: 0, max: 1, def: 0.3, scale: 'lin' },
      { id: 1, name: 'time', min: 10, max: 2000, def: 375, scale: 'log', unit: 'ms' },
      { id: 2, name: 'feedback', min: 0, max: 1.2, def: 0.4, scale: 'lin' },
      { id: 3, name: 'warble', min: 0, max: 1, def: 0.25, scale: 'lin' },
      { id: 4, name: 'drive', min: 0, max: 1, def: 0, scale: 'lin' },
      { id: 5, name: 'filter', min: 0, max: 2, def: 0, scale: 'lin', options: ['lowpass', 'highpass', 'bandpass'] },
      { id: 6, name: 'cutoff', min: 100, max: 20000, def: 4000, scale: 'log', unit: 'hz' },
      { id: 7, name: 'resonance', min: 0, max: 1, def: 0, scale: 'lin' },
    ],
  },
  [LOFI_DRUM]: {
    type: LOFI_DRUM, name: 'lofi drum', instrument: true,
    params: [
      { id: 0, name: 'cutoff', min: 20, max: 20000, def: 2000, scale: 'log', unit: 'hz' },
      { id: 1, name: 'resonance', min: 0, max: 1, def: 0.3, scale: 'lin' },
      { id: 2, name: 'decay', min: 1, max: 2000, def: 60, scale: 'pow', unit: 'ms' },
      { id: 3, name: 'gain', min: 0, max: 2, def: 0.5, scale: 'lin' },
    ],
  },
  [BORE]: {
    type: BORE, name: 'bore', instrument: true,
    params: [
      { id: 0, name: 'character', min: 0, max: 1, def: 0, scale: 'lin' }, // 0 reed, 0.5 jet (flute), 1 bow
      { id: 1, name: 'stiffness', min: 0, max: 1, def: 0.5, scale: 'lin' },
      { id: 2, name: 'aperture', min: 0, max: 1, def: 0.5, scale: 'lin' }, // reed opening / bow force, normalised
      { id: 3, name: 'position', min: 0, max: 1, def: 0.3, scale: 'lin' }, // where along the bore the valve sits (read at note start)
      { id: 4, name: 'bore', min: 0, max: 1, def: 1, scale: 'lin', options: ['closed', 'open'] }, // closed: odd harmonics
      { id: 5, name: 'damping', min: 0, max: 1, def: 0.3, scale: 'lin' },
      { id: 6, name: 'decay', min: 0, max: 1, def: 0.7, scale: 'lin' }, // ring after release
      { id: 7, name: 'breath', min: 0, max: 1, def: 0.5, scale: 'lin' }, // breath pressure / bow speed, normalised
      { id: 8, name: 'noise', min: 0, max: 1, def: 0, scale: 'lin' },
      { id: 9, name: 'vibrato rate', min: 0.1, max: 12, def: 5, scale: 'log', unit: 'hz' },
      { id: 10, name: 'vibrato depth', min: 0, max: 1, def: 0, scale: 'lin' },
      { id: 11, name: 'attack', min: 0, max: 2000, def: 30, scale: 'pow', unit: 'ms' },
      { id: 12, name: 'release', min: 1, max: 5000, def: 120, scale: 'pow', unit: 'ms' },
      { id: 13, name: 'gain', min: 0, max: 2, def: 1, scale: 'lin' },
      { id: 14, name: 'vibrato pitch', min: 0, max: 1, def: 0, scale: 'lin' }, // pitch wobble (strings, voice), 60 cents peak at 1; 'vibrato depth' is breath
      { id: 15, name: 'vibrato delay', min: 0, max: 3000, def: 0, scale: 'pow', unit: 'ms' }, // vibrato fades in over this long (read at note start)
      { id: 16, name: 'bell', min: 0, max: 1, def: 0, scale: 'lin' }, // even harmonics above ~1.2 kHz (a clarinet's upper register colour)
      { id: 17, name: 'valve noise', min: 0, max: 1, def: 0, scale: 'lin' }, // jitter in the reed / bow itself: pulsed noise, bow scratch
      { id: 18, name: 'air', min: 0, max: 1, def: 0, scale: 'lin' }, // radiated breath noise above ~2.5 kHz, pulsing with the tone
      { id: 19, name: 'wander', min: 0, max: 1, def: 0, scale: 'lin' }, // slow random drift of breath / bow pressure
    ],
  },
  [FINNWAVE]: {
    type: FINNWAVE, name: 'finnwave', instrument: true,
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

/** Effects offered by the fx bar's "+". */
export const EFFECTS = Object.values(DEVICES).filter((d) => !d.instrument && !d.hidden)
/** Instruments offered by the synths lane's "+". */
export const INSTRUMENTS = Object.values(DEVICES).filter((d) => d.instrument)

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
