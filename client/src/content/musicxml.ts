// MusicXML (.musicxml, .xml, .mxl) importer: a score becomes MIDI tracks (a performed piano roll) and every note keeps how it is written
// as a notation hint (`Note.hint`, docs/SCORE-PLAN.md), so the score view can show the notation instead of guessing it.
//
// Reading (`parseMusicXml`) is a port of badmidi's `agent/badmidi/musicxml.py` (`_Reader`): partwise documents and compressed .mxl,
// divisions, backup / forward, chords, voices and staves, ties, tuplets, articulations, dynamics, tempo (metronome / sound), key,
// time and rehearsal marks. Times are exact fractions of a quarter note. Grace notes, lyrics, slurs, ornaments, repeats (not
// unfolded), cue notes, percussion and a few directions are skipped and counted in the report, as badmidi does.
//
// Performing (`planMusicXml`): a tied chain is one note; ticks are `round(quarters * ppq)`; staccato sounds 50% of the written
// length, staccatissimo 25%, everything else (tenuto too) 100%; velocity is the dynamic in force (badmidi's levels) plus a boost for
// accents. No hairpins, no metric stress: simple and deterministic.
//
// Importing (`importMusicXml`) is shaped like `importSmf` (midifile.ts): a project with only the default timeline adopts the
// score's meters and tempos as regions (`smfRegions`, so tempo changes snap to the nearest bar, composite signatures are their
// total, a ritardando is only the step to its target tempo), its key and its rehearsal marks, and the clips start at bar 1.
// Otherwise the project's map stays and the clips start at the bar nearest `at`; the notes are placed by quarters on the
// project's own map (an exact bar of the score is not a bar of the project), not by seconds as the MIDI import does.
import { addMarker, addMidiClip, addNote, addRegion, addTrack, getPpq, getRegions, getTimeMap, getTracks, nextTrackColor, setKey, setRegion, tracksMap, updateTrack } from '@mobdaw/shared'
import type { Frac, NoteHint, ScoreClef } from '@mobdaw/shared'
import { strFromU8, unzipSync } from 'fflate'
import type * as Y from 'yjs'
import { hasDefaultTimeline, presetFor, smfRegions, wholeBars, type ImportResult } from './midifile'
import { INSTRUMENT_PRESETS, addInstrument, instrumentPreset } from './presets'

export class MusicXmlError extends Error {}

// ------------------------------------------------------------------------------------------------ fractions

const gcd = (a: number, b: number): number => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1 }
/** A reduced fraction with a positive denominator. */
export const frac = (n: number, d = 1): Frac => { if (d < 0) { n = -n; d = -d } const g = gcd(n, d); return [n / g, d / g] }
const fAdd = (a: Frac, b: Frac) => frac(a[0] * b[1] + b[0] * a[1], a[1] * b[1])
const fSub = (a: Frac, b: Frac) => frac(a[0] * b[1] - b[0] * a[1], a[1] * b[1])
const fMul = (a: Frac, b: Frac) => frac(a[0] * b[0], a[1] * b[1])
const fDiv = (a: Frac, b: Frac) => frac(a[0] * b[1], a[1] * b[0])
const fCmp = (a: Frac, b: Frac) => a[0] * b[1] - b[0] * a[1]
const fNum = (a: Frac) => a[0] / a[1]
const fEq = (a: Frac, b: Frac) => a[0] === b[0] && a[1] === b[1]
const ZERO: Frac = [0, 1]
/** A decimal string ("60", "1.5") as an exact fraction. */
function parseFrac(s: string | undefined | null): Frac {
  const m = /^\s*(-?)(\d*)(?:\.(\d+))?\s*$/.exec(s ?? '')
  if (!m || (!m[2] && !m[3])) throw new MusicXmlError(`not a number: ${JSON.stringify(s)}`)
  const dec = m[3] ?? ''
  const d = 10 ** dec.length
  return frac((m[1] ? -1 : 1) * (Number(m[2] || '0') * d + Number(dec || '0')), d)
}

// ------------------------------------------------------------------------------------------------ the parsed score

/** One written note (or one tied piece of it), exact and format-neutral. Times are quarter notes from the start of the score. */
export type XmlNote = {
  on: Frac
  /** The piece's actual length (a tuplet note's is already scaled). */
  dur: Frac
  /** MIDI pitch, 60 = C4, transposed to concert pitch for a transposing part. */
  pitch: number
  /** The written spelling ('F#4', 'Cb4'; octave as written, so Cb4 is 59); absent for a transposing part. */
  spell?: string
  /** The part's own voice number and 1-based staff. */
  voice: number
  staff: number
  /** Pieces tied together share a chain id (unique in the part). */
  chain: number
  tieStart: boolean
  tieStop: boolean
  tup?: { n: number; of: number; start: Frac; span: Frac }
  /** badmidi's characters, in the order `>^'_`. */
  art: string
  staccatissimo?: boolean
  /** The dynamic in force at the onset on a 0..127 scale (`mf` 78) and a one-note boost from sf / sfz / fp. */
  level: number
  boost: number
}
export type XmlPart = {
  id: string
  name: string
  /** General MIDI program 0..127 and channel 0..15 of the part's midi-instrument, when the score names them. */
  program: number | null
  channel: number | null
  staves: number
  /** One per staff (from its first clef); absent when the part has no clef at all. */
  clefs?: ScoreClef[]
  notes: XmlNote[]
}
export type XmlScore = {
  title: string
  parts: XmlPart[]
  /** Bars: where each meter starts. `num`/`den` is the name (2+2+3 is 7/8). */
  meters: { at: Frac; num: number; den: number }[]
  /** Quarter notes per minute from `at`. */
  tempos: { at: Frac; bpm: number }[]
  /** Where each bar starts, in quarters, and the end of the last. */
  bars: Frac[]
  /** The first key signature, as a mobdaw key string ("E minor"). */
  key?: string
  markers: { at: Frac; bar: number; label: string; text?: string }[]
  /** What was skipped, by kind (badmidi's wording), and the same as report lines. */
  skipped: Record<string, number>
  report: string[]
}

