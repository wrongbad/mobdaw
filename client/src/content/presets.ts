// Built-in sounds: finnwave patches, lofi drum kits and effect chains, plus helpers that put them on a track.
//
// How the params were chosen (engine/crates/dsp/src/finnwave.rs, lofidrum.rs):
// - finnwave's `rolloff` b sets harmonic k to e^(-kb): ~0.05 is a buzzy, saw-like spectrum, ~0.3 a bright reed, ~1 a soft
//   flute-like tone, 3 nearly a sine. `env→rolloff` adds `amount·(1 − env)` to b, so a note is brightest at the envelope's
//   peak and darkens as it decays (a plucked string or an electric piano), and a slow attack opens up as it swells (brass,
//   pads). Loudness stays within ~2× across rolloffs, except near-sines, which get a little more gain.
// - the lofi drum is white noise through a resonant low-pass under an exponential decay. With high resonance the filter
//   rings at its cutoff, so a low cutoff gives a pitched thump (kick, toms), a mid cutoff a woodblock (rim), and a high
//   cutoff with no resonance a burst of hiss (hats, snare, clap). Narrow, low filters pass less of the noise, so they need
//   more gain.
import type * as Y from 'yjs'
import {
  COMPRESSOR, DELAY, DEVICES, EQ, FINNWAVE, LOFI_DRUM, REVERB, SIMPLE_FILTER, TREMOLO,
  addDevice, addDrum, deleteDevice, devicesMap, getDevices, isDrum, setParam, updateDevice,
} from '@mobdaw/shared'

export type InstrumentCategory = 'keys' | 'bass' | 'lead' | 'pad' | 'pluck' | 'fx'
export type InstrumentPreset = { id: string; name: string; type: number; params: Record<string, number>; category: InstrumentCategory }
export type Drum = { name: string; key: number; params: Record<string, number> }
export type DrumKit = { id: string; name: string; drums: Drum[] }
export type EffectPreset = { id: string; name: string; devices: { type: number; params: Record<string, number> }[] }

/** finnwave params by name, so the table below reads; turned into the engine's ids by `fw`. */
type Fw = { rolloff: number; env: number; attack: number; decay: number; sustain: number; release: number; gain: number }
const fw = (p: Fw): Record<string, number> => ({ 0: p.rolloff, 1: p.env, 2: p.attack, 3: p.decay, 4: p.sustain, 5: p.release, 6: p.gain })
const inst = (id: string, name: string, category: InstrumentCategory, p: Fw): InstrumentPreset => ({ id, name, type: FINNWAVE, category, params: fw(p) })

export const INSTRUMENT_PRESETS: InstrumentPreset[] = [
  // keys
  inst('soft-keys', 'Soft keys', 'keys', { rolloff: 0.6, env: 1.6, attack: 3, decay: 1100, sustain: 0.22, release: 450, gain: 0.5 }),
  inst('electric-piano', 'Electric piano', 'keys', { rolloff: 0.9, env: 1.1, attack: 2, decay: 1800, sustain: 0.12, release: 380, gain: 0.55 }),
  inst('organ', 'Organ', 'keys', { rolloff: 0.7, env: 0, attack: 6, decay: 50, sustain: 1, release: 60, gain: 0.4 }),
  // bass
  inst('round-bass', 'Round bass', 'bass', { rolloff: 1.1, env: 1.0, attack: 3, decay: 450, sustain: 0.55, release: 110, gain: 0.85 }),
  inst('sub-bass', 'Sub bass', 'bass', { rolloff: 3, env: 0, attack: 6, decay: 200, sustain: 1, release: 140, gain: 1.4 }),
  inst('finger-bass', 'Finger bass', 'bass', { rolloff: 0.45, env: 2.2, attack: 1, decay: 260, sustain: 0.35, release: 80, gain: 0.7 }),
  // lead
  inst('reed-lead', 'Reed lead', 'lead', { rolloff: 0.22, env: 0.4, attack: 10, decay: 300, sustain: 0.75, release: 180, gain: 0.4 }),
  inst('flute-lead', 'Soft flute', 'lead', { rolloff: 1.4, env: 0.6, attack: 45, decay: 400, sustain: 0.8, release: 220, gain: 0.6 }),
  inst('brass', 'Brassy swell', 'lead', { rolloff: 0.18, env: 2.4, attack: 90, decay: 500, sustain: 0.7, release: 220, gain: 0.4 }),
  // pad
  inst('warm-pad', 'Warm pad', 'pad', { rolloff: 0.55, env: 1.4, attack: 900, decay: 2200, sustain: 0.8, release: 2500, gain: 0.35 }),
  inst('strings', 'String section', 'pad', { rolloff: 0.12, env: 0.9, attack: 380, decay: 900, sustain: 0.85, release: 1000, gain: 0.28 }),
  inst('glass-pad', 'Glass pad', 'pad', { rolloff: 1.8, env: 0.3, attack: 1500, decay: 3000, sustain: 0.9, release: 4000, gain: 0.55 }),
  // pluck
  inst('pluck', 'Bright pluck', 'pluck', { rolloff: 0.08, env: 2.6, attack: 0, decay: 240, sustain: 0, release: 240, gain: 0.55 }),
  inst('music-box', 'Music box', 'pluck', { rolloff: 1.6, env: 0.5, attack: 0, decay: 2400, sustain: 0, release: 2400, gain: 0.7 }),
  inst('kalimba', 'Kalimba', 'pluck', { rolloff: 0.9, env: 2.0, attack: 0, decay: 700, sustain: 0, release: 700, gain: 0.6 }),
  // fx
  inst('buzz-riser', 'Buzz riser', 'fx', { rolloff: 0.02, env: 3, attack: 4000, decay: 0, sustain: 1, release: 3000, gain: 0.3 }),
  inst('drone', 'Dark drone', 'fx', { rolloff: 2.4, env: 0.4, attack: 2500, decay: 5000, sustain: 1, release: 6000, gain: 0.9 }),
]

