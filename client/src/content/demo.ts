// The demo song: "Window seat", a short chillhop piece made only from the engine's synths (no audio files).
//
// F major, 88 bpm, 4/4, 32 bars (about 1:27):
//   bars  1-4   intro   the pad alone, its low-pass opening up; a rim and soft hats come in, a snare pickup
//   bars  5-12  A       drums, bass and electric piano: Bbmaj9 | Am11 | Gm9 | C13, twice
//   bars 13-20  A'      the same with the melody on a soft flute through a tape echo; a tom fill into B
//   bars 21-28  B       Dm9 | Bbmaj9 | Gm9 | A7b9, twice: busier comping, clap on the backbeat, a new melody; a snare roll
//   bars 29-32  outro   A's chords once more, resolving to Fmaj9; the drums thin out and the master reverb opens up
// The loop region (off) covers A and A', bars 5-20. The piano's voicings move by step from chord to chord.
import type * as Y from 'yjs'
import { DELAY, REVERB, SIMPLE_FILTER, TREMOLO, COMPRESSOR, addDevice, addDrum, setLoop } from '@mobdaw/shared'
import { MASTER_TRACK, automate, barPos, clip, initProject, rng, track, type ClipWriter, type Song } from './compose'
import { GM, addDrumKit, addEffectPreset, addInstrument, drumKit, effectPreset, instrumentPreset } from './presets'

export const DEMO_NAME = 'Window seat'
export const DEMO_BPM = 88
export const DEMO_BARS = 32

type Chord = { name: string; root: number; fifth: number; keys: number[] }
const C: Record<string, Chord> = {
  Bbmaj9: { name: 'Bbmaj9', root: 34, fifth: 41, keys: [53, 57, 60, 62] }, // F3 A3 C4 D4
  Am11: { name: 'Am11', root: 33, fifth: 40, keys: [52, 55, 60, 62] }, //     E3 G3 C4 D4
  Gm9: { name: 'Gm9', root: 31, fifth: 38, keys: [50, 53, 57, 58] }, //       D3 F3 A3 Bb3
  C13: { name: 'C13', root: 36, fifth: 43, keys: [52, 57, 58, 62] }, //       E3 A3 Bb3 D4
  Dm9: { name: 'Dm9', root: 38, fifth: 45, keys: [53, 57, 60, 64] }, //       F3 A3 C4 E4
  A7b9: { name: 'A7b9', root: 33, fifth: 40, keys: [52, 55, 58, 61] }, //     E3 G3 Bb3 C#4
  Fmaj9: { name: 'Fmaj9', root: 41, fifth: 48, keys: [52, 55, 57, 60] }, //   E3 G3 A3 C4
}
const A = [C.Bbmaj9, C.Am11, C.Gm9, C.C13]
const B = [C.Dm9, C.Bbmaj9, C.Gm9, C.A7b9]

/** Chord per bar, bars 0..31 (the outro's third bar splits Gm9 / C13, handled where it matters). */
const chordAt = (bar: number): Chord => {
  if (bar < 20) return A[bar % 4]
  if (bar < 28) return B[bar % 4]
  return [C.Bbmaj9, C.Am11, C.Gm9, C.Fmaj9][bar - 28]
}

/** 16th-note swing: the off 16ths land this many ticks late (about 57%). */
const SWING = 55
const step = (i: number) => (i * 240 + (i % 2 ? SWING : 0)) / 960