// ------------------------------------------------------------------------------------------------ reading the file

/** The score document inside a compressed .mxl: the container's rootfile, else the first XML outside META-INF. */
function unzipScore(data: Uint8Array): string {
  let files: Record<string, Uint8Array>
  try { files = unzipSync(data, { filter: (f) => f.originalSize < 2 ** 29 }) } catch (e) { throw new MusicXmlError(`not a readable .mxl (${(e as Error).message})`) }
  const names = Object.keys(files)
  let path: string | undefined
  if (files['META-INF/container.xml']) {
    try {
      const c = new DOMParser().parseFromString(strFromU8(files['META-INF/container.xml']), 'application/xml')
      path = c.getElementsByTagName('rootfile')[0]?.getAttribute('full-path') ?? undefined
    } catch { /* fall back to the first XML entry */ }
  }
  if (!path || !files[path]) path = names.find((n) => /\.(musicxml|xml)$/i.test(n) && !n.startsWith('META-INF/'))
  if (!path) throw new MusicXmlError('no score found inside the .mxl')
  return decodeText(files[path])
}

function decodeText(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b)
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b)
  return new TextDecoder('utf-8').decode(b)
}

const kids = (e: Element, name?: string): Element[] => Array.from(e.children).filter((c) => !name || c.localName === name)
const kid = (e: Element, name: string): Element | null => Array.from(e.children).find((c) => c.localName === name) ?? null
const txt = (e: Element, name: string): string | undefined => kid(e, name)?.textContent?.trim()

const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const UNIT: Record<string, number> = { breve: 8, whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, '64th': 0.0625 }
const ART_TAGS: Record<string, string> = { accent: '>', 'strong-accent': '^', marcato: '^', staccato: "'", staccatissimo: "'", tenuto: '_' }
const ART_ORDER = ">^'_"
// modes as steps round the circle of fifths from the major key with the same signature
const MODE_FIFTHS: Record<string, number> = { major: 0, minor: -3, dorian: -2, phrygian: -4, lydian: 1, mixolydian: -1, locrian: -5, ionian: 0, aeolian: -3 }
const IGNORED_NOTATIONS: Record<string, string> = { slur: 'slurs', ornaments: 'ornaments', technical: 'technical marks', arpeggiate: 'arpeggios', 'non-arpeggiate': 'arpeggios', glissando: 'glissandi', slide: 'glissandi' }
/** badmidi's dynamic levels (perform.py LEVELS) on 0..127; sforzandi are one-note boosts above the level in force. */
const LEVELS: Record<string, number> = { pppp: 12, ppp: 24, pp: 36, p: 50, mp: 64, mf: 78, f: 94, ff: 108, fff: 120, ffff: 127 }
const SFORZANDO: Record<string, number> = { sf: 18, sfz: 22, sffz: 22, fz: 18, rfz: 14 }
const DEFAULT_LEVEL = LEVELS.mf
const PC_NAME = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

/** "E minor" for `<key>` (fifths + mode); null when it has no fifths or an unknown mode. */
function keyOf(k: Element): string | null {
  const f = txt(k, 'fifths')
  const mode = (txt(k, 'mode') || 'major').toLowerCase()
  if (f == null || !Number.isFinite(Number(f)) || !(mode in MODE_FIFTHS)) return null
  const t = Number(f) - MODE_FIFTHS[mode] // the major key with this signature, then the tonic of the mode
  const letter = 'FCGDAEB'[(((t + 1) % 7) + 7) % 7], acc = Math.floor((t + 1) / 7)
  const tonic = Math.abs(acc) > 1 ? PC_NAME[(((STEP[letter] + acc) % 12) + 12) % 12] : letter + (acc > 0 ? '#'.repeat(acc) : 'b'.repeat(-acc))
  return `${tonic} ${mode === 'ionian' ? 'major' : mode === 'aeolian' ? 'minor' : mode}`
}