/** lofi drum params by name. */
type Ld = { cutoff: number; res: number; decay: number; gain: number }
const ld = (p: Ld): Record<string, number> => ({ 0: p.cutoff, 1: p.res, 2: p.decay, 3: p.gain })
const drum = (name: string, key: number, p: Ld): Drum => ({ name, key, params: ld(p) })

/** General MIDI drum keys the kits use. */
export const GM = { kick: 36, rim: 37, snare: 38, clap: 39, lowTom: 45, closedHat: 42, openHat: 46, midTom: 47, shaker: 70 } as const

export const DRUM_KITS: DrumKit[] = [
  {
    id: 'tape', name: 'Tape kit', drums: [
      drum('kick', GM.kick, { cutoff: 58, res: 1, decay: 380, gain: 2 }),
      drum('rim', GM.rim, { cutoff: 1700, res: 0.96, decay: 45, gain: 0.7 }),
      drum('snare', GM.snare, { cutoff: 4200, res: 0.25, decay: 170, gain: 1.2 }),
      drum('clap', GM.clap, { cutoff: 1900, res: 0.35, decay: 120, gain: 1 }),
      drum('closed hat', GM.closedHat, { cutoff: 11000, res: 0.1, decay: 38, gain: 0.5 }),
      drum('low tom', GM.lowTom, { cutoff: 105, res: 0.9, decay: 380, gain: 1.1 }),
      drum('open hat', GM.openHat, { cutoff: 9500, res: 0.15, decay: 320, gain: 0.3 }),
      drum('mid tom', GM.midTom, { cutoff: 150, res: 0.9, decay: 320, gain: 0.9 }),
    ],
  },
  {
    id: '808ish', name: '808ish', drums: [
      drum('kick', GM.kick, { cutoff: 48, res: 1, decay: 950, gain: 2 }),
      drum('rim', GM.rim, { cutoff: 2400, res: 0.98, decay: 30, gain: 0.7 }),
      drum('snare', GM.snare, { cutoff: 6500, res: 0.2, decay: 140, gain: 1 }),
      drum('clap', GM.clap, { cutoff: 2300, res: 0.3, decay: 160, gain: 0.85 }),
      drum('closed hat', GM.closedHat, { cutoff: 16000, res: 0.05, decay: 28, gain: 0.5 }),
      drum('low tom', GM.lowTom, { cutoff: 90, res: 0.97, decay: 600, gain: 0.9 }),
      drum('open hat', GM.openHat, { cutoff: 15000, res: 0.05, decay: 420, gain: 0.22 }),
      drum('mid tom', GM.midTom, { cutoff: 130, res: 0.97, decay: 520, gain: 0.75 }),
    ],
  },
  {
    id: 'dusty', name: 'Dusty', drums: [
      drum('kick', GM.kick, { cutoff: 70, res: 0.97, decay: 280, gain: 2 }),
      drum('rim', GM.rim, { cutoff: 1200, res: 0.92, decay: 55, gain: 0.6 }),
      drum('snare', GM.snare, { cutoff: 2600, res: 0.35, decay: 210, gain: 1.1 }),
      drum('clap', GM.clap, { cutoff: 1500, res: 0.4, decay: 140, gain: 0.9 }),
      drum('closed hat', GM.closedHat, { cutoff: 6500, res: 0.2, decay: 45, gain: 0.4 }),
      drum('low tom', GM.lowTom, { cutoff: 120, res: 0.85, decay: 300, gain: 1 }),
      drum('open hat', GM.openHat, { cutoff: 6000, res: 0.2, decay: 260, gain: 0.3 }),
      drum('mid tom', GM.midTom, { cutoff: 170, res: 0.85, decay: 260, gain: 0.9 }),
      drum('shaker', GM.shaker, { cutoff: 8000, res: 0, decay: 70, gain: 0.25 }),
    ],
  },
  {
    id: 'minimal', name: 'Minimal click', drums: [
      drum('kick', GM.kick, { cutoff: 90, res: 0.8, decay: 110, gain: 2 }),
      drum('rim', GM.rim, { cutoff: 3200, res: 1, decay: 20, gain: 0.8 }),
      drum('snare', GM.snare, { cutoff: 5000, res: 0.6, decay: 60, gain: 0.7 }),
      drum('clap', GM.clap, { cutoff: 2800, res: 0.5, decay: 50, gain: 0.7 }),
      drum('closed hat', GM.closedHat, { cutoff: 18000, res: 0.4, decay: 14, gain: 0.7 }),
      drum('low tom', GM.lowTom, { cutoff: 180, res: 1, decay: 120, gain: 0.9 }),
      drum('open hat', GM.openHat, { cutoff: 17000, res: 0.3, decay: 110, gain: 0.25 }),
      drum('mid tom', GM.midTom, { cutoff: 260, res: 1, decay: 100, gain: 1 }),
    ],
  },
]