export function buildDemo(doc: Y.Doc) {
  doc.transact(() => {
    const s = initProject(doc, DEMO_BPM)
    const r = rng(20261012)
    const human = (v: number, amt = 0.12) => v * (1 + (r() - 0.5) * amt)
    const nudge = (beat: number, ticks = 10) => Math.max(0, beat + ((r() - 0.5) * 2 * ticks) / 960)

    // --- tracks (top to bottom), colours from TRACK_COLORS
    const drums = track(s, 'drums', 'midi', { color: 4, gain: 1 })
    const bass = track(s, 'bass', 'midi', { color: 2, gain: 0.65 })
    const keys = track(s, 'rhodes', 'midi', { color: 0, gain: 0.6, pan: -0.1 })
    const pad = track(s, 'pad', 'midi', { color: 1, gain: 0.4, pan: 0.1 })
    const lead = track(s, 'flute', 'midi', { color: 3, gain: 0.85, pan: 0.15 })
    const dust = track(s, 'vinyl dust', 'midi', { color: 7, gain: 1 })

    // --- instruments and inserts
    addDrumKit(doc, drums, drumKit('tape')!)
    addDevice(doc, drums, COMPRESSOR, {}, { 0: -20, 1: 3, 2: 0.1, 3: 60, 4: 6 }) // drum bus: shaves the noise peaks, lifts the kick
    addInstrument(doc, bass, instrumentPreset('round-bass')!)
    addInstrument(doc, keys, instrumentPreset('electric-piano')!)
    addDevice(doc, keys, TREMOLO, {}, { 0: 4.2, 1: 0.22, 2: 0, 3: 0.7 }) // the Rhodes' auto-pan
    addInstrument(doc, pad, instrumentPreset('warm-pad')!)
    const padFilter = addDevice(doc, pad, SIMPLE_FILTER, {}, { 0: 0, 1: 3500, 2: 0.6 })
    addInstrument(doc, lead, instrumentPreset('flute-lead')!)
    addDevice(doc, lead, DELAY, {}, { 0: 0.25, 1: Math.round((0.75 * 60000) / DEMO_BPM), 2: 0.38, 3: 0.3, 4: 0.2, 5: 0, 6: 2600, 7: 0 })
    addDevice(doc, lead, REVERB, {}, { 0: 0.22, 1: 0.6, 2: 0.5, 3: 20 })
    addDrum(doc, dust, { key: 60, name: 'crackle', params: { 0: 4500, 1: 0.1, 2: 3, 3: 0.6 } })
    // master: glue compression, then a little room
    addEffectPreset(doc, MASTER_TRACK, { id: 'demo-master', name: 'demo master', devices: [{ type: COMPRESSOR, params: { 0: -18, 1: 2.5, 2: 25, 3: 180, 4: 2 } }] })
    const masterVerb = addEffectPreset(doc, MASTER_TRACK, effectPreset('small-room')!)[0]

    // --- automation: the pad's low-pass opens over the intro; the room grows over the outro
    automate(s, pad, 'effect', padFilter, SIMPLE_FILTER, 1, [[0, 260], [4, 3500]])
    automate(s, MASTER_TRACK, 'effect', masterVerb, REVERB, 0, [[0, 0.18], [28, 0.18], [32, 0.4]])

    writeDrums(s, drums, human, nudge)
    writeBass(s, bass, human, nudge)
    writeKeys(s, keys, pad, human)
    writeLead(s, lead, human, nudge)
    writeDust(s, dust, r)

    setLoop(doc, { start: barPos(s, 4), end: barPos(s, 20), on: false })
  })
}

type Human = (v: number, amt?: number) => number
type Nudge = (beat: number, ticks?: number) => number

function writeDrums(s: Song, t: string, human: Human, nudge: Nudge) {
  const K = GM.kick, S = GM.snare, H = GM.closedHat, O = GM.openHat, R = GM.rim, CL = GM.clap, LT = GM.lowTom, MT = GM.midTom
  /** One bar of hits: [16th step, key, velocity]. */
  type Hit = [number, number, number]
  const play = (c: ClipWriter, bar: number, hits: Hit[]) => {
    for (const [i, key, v] of hits) {
      const loose = key === K ? 0 : key === S || key === CL ? 6 : 12 // the kick sits on the grid, hats drift most
      c.note(nudge(bar * 4 + step(i), loose), key, 0.25, human(v))
    }
  }
  const hats = (from = 0, to = 16, down = 0.5, up = 0.3): Hit[] => {
    const out: Hit[] = []
    for (let i = from; i < to; i += 2) out.push([i, H, i % 4 === 0 ? down : up])
    return out
  }
  const grooveA = (n: number): Hit[] => {
    const base: Hit[] = n % 2 === 0
      ? [[0, K, 0.95], [10, K, 0.8], [4, S, 0.85], [12, S, 0.9], [7, S, 0.16]]
      : [[0, K, 0.95], [7, K, 0.55], [10, K, 0.8], [4, S, 0.85], [12, S, 0.9], [15, S, 0.14]]
    const hh = hats()
    if (n % 4 === 3) { hh.pop(); base.push([14, O, 0.4]) } // open hat into the next phrase
    if (n % 2 === 1) hh.push([15, H, 0.18])
    return [...base, ...hh]
  }
  const grooveB = (n: number): Hit[] => [
    [0, K, 0.95], [3, K, 0.45], [10, K, 0.8], ...(n % 2 ? [[13, K, 0.5] as Hit] : []),
    [4, S, 0.85], [12, S, 0.85], [12, CL, 0.6], [11, R, 0.25],
    ...hats(0, 16, 0.5, 0.33), [5, H, 0.15], [13, H, 0.15],
  ]

  // intro: two bars of nothing, then rim and soft hats, and a pickup
  const intro = clip(s, t, { bar: 0, bars: 4, drums: true })
  play(intro, 2, [[4, R, 0.5], [12, R, 0.55], ...hats(0, 16, 0.3, 0.18)])
  play(intro, 3, [[4, R, 0.5], [12, R, 0.55], ...hats(0, 12, 0.32, 0.2), [13, S, 0.3], [14, S, 0.45], [15, S, 0.6]])

  for (const [start, len] of [[4, 8], [12, 8]]) {
    const c = clip(s, t, { bar: start, bars: len, drums: true })
    for (let b = 0; b < len; b++) {
      const n = start + b
      if (n === 19) {
        // tom fill
        play(c, b, [[0, K, 0.95], [4, S, 0.85], [7, S, 0.2], [10, K, 0.8], ...hats(0, 10), [11, S, 0.5], [12, MT, 0.75], [13, MT, 0.65], [14, LT, 0.8], [15, LT, 0.7]])
      } else play(c, b, grooveA(n))
    }
  }
  const cb = clip(s, t, { bar: 20, bars: 8, drums: true })
  for (let b = 0; b < 8; b++) {
    const n = 20 + b
    if (n === 27) {
      // snare roll, crescendo
      play(cb, b, [[0, K, 0.95], [4, S, 0.85], [10, K, 0.8], ...hats(0, 8), [8, S, 0.35], [10, S, 0.45], [12, S, 0.55], [13, S, 0.62], [14, S, 0.72], [15, S, 0.85], [15, O, 0.3]])
    } else play(cb, b, grooveB(n))
  }
  const out = clip(s, t, { bar: 28, bars: 4, drums: true })
  play(out, 0, [[0, K, 0.95], ...grooveA(0).filter(([, k]) => k !== K)])
  play(out, 1, grooveA(3))
  play(out, 2, [[0, K, 0.85], [4, S, 0.6], [10, K, 0.6], ...hats(0, 8, 0.4, 0.22)])
  play(out, 3, [[0, K, 0.7], [0, H, 0.25]])
}