function clefOf(c: Element): ScoreClef | undefined {
  const sign = (txt(c, 'sign') ?? '').toUpperCase(), line = Number(txt(c, 'line') || 0), shift = Number(txt(c, 'clef-octave-change') || 0)
  if (sign === 'PERCUSSION') return 'perc'
  if (sign === 'G') return shift < 0 ? 'treble_8' : 'treble'
  if (sign === 'F') return shift < 0 ? 'bass_8' : 'bass'
  if (sign === 'C') return line === 4 ? 'tenor' : 'alto'
  return undefined // TAB, none
}

/** Beats per minute in quarters from a `<metronome>` with a beat unit and a plain per-minute number. */
function metronomeBpm(m: Element): number | null {
  const unit = UNIT[txt(m, 'beat-unit') ?? ''], pm = txt(m, 'per-minute') ?? ''
  if (unit == null || !/^\d+(\.\d+)?$/.test(pm)) return null
  return Math.round(Number(pm) * unit * (2 - 0.5 ** kids(m, 'beat-unit-dot').length) * 1000) / 1000
}

type Sig = { num: number; den: number; length: Frac } | 'free'
/** A bar of this many quarters that no time signature names (a pickup, a short or overfull bar): over `prefer` if it fits. */
function meterSpec(length: Frac, prefer?: number): { num: number; den: number } {
  for (const den of [...(prefer ? [prefer] : []), 4, 8, 16, 32, 64]) {
    const n = frac(length[0] * den, length[1] * 4)
    if (n[1] === 1) return { num: n[0], den }
  }
  return { num: Math.round(fNum(length) * 16), den: 64 }
}

type DirItem = { k: 'dyn'; level?: number; sf?: number } | { k: 'tempo'; bpm: number; sound: boolean } | { k: 'marker'; label: string; text?: string }
type RawNote = {
  t: Frac; dur: Frac; midi: number; spell?: string; voice: number; staff: number; tieStart: boolean; tieStop: boolean; art: string
  staccatissimo: boolean; tup?: XmlNote['tup']
}
type Item = { rest: boolean; t: Frac; dur: Frac; voice: number; staff: number; tm?: { a: number; n: number }; unit?: Frac; starts: string[]; stops: string[]; notes: RawNote[] }
type Meas = { extent: Frac; time: Sig | null; items: Item[]; dirs: { t: Frac; items: DirItem[] }[] }
type RawPart = { measures: Meas[]; staves: number; clefs: Map<number, ScoreClef | undefined>; keys: string[] }

function direction(el: Element, skipped: (what: string, n?: number) => void): DirItem[] {
  const items: DirItem[] = []
  const words: string[] = []
  let rehearsal: string | undefined, metro: number | null = null
  for (const dt of kids(el, 'direction-type')) {
    for (const c of kids(dt)) {
      switch (c.localName) {
        case 'dynamics':
          for (const d of kids(c)) {
            const name = d.localName === 'other-dynamics' ? (d.textContent ?? '').trim() : d.localName
            if (name in LEVELS) items.push({ k: 'dyn', level: LEVELS[name] })
            else if (name in SFORZANDO) items.push({ k: 'dyn', sf: SFORZANDO[name] })
            else if (name === 'fp') items.push({ k: 'dyn', level: LEVELS.p, sf: LEVELS.f - LEVELS.p })
          }
          break
        case 'wedge': if (c.getAttribute('type') !== 'stop') skipped('hairpins (not performed)'); break
        case 'words': { const s = (c.textContent ?? '').split(/\s+/).filter(Boolean).join(' '); if (s) words.push(s); break }
        case 'rehearsal': rehearsal = (c.textContent ?? '').split(/\s+/).filter(Boolean).join(' ') || rehearsal; break
        case 'metronome': metro = metronomeBpm(c); break
        case 'octave-shift': case 'segno': case 'coda': case 'harp-pedals': case 'percussion': case 'image': case 'accordion-registration': case 'pedal':
          skipped(`${c.localName} directions`); break
      }
    }
  }
  const snd = kid(el, 'sound')
  const sound = snd && /^\d+(\.\d+)?$/.test(snd.getAttribute('tempo') ?? '') ? Number(snd.getAttribute('tempo')) : null
  if (rehearsal) items.push({ k: 'marker', label: rehearsal, ...(words.length ? { text: words.join(' ') } : {}) })
  if (sound != null || metro != null) items.push({ k: 'tempo', bpm: (sound ?? metro)!, sound: sound != null })
  return items
}