// effect params by name
const filter = (mode: number, cutoff: number, damping = 0.7071, gain = 0) => ({ type: SIMPLE_FILTER, params: { 0: mode, 1: cutoff, 2: damping, 3: gain } })
const eq = (bands: [number, number][], output = 0) => {
  const params: Record<string, number> = { 12: output }
  bands.forEach(([hz, db], i) => Object.assign(params, { [i * 3]: hz, [i * 3 + 1]: db, [i * 3 + 2]: 0.7071 }))
  return { type: EQ, params }
}
const reverb = (mix: number, size: number, damping: number, predelay = 0) => ({ type: REVERB, params: { 0: mix, 1: size, 2: damping, 3: predelay } })
const comp = (threshold: number, ratio: number, attack: number, release: number, makeup: number) =>
  ({ type: COMPRESSOR, params: { 0: threshold, 1: ratio, 2: attack, 3: release, 4: makeup } })
const tremolo = (rate: number, depth: number, shape: number, spread: number) => ({ type: TREMOLO, params: { 0: rate, 1: depth, 2: shape, 3: spread } })
type Dl = { mix: number; time: number; feedback: number; warble: number; drive: number; filter: number; cutoff: number; resonance: number }
const delay = (p: Dl) => ({ type: DELAY, params: { 0: p.mix, 1: p.time, 2: p.feedback, 3: p.warble, 4: p.drive, 5: p.filter, 6: p.cutoff, 7: p.resonance } })

export const EFFECT_PRESETS: EffectPreset[] = [
  { id: 'tape-echo', name: 'Tape echo', devices: [delay({ mix: 0.3, time: 375, feedback: 0.45, warble: 0.35, drive: 0.3, filter: 0, cutoff: 3000, resonance: 0 })] },
  { id: 'dub-echo', name: 'Dub echo', devices: [delay({ mix: 0.35, time: 545, feedback: 0.78, warble: 0.2, drive: 0.5, filter: 2, cutoff: 1200, resonance: 0.3 })] },
  { id: 'big-room', name: 'Big room', devices: [reverb(0.35, 0.86, 0.4, 25)] },
  { id: 'small-room', name: 'Small room', devices: [reverb(0.18, 0.35, 0.6, 5)] },
  {
    id: 'lofi', name: 'Lofi', devices: [
      filter(0, 3800, 0.8),
      comp(-24, 5, 5, 140, 6),
      delay({ mix: 0.12, time: 90, feedback: 0.1, warble: 0.65, drive: 0.4, filter: 0, cutoff: 2500, resonance: 0 }),
    ],
  },
  {
    id: 'vocal-polish', name: 'Vocal polish', devices: [
      eq([[110, -4], [400, -1.5], [3000, 2], [10000, 3]]),
      comp(-20, 3, 8, 120, 4),
      reverb(0.15, 0.45, 0.5, 20),
    ],
  },
  { id: 'wide-tremolo', name: 'Wide tremolo', devices: [tremolo(3, 0.55, 0, 1), reverb(0.15, 0.5, 0.5, 10)] },
  { id: 'radio', name: 'Radio', devices: [filter(1, 450, 0.6), filter(0, 3200, 0.45), comp(-30, 8, 2, 80, 12)] },
  { id: 'glue', name: 'Bus glue', devices: [comp(-16, 2, 30, 200, 2)] },
  { id: 'warm-up', name: 'Warm up', devices: [eq([[120, 2], [500, 0], [3500, -1.5], [9000, -3]])] },
]