function writeBass(s: Song, t: string, human: Human, nudge: Nudge) {
  const c = clip(s, t, { bar: 4, bars: 28 })
  for (let bar = 4; bar < 32; bar++) {
    const b = (bar - 4) * 4
    const ch = chordAt(bar)
    const next = bar < 31 ? chordAt(bar + 1) : ch
    const approach = next.root + (next.root < ch.root ? 1 : -1)
    const v = (x: number) => human(x, 0.1)
    if (bar === 31) {
      c.note(b, ch.root, 3.5, v(0.85)) // the last note rings
    } else if (bar === 30) {
      // Gm9 then C13 over the outro's third bar
      c.note(b, C.Gm9.root, 1.5, v(0.85))
      c.note(nudge(b + 1.75), C.Gm9.root, 0.2, v(0.5))
      c.note(b + 2, C.C13.root, 1.4, v(0.8))
      c.note(nudge(b + 3.5), C.C13.fifth - 12, 0.4, v(0.55))
    } else if (bar >= 20 && bar < 28) {
      c.note(b, ch.root, 1.4, v(0.88))
      c.note(nudge(b + 1.5 + SWING / 960), ch.root + 12, 0.35, v(0.55))
      c.note(nudge(b + 2.5), ch.fifth, 0.9, v(0.72))
      c.note(nudge(b + 3.5), approach, 0.45, v(0.6))
    } else {
      c.note(b, ch.root, 1.35, v(0.9))
      c.note(nudge(b + 1.75 + SWING / 960), ch.root, 0.22, v(0.5))
      c.note(nudge(b + 2.5), ch.fifth, 0.8, v(0.72))
      c.note(nudge(b + 3.5), approach, 0.42, v(0.58))
    }
  }
}

function writeKeys(s: Song, keys: string, pad: string, human: Human) {
  // the pad: the piano's voicing an octave up, a bar per chord, from the very start
  const p = clip(s, pad, { bar: 0, bars: 32 })
  for (let bar = 0; bar < 32; bar++) {
    if (bar === 30) {
      for (const n of C.Gm9.keys) p.note(bar * 4, n + 12, 1.9, human(0.6, 0.06))
      for (const n of C.C13.keys) p.note(bar * 4 + 2, n + 12, 1.9, human(0.6, 0.06))
      continue
    }
    const len = bar === 31 ? 4 : 3.92
    for (const n of chordAt(bar).keys) p.note(bar * 4, n + 12, len, human(0.62, 0.06))
  }

  // the piano: comping from bar 5, rolled a little (lowest note first)
  const c = clip(s, keys, { bar: 4, bars: 28 })
  const roll = (beat: number, notes: number[], dur: number, vel: number, spread = 14) =>
    notes.forEach((n, i) => c.note(beat + (i * spread) / 960, n, dur, human(vel - i * 0.03)))
  for (let bar = 4; bar < 32; bar++) {
    const b = (bar - 4) * 4
    const ch = chordAt(bar)
    if (bar === 31) roll(b, ch.keys, 4, 0.72, 45)
    else if (bar === 30) {
      roll(b, C.Gm9.keys, 1.4, 0.66)
      roll(b + 2, C.C13.keys, 1.8, 0.62)
    } else if (bar >= 20 && bar < 28) {
      roll(b, ch.keys, 0.9, 0.68)
      roll(b + 1.5 + SWING / 960, ch.keys, 0.4, 0.5, 8)
      roll(b + 2.5, ch.keys, 1.3, 0.6)
    } else {
      roll(b, ch.keys, 1.5, 0.68)
      roll(b + 2.5, ch.keys, 1.25, 0.56)
      if (bar % 4 === 3) c.note(b + 3.75, ch.keys[3] + 12, 0.25, human(0.4)) // a grace note at the turnaround
    }
  }
}