function readPart(el: Element, skipped: (what: string, n?: number) => void): RawPart {
  let div: Frac | null = null, shift = 0
  const out: RawPart = { measures: [], staves: 1, clefs: new Map(), keys: [] }
  for (const [mi, m] of kids(el, 'measure').entries()) {
    const meas: Meas = { extent: ZERO, time: null, items: [], dirs: [] }
    out.measures.push(meas)
    let pos = ZERO, lastOn = ZERO
    let last: Item | null = null
    const q = (s: string | undefined) => { if (!div) throw new MusicXmlError('notes before <divisions>'); return fDiv(parseFrac(s), div) }
    for (const c of kids(m)) {
      try {
        switch (c.localName) {
          case 'attributes': {
            const dv = txt(c, 'divisions')
            if (dv) { div = parseFrac(dv); if (!(div[0] > 0)) throw new MusicXmlError('divisions must be positive') }
            const st = txt(c, 'staves')
            if (st) out.staves = Math.max(out.staves, Number(st))
            for (const k of kids(c, 'key')) { const s = keyOf(k); if (s) out.keys.push(s) }
            for (const tm of kids(c, 'time')) meas.time = timeOf(tm)
            for (const cl of kids(c, 'clef')) { const n = Number(cl.getAttribute('number') || 1); if (!out.clefs.has(n)) out.clefs.set(n, clefOf(cl)); else skipped('clef changes') }
            const tr = kid(c, 'transpose')
            if (tr) shift = Number(txt(tr, 'chromatic') || 0) + 12 * Number(txt(tr, 'octave-change') || 0)
            break
          }
          case 'note': {
            const chord = !!kid(c, 'chord')
            if (kid(c, 'grace')) { skipped('grace notes'); break }
            const dur = q(txt(c, 'duration'))
            const start = chord ? lastOn : pos
            if (!chord) { lastOn = pos; pos = fAdd(pos, dur) }
            const voice = Number.parseInt(txt(c, 'voice') ?? '1', 10) || 1
            const staff = Number(txt(c, 'staff') || 1)
            const tmEl = kid(c, 'time-modification')
            const tm = tmEl ? { a: Number(txt(tmEl, 'actual-notes')), n: Number(txt(tmEl, 'normal-notes')) } : undefined
            const marks = { starts: [] as string[], stops: [] as string[] }
            for (const nt of kids(c, 'notations')) for (const t of kids(nt, 'tuplet')) {
              const type = t.getAttribute('type'), num = t.getAttribute('number') ?? '1'
              if (type === 'start') marks.starts.push(num)
              else if (type === 'stop') marks.stops.push(num)
            }
            let item: Item
            if (chord && last) { item = last; item.starts.push(...marks.starts); item.stops.push(...marks.stops) }
            else {
              const ty = UNIT[txt(c, 'type') ?? '']
              item = { rest: !!kid(c, 'rest'), t: start, dur, voice, staff, ...(tm && tm.a > 0 && tm.n > 0 ? { tm } : {}), ...(ty ? { unit: frac(Math.round(ty * 64), 64) } : {}), ...marks, notes: [] }
              meas.items.push(item); last = item
            }
            if (kid(c, 'rest')) break
            if (kid(c, 'cue')) { skipped('cue notes'); break }
            if (kid(c, 'unpitched')) { skipped('unpitched (percussion) notes'); break }
            const p = kid(c, 'pitch')
            if (!p) break
            const step = txt(p, 'step') ?? 'C', octave = Number(txt(p, 'octave'))
            const alter = Number(txt(p, 'alter') || 0), a = Math.round(alter)
            if (a !== alter) skipped('microtonal alterations (rounded)')
            if (!(step in STEP) || !Number.isFinite(octave)) throw new MusicXmlError('bad pitch')
            let midi = 12 * (octave + 1) + STEP[step] + a
            let spell: string | undefined = `${step}${a > 0 ? '#'.repeat(a) : 'b'.repeat(-a)}${octave}`
            if (shift) { midi += shift; spell = undefined }
            out.staves = Math.max(out.staves, staff)
            const ties = new Set(kids(c, 'tie').map((t) => t.getAttribute('type')))
            if (!ties.size) for (const nt of kids(c, 'notations')) for (const t of kids(nt, 'tied')) ties.add(t.getAttribute('type'))
            let art = '', staccatissimo = false
            for (const nt of kids(c, 'notations')) {
              for (const ar of kids(nt, 'articulations')) for (const a_ of kids(ar)) {
                const ch = ART_TAGS[a_.localName]
                if (ch && !art.includes(ch)) art += ch
                if (a_.localName === 'staccatissimo') staccatissimo = true
              }
              if (kid(nt, 'fermata')) skipped('fermatas')
              for (const ch_ of kids(nt)) if (ch_.localName in IGNORED_NOTATIONS && [null, 'start'].includes(ch_.getAttribute('type'))) skipped(IGNORED_NOTATIONS[ch_.localName])
              for (const d of kids(nt, 'dynamics')) { const dir = direction(wrapDynamics(d), skipped); if (dir.length) meas.dirs.push({ t: start, items: dir }) }
            }
            skipped('lyrics', kids(c, 'lyric').length)
            item.notes.push({ t: start, dur, midi, spell, voice, staff, tieStart: ties.has('start'), tieStop: ties.has('stop'), art, staccatissimo })
            break
          }
          case 'backup': pos = fSub(pos, q(txt(c, 'duration'))); break
          case 'forward': pos = fAdd(pos, q(txt(c, 'duration'))); break
          case 'direction': meas.dirs.push({ t: fAdd(pos, q(txt(c, 'offset') || '0')), items: direction(c, skipped) }); break
          case 'sound': {
            const t = c.getAttribute('tempo')
            if (t && /^\d+(\.\d+)?$/.test(t)) meas.dirs.push({ t: pos, items: [{ k: 'tempo', bpm: Number(t), sound: true }] })
            break
          }
          case 'barline': if (kid(c, 'repeat')) skipped('repeat barlines (not unfolded)'); break
          case 'harmony': case 'figured-bass': skipped('chord symbols and figured bass'); break
        }
      } catch (e) {
        if (e instanceof MusicXmlError) throw new MusicXmlError(`measure ${m.getAttribute('number') ?? mi + 1}: <${c.localName}> can't be read (${e.message})`)
        throw e
      }
      if (fCmp(pos, meas.extent) > 0) meas.extent = pos
    }
  }
  return out
}