/** Clamp each param of `params` into its device's range (unknown ids are dropped). */
export function clampParams(type: number, params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const def of DEVICES[type]?.params ?? []) {
    const v = params[String(def.id)]
    if (v != null) out[String(def.id)] = Math.min(def.max, Math.max(def.min, v))
  }
  return out
}

/** Set an existing instrument's params (and its label) to a preset. One undo step. */
export function applyInstrumentPreset(doc: Y.Doc, deviceId: string, preset: InstrumentPreset) {
  const type = devicesMap(doc).get(deviceId)?.get('type') as number | undefined
  if (type !== preset.type) return
  doc.transact(() => {
    for (const [id, v] of Object.entries(clampParams(type, preset.params))) setParam(doc, deviceId, Number(id), v)
    updateDevice(doc, deviceId, { name: preset.name })
  })
}

/** Add a preset instrument (full key range) to the end of a MIDI track's chain. Returns the device id. */
export const addInstrument = (doc: Y.Doc, trackId: string, preset: InstrumentPreset): string =>
  addDevice(doc, trackId, preset.type, { name: preset.name }, clampParams(preset.type, preset.params))

/**
 * Add a kit's drums to a MIDI track. A drum whose key the track already has a drum on takes over that drum (new name and
 * params) rather than stacking a second one on the same key. One undo step. Returns the drum ids, in the kit's order.
 */
export function addDrumKit(doc: Y.Doc, trackId: string, kit: DrumKit): string[] {
  const ids: string[] = []
  doc.transact(() => {
    const byKey = new Map(getDevices(doc).filter((d) => d.trackId === trackId && isDrum(d)).map((d) => [d.keyLo, d.id]))
    for (const d of kit.drums) {
      const params = clampParams(LOFI_DRUM, d.params)
      const have = byKey.get(d.key)
      if (have && devicesMap(doc).get(have)?.get('type') === LOFI_DRUM) {
        for (const [id, v] of Object.entries(params)) setParam(doc, have, Number(id), v)
        updateDevice(doc, have, { name: d.name })
        ids.push(have)
      } else {
        const id = addDrum(doc, trackId, { key: d.key, name: d.name, params })
        byKey.set(d.key, id)
        ids.push(id)
      }
    }
  })
  return ids
}

/** Remove every drum (single-key instrument) on the track, then add the kit. One undo step. */
export function replaceDrumKit(doc: Y.Doc, trackId: string, kit: DrumKit): string[] {
  let ids: string[] = []
  doc.transact(() => {
    for (const d of getDevices(doc)) if (d.trackId === trackId && isDrum(d)) deleteDevice(doc, d.id)
    ids = addDrumKit(doc, trackId, kit)
  })
  return ids
}

/** Append a preset's effects, in order, to a track's chain (or the master's: `MASTER_TRACK`). One undo step. Returns the ids. */
export function addEffectPreset(doc: Y.Doc, trackId: string, preset: EffectPreset): string[] {
  const ids: string[] = []
  doc.transact(() => {
    for (const d of preset.devices) ids.push(addDevice(doc, trackId, d.type, {}, clampParams(d.type, d.params)))
  })
  return ids
}

export const instrumentPreset = (id: string) => INSTRUMENT_PRESETS.find((p) => p.id === id)
export const drumKit = (id: string) => DRUM_KITS.find((k) => k.id === id)
export const effectPreset = (id: string) => EFFECT_PRESETS.find((p) => p.id === id)