/** Melody phrases: per bar, [beat, pitch, beats]. */
type Phrase = [number, number, number][][]
const A1: Phrase = [
  [[1, 69, 0.5], [1.5, 72, 0.5], [2, 74, 1.5], [3.5, 72, 0.5]],
  [[0, 76, 1], [1, 74, 0.5], [1.5, 72, 1.5], [3.5, 69, 0.5]],
  [[0, 74, 1.5], [1.5, 77, 0.5], [2, 74, 1], [3, 72, 1]],
  [[0, 69, 2], [2.5, 67, 0.5], [3, 69, 0.5], [3.5, 72, 0.5]],
]
const A2: Phrase = [
  [[0, 74, 1], [1, 77, 0.5], [1.5, 76, 0.5], [2, 74, 1], [3, 72, 0.5], [3.5, 69, 0.5]],
  [[0, 72, 1.5], [1.5, 76, 0.5], [2, 79, 1], [3, 76, 1]],
  [[0, 77, 1], [1, 74, 0.5], [1.5, 70, 0.5], [2, 72, 1], [3, 74, 1]],
  [[0, 76, 3]],
]
const B1: Phrase = [
  [[0, 69, 1], [1, 72, 0.5], [1.5, 74, 1], [2.5, 76, 1.5]],
  [[0, 77, 1.5], [1.5, 76, 0.5], [2, 74, 2]],
  [[0, 70, 0.5], [0.5, 74, 0.5], [1, 77, 1], [2, 76, 0.5], [2.5, 74, 1.5]],
  [[0, 73, 1.5], [1.5, 76, 0.5], [2, 67, 1], [3, 69, 1]],
]
const B2: Phrase = [
  [[0, 81, 1], [1, 77, 0.5], [1.5, 76, 0.5], [2, 74, 1], [3, 72, 1]],
  [[0, 74, 1.5], [1.5, 77, 0.5], [2, 81, 2]],
  [[0, 79, 1], [1, 77, 0.5], [1.5, 74, 0.5], [2, 70, 1], [3, 74, 1]],
  [[0, 73, 1], [1, 76, 1], [2, 79, 1], [3, 76, 1]],
]
const OUTRO: Phrase = [
  [[0, 74, 1], [1, 72, 1], [2, 69, 2]],
  [[0, 72, 1], [1, 67, 3]],
  [[0, 70, 1.5], [2, 70, 0.5], [2.5, 69, 1.5]],
  [[0, 69, 4]],
]

function writeLead(s: Song, t: string, human: Human, nudge: Nudge) {
  const parts: [number, Phrase[]][] = [[12, [A1, A2]], [20, [B1, B2]], [28, [OUTRO]]]
  for (const [start, phrases] of parts) {
    const c = clip(s, t, { bar: start, bars: phrases.length * 4 })
    phrases.forEach((ph, k) =>
      ph.forEach((bar, j) =>
        bar.forEach(([beat, pitch, dur]) => {
          const on = beat === 0 ? 0.75 : beat % 1 === 0 ? 0.68 : 0.6 // a lift on the downbeats
          c.note(nudge((k * 4 + j) * 4 + beat + (beat % 1 === 0.5 ? SWING / 960 / 2 : 0), 8), pitch, dur * 0.95, human(on, 0.1))
        })))
  }
}

function writeDust(s: Song, t: string, r: () => number) {
  const c = clip(s, t, { bar: 0, bars: 32, drums: true })
  for (let bar = 0; bar < 32; bar++) {
    const hits = 2 + Math.floor(r() * 4)
    for (let i = 0; i < hits; i++) c.note(bar * 4 + r() * 4, 60, 0.1, 0.1 + r() * 0.45)
  }
}