/** A `<dynamics>` element of a note's notations, as a direction (so one reader handles both). */
function wrapDynamics(d: Element): Element {
  const doc = d.ownerDocument
  const dir = doc.createElement('direction'), dt = doc.createElement('direction-type')
  dt.appendChild(d.cloneNode(true)); dir.appendChild(dt)
  return dir
}

function timeOf(tm: Element): Sig {
  if (kid(tm, 'senza-misura')) return 'free'
  const beats = kids(tm, 'beats').map((b) => (b.textContent ?? '').trim()), types = kids(tm, 'beat-type').map((b) => Number((b.textContent ?? '').trim()))
  const sum = (b: string) => b.split('+').reduce((s, x) => s + (Number(x) || 0), 0)
  let length = ZERO
  beats.forEach((b, i) => { length = fAdd(length, frac(sum(b) * 4, types[i] || 4)) })
  if (beats.length === 1 && types[0]) return { num: sum(beats[0]), den: types[0], length }
  const spec = meterSpec(length)
  return { ...spec, length }
}

/** A partwise MusicXML document (text, bytes, or a compressed .mxl) as a format-neutral score. */
export function parseMusicXml(data: Uint8Array | string): XmlScore {
  let text: string
  if (typeof data === 'string') text = data
  else if (data[0] === 0x50 && data[1] === 0x4b) text = unzipScore(data)
  else text = decodeText(data)
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const err = doc.getElementsByTagName('parsererror')[0]
  if (err || !doc.documentElement) throw new MusicXmlError(`not a MusicXML file (${(err?.textContent ?? 'no document').trim().split('\n')[0].slice(0, 120)})`)
  const root = doc.documentElement
  if (root.localName === 'score-timewise') throw new MusicXmlError('timewise MusicXML is not supported; export it partwise (score-partwise)')
  if (root.localName !== 'score-partwise') throw new MusicXmlError(`not a MusicXML score (root element <${root.localName}>)`)

  const skipped: Record<string, number> = {}
  const skip = (what: string, n = 1) => { if (n) skipped[what] = (skipped[what] ?? 0) + n }
  const title = (txt(kid(root, 'work') ?? root, 'work-title') || txt(root, 'movement-title') || '').trim()

  const infos = new Map<string, { name: string; insts: Map<string, [number | null, number | null]> }>()
  for (const sp of kids(kid(root, 'part-list') ?? root, 'score-part')) {
    const insts = new Map<string, [number | null, number | null]>()
    for (const mi of kids(sp, 'midi-instrument')) {
      const prog = txt(mi, 'midi-program') ?? '', ch = txt(mi, 'midi-channel') ?? ''
      insts.set(mi.getAttribute('id') ?? '', [/^\d+$/.test(prog) && +prog >= 1 && +prog <= 128 ? +prog - 1 : null, /^\d+$/.test(ch) && +ch >= 1 && +ch <= 16 ? +ch - 1 : null])
    }
    const id = sp.getAttribute('id') ?? ''
    infos.set(id, { name: (txt(sp, 'part-name') || txt(sp, 'part-abbreviation') || id).trim(), insts })
  }
  const partEls = kids(root, 'part')
  if (!partEls.length) throw new MusicXmlError('no <part> in the score')
  const raws = partEls.map((el, i) => {
    const info = infos.get(el.getAttribute('id') ?? '') ?? { name: el.getAttribute('id') || `part ${i + 1}`, insts: new Map() }
    try { return { el, info, raw: readPart(el, skip) } } catch (e) { throw new MusicXmlError(`part '${info.name}', ${(e as Error).message}`) }
  })

  // bar lengths: the signature's, unless the music fills more (or a pickup / short bar fills less)
  const nmeas = Math.max(...raws.map((r) => r.raw.measures.length))
  const starts: Frac[] = [ZERO]
  const meters: XmlScore['meters'] = []
  let sig: Sig | null = null, prev = ''
  for (let i = 0; i < nmeas; i++) {
    const ms = raws.flatMap((r) => (i < r.raw.measures.length ? [r.raw.measures[i]] : []))
    sig = ms.find((m) => m.time)?.time ?? sig
    const extent = ms.reduce((x, m) => (fCmp(m.extent, x) > 0 ? m.extent : x), ZERO)
    const natural = sig && sig !== 'free' ? sig.length : null
    const length = !natural || fCmp(extent, natural) > 0 || (fCmp(extent, natural) < 0 && extent[0] > 0 && i < nmeas - 1) ? (extent[0] ? extent : natural ?? ([4, 1] as Frac)) : natural
    const named = sig && sig !== 'free' && natural && fEq(length, natural) ? sig : null
    const spec = named ? { num: named.num, den: named.den } : meterSpec(length, sig && sig !== 'free' ? sig.den : undefined)
    const key = `${spec.num}/${spec.den}`
    if (key !== prev) { meters.push({ at: starts[i], ...spec }); prev = key }
    starts.push(fAdd(starts[i], length))
  }
  const barOf = (t: Frac) => { let b = 0; while (b + 1 < nmeas && fCmp(starts[b + 1], t) <= 0) b++; return b + 1 }

  const tempos = new Map<string, { at: Frac; v: { bpm: number; sound: boolean }[] }>()
  const markers: XmlScore['markers'] = []
  const parts: XmlPart[] = []
  let key: string | undefined
  for (const { el, info, raw } of raws) {
    key ??= raw.keys[0]
    const [defProg, defCh] = [...info.insts.values()][0] ?? [null, null]
    const levels: { t: Frac; level: number }[] = []
    const boosts: { t: Frac; sf: number }[] = []
    const streams = new Map<string, { on: Frac; item: Item; notes: XmlNote[] }[]>()
    const notes: XmlNote[] = []
    const heads = new Map<string, number>()
    let chains = 0
    raw.measures.forEach((meas, i) => {
      for (const d of meas.dirs) {
        const t = fAdd(starts[i], d.t)
        for (const it of d.items) {
          if (it.k === 'dyn') { if (it.level != null) levels.push({ t, level: it.level }); if (it.sf) boosts.push({ t, sf: it.sf }) }
          else if (it.k === 'tempo') { const k = `${t[0]}/${t[1]}`; const e = tempos.get(k) ?? { at: t, v: [] }; e.v.push(it); tempos.set(k, e) }
          else markers.push({ at: t, bar: barOf(t), label: it.label, ...(it.text ? { text: it.text } : {}) })
        }
      }
      for (const item of meas.items) {
        const on = fAdd(starts[i], item.t)
        const xs: XmlNote[] = []
        for (const r of item.notes) {
          const k = `${r.staff}|${r.voice}|${r.midi}` // a tie continues the same pitch in the same voice and staff
          const chain = r.tieStop && heads.has(k) ? heads.get(k)! : chains++
          if (r.tieStart) heads.set(k, chain); else heads.delete(k)
          const x: XmlNote = { on, dur: r.dur, pitch: r.midi, ...(r.spell ? { spell: r.spell } : {}), voice: r.voice, staff: r.staff, chain, tieStart: r.tieStart, tieStop: r.tieStop, art: [...ART_ORDER].filter((c) => r.art.includes(c)).join(''), ...(r.staccatissimo ? { staccatissimo: true } : {}), level: DEFAULT_LEVEL, boost: 0 }
          xs.push(x); notes.push(x)
        }
        const sk = `${item.staff}|${item.voice}`
        if (!streams.has(sk)) streams.set(sk, [])
        streams.get(sk)!.push({ on, item, notes: xs })
      }
    })
    for (const s of streams.values()) groupTuplets(s)
    // the dynamic in force at each onset: the last mark at or before it (marks at one moment: the last written wins)
    levels.sort((a, b) => fCmp(a.t, b.t))
    for (const x of notes) {
      let lo = 0, hi = levels.length
      while (lo < hi) { const mid = (lo + hi) >> 1; if (fCmp(levels[mid].t, x.on) <= 0) lo = mid + 1; else hi = mid }
      x.level = lo ? levels[lo - 1].level : DEFAULT_LEVEL
      x.boost = boosts.filter((b) => fEq(b.t, x.on)).reduce((s, b) => Math.max(s, b.sf), 0)
    }
    const clefs = raw.staves > 0 && [...raw.clefs.values()].some(Boolean) ? Array.from({ length: raw.staves }, (_, s) => raw.clefs.get(s + 1) ?? 'treble') : undefined
    if (raw.keys.length > 1) skip('key changes (only the first is kept)', raw.keys.length - 1)
    parts.push({ id: el.getAttribute('id') ?? String(parts.length + 1), name: info.name, program: defProg, channel: defCh, staves: raw.staves, ...(clefs ? { clefs } : {}), notes })
  }

  const tempoList = [...tempos.values()].sort((a, b) => fCmp(a.at, b.at)).map((e) => ({ at: e.at, bpm: ([...e.v].reverse().find((x) => x.sound) ?? e.v[e.v.length - 1]).bpm }))
  if (tempoList.length && tempoList[0].at[0] > 0) tempoList.unshift({ at: ZERO, bpm: 120 }) // MusicXML's default
  const seen = new Set<string>()
  const marks = markers.sort((a, b) => fCmp(a.at, b.at)).filter((m) => { const k = `${m.bar}|${m.label}`; return !seen.has(k) && !!seen.add(k) })
  return {
    title, parts, meters, tempos: tempoList, bars: starts, ...(key ? { key } : {}), markers: marks, skipped,
    report: Object.entries(skipped).filter(([, n]) => n).map(([what, n]) => `skipped: ${n} ${what}`),
  }
}

/**
 * Tuplet spans for one voice's items, in order: from the `tuplet` start / stop notations (nested groups by number; the innermost
 * wins), else consecutive time-modified items of one ratio are grouped until their actual time fills `normal x written value`.
 */
function groupTuplets(items: { on: Frac; item: Item; notes: XmlNote[] }[]) {
  type G = { num: string | null; start: Frac; members: typeof items; a: number; n: number; span?: Frac }
  const open: G[] = []
  let imp: G | null = null
  let sum = ZERO
  let lastEnd = ZERO
  const finish = (g: G, end: Frac) => {
    const span = g.span && fCmp(g.span, fSub(end, g.start)) <= 0 ? g.span : fSub(end, g.start)
    for (const m of g.members) for (const x of m.notes) x.tup = { n: m.item.tm!.a, of: m.item.tm!.n, start: g.start, span }
  }
  for (const it of items) {
    const tm = it.item.tm
    if (imp && (!tm || tm.a !== imp.a || tm.n !== imp.n || it.item.starts.length)) { finish(imp, lastEnd); imp = null }
    for (const num of it.item.starts) open.push({ num, start: it.on, members: [], a: tm?.a ?? 0, n: tm?.n ?? 0 })
    if (tm) {
      if (open.length) open[open.length - 1].members.push(it)
      else {
        if (!imp) {
          const unit = it.item.unit ?? fMul(it.item.dur, frac(tm.a, tm.n))
          imp = { num: null, start: it.on, members: [], a: tm.a, n: tm.n, span: fMul(unit, frac(tm.n)) }
          sum = ZERO
        }
        imp.members.push(it)
        sum = fAdd(sum, it.item.dur)
      }
    }
    lastEnd = fAdd(it.on, it.item.dur)
    for (const num of it.item.stops) {
      const gi = open.map((g) => g.num).lastIndexOf(num)
      if (gi >= 0) { const [g] = open.splice(gi, 1); finish(g, lastEnd) }
    }
    if (imp && fCmp(sum, imp.span!) >= 0) { finish(imp, lastEnd); imp = null }
  }
  if (imp) finish(imp, lastEnd)
  for (const g of open) finish(g, lastEnd)
}

// ------------------------------------------------------------------------------------------------ performing

const ACCENT_BOOST: Record<string, number> = { '>': 12, '^': 20 }

/** Fraction of the written length that sounds. */
export const soundingRatio = (n: Pick<XmlNote, 'art' | 'staccatissimo'>) => (n.staccatissimo ? 0.25 : n.art.includes("'") ? 0.5 : 1)

export type PlanNote = { tick: number; durTicks: number; pitch: number; velocity: number; hint: NoteHint }
export type PlanPart = { name: string; preset: string; clefs?: ScoreClef[]; lengthTicks: number; notes: PlanNote[] }

/** MIDI velocity 0..1 (what `Note.velocity` holds) for a dynamic level plus boosts, on badmidi's 0..127 scale. */
export const velocityOf = (level: number, boost = 0, art = '') =>
  Math.round((Math.min(127, Math.max(1, level + boost + Math.max(0, ...[...art].map((c) => ACCENT_BOOST[c] ?? 0)))) / 127) * 1000) / 1000

/**
 * The score as clip contents (pure): per part, tied chains merged into single notes at `round(quarters * ppq)` with their hint.
 * Voices are renumbered 1..n per staff in order of appearance. Tick 0 is the start of the score.
 */
export function planMusicXml(score: XmlScore, o: { ppq: number }): PlanPart[] {
  const tick = (q: Frac) => Math.round((q[0] * o.ppq) / q[1])
  return score.parts.filter((p) => p.notes.length).map((p) => {
    const chains = new Map<number, XmlNote[]>()
    for (const x of p.notes) { const c = chains.get(x.chain); if (c) c.push(x); else chains.set(x.chain, [x]) }
    const voices = new Map<string, number>() // staff|voice -> 1..n on that staff
    const perStaff = new Map<number, number>()
    for (const x of p.notes) {
      const k = `${x.staff}|${x.voice}`
      if (!voices.has(k)) { const n = (perStaff.get(x.staff) ?? 0) + 1; perStaff.set(x.staff, n); voices.set(k, n) }
    }
    const notes: PlanNote[] = []
    for (const pieces of chains.values()) {
      const x = pieces[0], last = pieces[pieces.length - 1]
      const len = fSub(fAdd(last.on, last.dur), x.on)
      const t0 = tick(x.on)
      const sounding = soundingRatio(x)
      const end = sounding === 1 ? tick(fAdd(x.on, len)) : tick(fAdd(x.on, fMul(len, frac(Math.round(sounding * 100), 100))))
      const durTicks = Math.max(1, end - t0)
      notes.push({
        tick: t0, durTicks, pitch: x.pitch, velocity: velocityOf(x.level, x.boost, x.art),
        hint: {
          at: [t0, durTicks, x.pitch], on: x.on, len,
          ...(pieces.length > 1 ? { segs: pieces.map((q) => q.dur) } : {}),
          ...(x.tup ? { tup: x.tup } : {}),
          staff: x.staff, voice: voices.get(`${x.staff}|${x.voice}`)!,
          ...(x.spell ? { spell: x.spell } : {}),
          ...(x.art ? { art: x.art } : {}),
        },
      })
    }
    notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch)
    const lengthTicks = Math.max(1, ...notes.map((n) => n.tick + n.durTicks))
    return { name: p.name, preset: presetFor(p.name, p.program), ...(p.clefs ? { clefs: p.clefs } : {}), lengthTicks, notes }
  })
}

// ------------------------------------------------------------------------------------------------ score -> project

/** The score's meters and tempos in the shape `smfRegions` reads (an 960-ppq pseudo file, so a bar line is a whole number of ticks). */
const asSmf = (s: XmlScore) => {
  const ppq = 960, t = (q: Frac) => Math.round((q[0] * ppq) / q[1])
  return { format: 1, ppq, parts: [], title: s.title, meters: s.meters.map((m) => ({ tick: t(m.at), num: m.num, den: m.den })), tempos: s.tempos.map((x) => ({ tick: t(x.at), bpm: x.bpm })) }
}

/**
 * Put a parsed score into the project, in one transaction (one undo step). With `trackId` a MIDI track (not the click), all of the
 * parts go into one clip on that track and their hints lose `staff` and `voice` (the track's staves are not the score's);
 * otherwise each part gets a new finnwave track named after it, with a preset chosen from its name or program, and its `clefs`.
 *  - A project with just the default timeline (`hasDefaultTimeline`) takes the score's meters and tempos as regions, its key
 *    (`meta.key`) and rehearsal marks; the clips start at bar 1 (`at` is ignored).
 *  - Otherwise the project's map, key and markers stay: the clips start at the bar nearest `at` (samples) and the notes sit at
 *    `startTick + round(quarters * ppq)`, so the score's bars follow the project's only by luck.
 * Clips are rounded up to whole bars of the map.
 */
export function importMusicXml(doc: Y.Doc, score: XmlScore, o: { at: number; trackId?: string | null; base: string }): ImportResult {
  const res: ImportResult = { tracks: [], clips: [], adopted: false, into: null }
  const click = new Set(getTracks(doc).filter((t) => t.role === 'click').map((t) => t.id))
  const target = o.trackId && tracksMap(doc).get(o.trackId)?.get('kind') === 'midi' && !click.has(o.trackId) ? o.trackId : null
  let adopted = false
  doc.transact(() => {
    const parts = planMusicXml(score, { ppq: getPpq(doc) })
    if (!parts.length) return
    const fresh = hasDefaultTimeline(doc)
    let startTick = 0
    if (fresh) {
      const regions = smfRegions(asSmf(score))
      const first = getRegions(doc)[0]
      regions.forEach((r, i) => {
        if (i === 0) setRegion(doc, first.id, { bpm: r.bpm, num: r.num, den: r.den, groups: undefined, rampTo: r.rampTo })
        else addRegion(doc, { bar: r.bar, bpm: r.bpm, num: r.num, den: r.den, ...(r.rampTo ? { rampTo: r.rampTo } : {}) })
      })
      if (score.key) setKey(doc, score.key)
      for (const m of score.markers) addMarker(doc, { bar: m.bar, label: m.label, ...(m.text ? { text: m.text } : {}) })
      adopted = true
    } else {
      const m = getTimeMap(doc)
      const raw = m.sampleToTick(Math.max(0, o.at))
      startTick = Math.max(0, m.snapTick(raw, 'bar') ?? raw)
    }
    const map = getTimeMap(doc)
    const clip = (trackId: string, lengthTicks: number, notes: PlanNote[], merged: boolean) => {
      const id = addMidiClip(doc, { trackId, startTick, lengthTicks: wholeBars(map, startTick, lengthTicks) })
      for (const n of notes) {
        const hint = { ...n.hint }
        if (merged) { delete hint.staff; delete hint.voice }
        addNote(doc, { clipId: id, tick: n.tick, durTicks: n.durTicks, pitch: n.pitch, velocity: n.velocity, hint })
      }
      res.clips.push(id)
    }
    if (target) {
      res.into = target
      clip(target, Math.max(...parts.map((p) => p.lengthTicks)), parts.flatMap((p) => p.notes).sort((a, b) => a.tick - b.tick || a.pitch - b.pitch), true)
      return
    }
    parts.forEach((p, i) => {
      const name = p.name || (parts.length > 1 ? `${o.base} ${i + 1}` : o.base)
      const id = addTrack(doc, name, 'midi', undefined, undefined, nextTrackColor(getTracks(doc)))
      addInstrument(doc, id, instrumentPreset(p.preset) ?? INSTRUMENT_PRESETS[0])
      if (p.clefs) updateTrack(doc, id, { clefs: p.clefs })
      res.tracks.push(id)
      clip(id, p.lengthTicks, p.notes, false)
    })
  })
  res.adopted = adopted
  return res
}

/** Whether a dropped or picked file looks like MusicXML (plain or compressed). */
export const isMusicXmlFile = (f: Pick<File, 'name' | 'type'>) => /\.(musicxml|xml|mxl)$/i.test(f.name) || /^application\/vnd\.recordare\.musicxml/.test(f.type)
