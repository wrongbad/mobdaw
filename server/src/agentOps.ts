// The agent API's edit operations (docs/agent-api.md "Ops"). A batch is validated field by field, then run against a scratch copy of
// the live document with the schema.ts mutators (positions as "bar.beat.tick" or ticks, pitches as "C#4" or numbers, "$n" references
// to the id an earlier op made). Only if every op worked is the scratch's change applied to the live document, inside one
// transaction attributed to "<user> (api)": all-or-nothing, and one history entry.
import * as Y from 'yjs'
import {
  DEVICES, FINNWAVE, MASTER_TRACK, MIX, PositionError, addDevice, addMarker, addMidiClip, addNote, addRegion, addTrack, apiName,
  clipsMap, deleteClip, deleteDevice, deleteMarker, deleteNote, deleteRegion, deleteTrack, deviceType, devicesMap, getRegions, getTimeMap,
  ensureMixDevice, getDevices, isFutureDoc, markersMap, notesMap, paramOf, parseDuration, parseNote, parsePosition, regionAtBar, regionsMap, setKey, setParam, setRegion,
  getTracks, noteName, tracksMap, updateClip, updateDevice, updateMarker, updateNote, updateTrack, type DeviceDef, type Frac, type NoteHint, type Region, type RegionPatch, type ScoreClef,
} from '@mobdaw/shared'
import type { Ctx } from './auth.ts'
import { writeAs, type Collab } from './history.ts'

/** A bad batch: which op (0-based) and why. */
export class OpError extends Error {
  constructor(public index: number, message: string) {
    super(index >= 0 ? `op ${index}: ${message}` : message)
  }
}

// Abuse guards, not model limits: a batch is one synchronous transaction and one Yjs update broadcast to every client, so these cap the
// worst case. A whole piece (tens of thousands of notes) must fit in ONE batch, or it would land as several history entries.
export const MAX_OPS = 5000
export const MAX_NOTES = 100_000

type Spec = Record<string, string>
/** Field types: str, num, bool, any, list (an array); a trailing ? makes it optional. Unknown fields are an error (a typo should not pass silently). */
const SPECS: Record<string, Spec> = {
  addTrack: { name: 'str', kind: 'str?', preset: 'any?', like: 'str?', clefs: 'list?' },
  updateTrack: { id: 'str', name: 'str?', muted: 'bool?', soloed: 'bool?', color: 'num?', clefs: 'list?' },
  removeTrack: { id: 'str' },
  addMidiClip: { trackId: 'str', start: 'any', length: 'any', loop: 'any?', view: 'str?' },
  updateClip: { id: 'str', start: 'any?', length: 'any?', trackId: 'str?', loop: 'any?', view: 'str?' },
  removeClip: { id: 'str' },
  addNotes: { clipId: 'str', notes: 'list' },
  updateNotes: { notes: 'list' },
  removeNotes: { ids: 'list' },
  addDevice: { trackId: 'str', type: 'any', name: 'str?', key: 'any?', params: 'obj?' },
  removeDevice: { id: 'str' },
  setParam: { deviceId: 'str', param: 'any', value: 'any' },
  addRegion: { bar: 'num', bpm: 'num?', meter: 'str?', rampTo: 'num?', free: 'num?' },
  setRegion: { id: 'str?', bar: 'num?', bpm: 'num?', meter: 'str?', rampTo: 'any?', free: 'num?' },
  removeRegion: { id: 'str?', bar: 'num?' },
  addMarker: { bar: 'num', label: 'str', text: 'str?' },
  updateMarker: { id: 'str', bar: 'num?', label: 'str?', text: 'str?' },
  removeMarker: { id: 'str' },
  setKey: { key: 'str' },
}
export type Op = { op: keyof typeof SPECS } & Record<string, unknown>

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function checkFields(i: number, what: string, o: Record<string, unknown>, spec: Spec, skip: string[] = []) {
  for (const k of Object.keys(o)) if (!(k in spec) && !skip.includes(k)) throw new OpError(i, `${what}: unknown field "${k}" (fields: ${Object.keys(spec).join(', ')})`)
  for (const [k, t] of Object.entries(spec)) {
    const optional = t.endsWith('?'), type = t.replace('?', '')
    const v = o[k]
    if (v === undefined || (v === null && optional)) {
      if (!optional) throw new OpError(i, `${what}: "${k}" is required`)
      continue
    }
    const ok = type === 'any' || (type === 'str' && typeof v === 'string') || (type === 'num' && typeof v === 'number' && Number.isFinite(v)) ||
      (type === 'bool' && typeof v === 'boolean') || (type === 'list' && Array.isArray(v)) || (type === 'obj' && isObj(v))
    if (!ok) throw new OpError(i, `${what}: "${k}" must be ${type === 'list' ? 'an array' : type === 'obj' ? 'an object' : `a ${type === 'str' ? 'string' : type === 'num' ? 'number' : type}`}`)
  }
}

/** Shape-check a batch (no document needed). Throws OpError. */
export function parseOps(raw: unknown): Op[] {
  if (!Array.isArray(raw)) throw new OpError(-1, '"ops" must be an array')
  if (!raw.length) throw new OpError(-1, '"ops" is empty')
  if (raw.length > MAX_OPS) throw new OpError(-1, `at most ${MAX_OPS} ops per batch`)
  let notes = 0
  raw.forEach((o, i) => {
    if (!isObj(o) || typeof o.op !== 'string') throw new OpError(i, `must be an object with an "op" (one of: ${Object.keys(SPECS).join(', ')})`)
    const spec = SPECS[o.op]
    if (!spec) throw new OpError(i, `unknown op "${o.op}" (ops: ${Object.keys(SPECS).join(', ')})`)
    checkFields(i, o.op, o, spec, ['op'])
    if (Array.isArray(o.notes)) {
      notes += o.notes.length
      o.notes.forEach((n, j) => {
        if (!isObj(n)) throw new OpError(i, `notes[${j}] must be an object`)
        checkFields(i, `notes[${j}]`, n, o.op === 'addNotes' ? NEW_NOTE : NOTE_PATCH)
      })
    }
  })
  if (notes > MAX_NOTES) throw new OpError(-1, `at most ${MAX_NOTES} notes per batch`)
  return raw as Op[]
}
const NEW_NOTE: Spec = { pitch: 'any?', p: 'any?', t: 'any', d: 'any', v: 'num?', hint: 'any?' }
const NOTE_PATCH: Spec = { id: 'str', pitch: 'any?', p: 'any?', t: 'any?', d: 'any?', v: 'num?', hint: 'any?' }

// --- notation hints (docs/agent-api.md "Notation hints"): the agent gives how the note is written, the server adds `at`.
const CLEFS: ScoreClef[] = ['treble', 'bass', 'alto', 'tenor', 'treble_8', 'bass_8', 'perc']
const HINT_FIELDS = ['on', 'len', 'segs', 'tup', 'staff', 'voice', 'spell', 'art']
const ART_CHARS = ">^'_"
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : Math.abs(a))
const fAdd = (a: Frac, b: Frac): Frac => { const d = a[1] * b[1], n = a[0] * b[1] + b[0] * a[1], g = gcd(n, d) || 1; return [n / g, d / g] }
const fEq = (a: Frac, b: Frac) => a[0] * b[1] === b[0] * a[1]
const SPELL = /^([A-G])(bb|##|b|#|x)?(-?\d+)$/
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const ACC: Record<string, number> = { '': 0, b: -1, bb: -2, '#': 1, '##': 2, x: 2 }

function fracOf(i: number, where: string, v: unknown, min: 'zero' | 'positive'): Frac {
  const ok = Array.isArray(v) && v.length === 2 && Number.isSafeInteger(v[0]) && Number.isSafeInteger(v[1]) && v[1] > 0
  if (!ok) return bad(i, `${where} must be a fraction [numerator, denominator] of integers with denominator > 0 (quarter notes), got ${JSON.stringify(v)}`)
  const f = v as Frac
  if (min === 'positive' ? f[0] <= 0 : f[0] < 0) return bad(i, `${where} must be ${min === 'positive' ? '> 0' : '>= 0'}, got ${JSON.stringify(v)}`)
  return f
}
const posInt = (i: number, where: string, v: unknown): number => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : bad(i, `${where} must be a positive integer, got ${JSON.stringify(v)}`))

/** Check a note's `hint` (the NoteHint fields except `at`) against the note's pitch and build the stored hint with `at = [tick, durTicks, pitch]`. */
function hintOf(i: number, where: string, v: unknown, at: NoteHint['at']): NoteHint {
  const w = `${where}.hint`
  if (!isObj(v)) return bad(i, `${w} must be an object (fields: ${HINT_FIELDS.join(', ')}) or null`)
  if ('at' in v) bad(i, `${w}: "at" is set by the server from the note's tick, length and pitch; leave it out`)
  for (const k of Object.keys(v)) if (!HINT_FIELDS.includes(k)) bad(i, `${w}: unknown field "${k}" (fields: ${HINT_FIELDS.join(', ')})`)
  if (v.on === undefined) bad(i, `${w}: "on" is required`)
  if (v.len === undefined) bad(i, `${w}: "len" is required`)
  const on = fracOf(i, `${w}.on`, v.on, 'zero'), len = fracOf(i, `${w}.len`, v.len, 'positive')
  const h: NoteHint = { at, on, len }
  if (v.segs != null) {
    if (!Array.isArray(v.segs) || !v.segs.length) return bad(i, `${w}.segs must be a non-empty array of fractions`)
    const segs = v.segs.map((s, k) => fracOf(i, `${w}.segs[${k}]`, s, 'positive'))
    if (!fEq(segs.reduce(fAdd, [0, 1] as Frac), len)) return bad(i, `${w}.segs must add up to len ${JSON.stringify(len)}`)
    h.segs = segs
  }
  if (v.tup != null) {
    if (!isObj(v.tup)) return bad(i, `${w}.tup must be an object {n, of, start, span}`)
    for (const k of Object.keys(v.tup)) if (!['n', 'of', 'start', 'span'].includes(k)) bad(i, `${w}.tup: unknown field "${k}" (fields: n, of, start, span)`)
    h.tup = { n: posInt(i, `${w}.tup.n`, v.tup.n), of: posInt(i, `${w}.tup.of`, v.tup.of), start: fracOf(i, `${w}.tup.start`, v.tup.start, 'zero'), span: fracOf(i, `${w}.tup.span`, v.tup.span, 'positive') }
  }
  if (v.staff != null) h.staff = posInt(i, `${w}.staff`, v.staff)
  if (v.voice != null) h.voice = posInt(i, `${w}.voice`, v.voice)
  if (v.spell != null) {
    const m = typeof v.spell === 'string' ? SPELL.exec(v.spell) : null
    if (!m) return bad(i, `${w}.spell must be a note name like "F#4", "Bb3", "E#5" or "Cbb4", got ${JSON.stringify(v.spell)}`)
    if (12 * (Number(m[3]) + 1) + LETTER_PC[m[1]] + ACC[m[2] ?? ''] !== at[2]) return bad(i, `${w}.spell ${JSON.stringify(v.spell)} does not name the note's pitch ${at[2]} (${noteName(at[2])})`)
    h.spell = v.spell as string
  }
  if (v.art != null) {
    if (typeof v.art !== 'string' || [...v.art].some((c) => !ART_CHARS.includes(c))) return bad(i, `${w}.art must be a string of ${[...ART_CHARS].join(' ')} (> accent, ^ marcato, ' staccato, _ tenuto), got ${JSON.stringify(v.art)}`)
    if (v.art) h.art = v.art
  }
  return h
}

function clefsOf(i: number, v: unknown): ScoreClef[] {
  if (!Array.isArray(v) || !v.length || v.length > 8 || v.some((c) => !CLEFS.includes(c))) return bad(i, `bad clefs ${JSON.stringify(v)}: use 1 to 8 of ${CLEFS.join(', ')} (one per staff, top first), or null to clear`)
  return v as ScoreClef[]
}

/** What an op returned: the id it made or acted on, a list of ids (notes), or null. */
export type OpResult = string | string[] | null

const bad = (i: number, msg: string): never => {
  throw new OpError(i, msg)
}

/** Run a batch on `doc` directly (no atomicity: use `applyAtomic` on a live document). Returns one result per op. */
export function runOps(doc: Y.Doc, ops: Op[]): OpResult[] {
  if (isFutureDoc(doc)) throw new OpError(-1, 'this project was saved by a newer version of mobdaw: it cannot be edited here')
  const results: OpResult[] = []
  ops.forEach((op, i) => {
    results.push(run(doc, i, op, results))
  })
  return results
}

function ref(i: number, v: unknown, results: OpResult[]): string {
  if (typeof v !== 'string') return bad(i, `expected an id, got ${JSON.stringify(v)}`)
  const m = /^\$(\d+)(?:\.(\d+))?$/.exec(v)
  if (!m) return v
  const n = Number(m[1])
  if (n >= i) return bad(i, `"${v}" refers to op ${n}, which has not run yet (only earlier ops)`)
  const r = results[n]
  if (typeof r === 'string') return m[2] === undefined ? r : bad(i, `"${v}": op ${n} made one id, use "$${n}"`)
  if (Array.isArray(r)) return m[2] !== undefined && r[Number(m[2])] ? r[Number(m[2])] : bad(i, `"${v}": op ${n} made ${r.length} ids, use "$${n}.0" to "$${n}.${r.length - 1}"`)
  return bad(i, `"${v}": op ${n} made no id`)
}

const pitchOf = (i: number, v: unknown): number => {
  const p = typeof v === 'number' ? v : typeof v === 'string' ? parseNote(v) : null
  if (p == null || !Number.isInteger(p) || p < 0 || p > 127) return bad(i, `bad pitch ${JSON.stringify(v)}: use a note name like "C4" or "F#3" (C4 = 60), or a number 0..127`)
  return p
}
const velocityOf = (i: number, v: number | undefined): number => {
  if (v === undefined) return 100 / 127
  if (!(v >= 1 && v <= 127)) return bad(i, `bad velocity ${v}: use 1..127 (MIDI)`)
  return Math.round(v) / 127
}

function position(i: number, f: () => number): number {
  try {
    return f()
  } catch (e) {
    if (e instanceof PositionError) return bad(i, e.message)
    throw e
  }
}

function parseMeter(i: number, text: string): { num: number; den: number; groups?: number[] } {
  const m = /^(\d+)\/(\d+)(?:\s*\(?([\d+]+)\)?)?$/.exec(text.trim())
  if (!m) return bad(i, `bad meter ${JSON.stringify(text)}: use "4/4", "7/8", or "7/8 2+2+3"`)
  const num = Number(m[1]), den = Number(m[2])
  if (num < 1 || num > 32 || ![1, 2, 4, 8, 16, 32].includes(den)) return bad(i, `bad meter "${text}": numerator 1..32, denominator 1, 2, 4, 8, 16 or 32`)
  if (!m[3]) return { num, den }
  const groups = m[3].split('+').map(Number)
  if (groups.some((g) => !(g >= 1)) || groups.reduce((a, b) => a + b, 0) !== num) return bad(i, `bad meter groups "${m[3]}": they must add up to ${num}`)
  return { num, den, groups }
}

const bpmOf = (i: number, v: number) => (v >= 1 && v <= 999 ? v : bad(i, `bad bpm ${v}: use 1..999`))

function paramValue(i: number, def: DeviceDef, param: unknown, value: unknown): { id: number; value: number } {
  const p = paramOf(def, param)
  if (!p) return bad(i, `${def.name} has no param ${JSON.stringify(param)} (params: ${def.params.map((x) => x.name).join(', ')})`)
  let v: number
  if (typeof value === 'number' && Number.isFinite(value)) v = value
  else if (typeof value === 'string' && p.options?.some((o) => o.toLowerCase() === value.toLowerCase())) v = p.options.findIndex((o) => o.toLowerCase() === value.toLowerCase())
  else if (typeof value === 'boolean') v = value ? 1 : 0
  else return bad(i, `bad value ${JSON.stringify(value)} for ${p.name} of ${def.name} (${p.options ? `options: ${p.options.join(', ')}` : `${p.min}..${p.max}`})`)
  return { id: p.id, value: Math.min(p.max, Math.max(p.min, v)) }
}

/** The track a `like` names: an id, else a name (exact, then case-insensitive). */
function likeTrack(doc: Y.Doc, ref: string) {
  const ts = getTracks(doc)
  return ts.find((t) => t.id === ref) ?? ts.find((t) => t.name === ref) ?? ts.find((t) => t.name.toLowerCase() === ref.trim().toLowerCase())
}

/** Give track `to` the devices of track `from`: type, name, key range, bypass and every param (the mix device's fader and pan too). */
function copyDevices(doc: Y.Doc, from: string, to: string) {
  const mine = getDevices(doc).filter((d) => d.trackId === from).sort((a, b) => a.order - b.order)
  for (const d of mine) {
    if (d.type === MIX) {
      const mix = ensureMixDevice(doc, to)
      for (const [k, v] of Object.entries(d.params)) setParam(doc, mix, Number(k), v)
      continue
    }
    const id = addDevice(doc, to, d.type, { ...(d.name ? { name: d.name } : {}), ...(d.keyLo != null ? { keyLo: d.keyLo } : {}), ...(d.keyHi != null ? { keyHi: d.keyHi } : {}) }, d.params)
    if (d.bypass) updateDevice(doc, id, { bypass: true })
  }
}

function run(doc: Y.Doc, i: number, op: Op, results: OpResult[]): OpResult {
  const r = (v: unknown) => ref(i, v, results)
  const map = () => getTimeMap(doc)
  const track = (id: unknown) => {
    const t = tracksMap(doc).get(r(id))
    return t ? (t.toJSON() as { id: string; kind: string; name: string }) : bad(i, `no track "${id}"`)
  }
  const clip = (id: unknown) => {
    const c = clipsMap(doc).get(r(id))
    return c ? (c.toJSON() as { id: string; kind: 'midi' | 'audio'; trackId: string; startTick: number; lengthTicks: number; loopTicks?: number; start: number; length: number; loopLength?: number }) : bad(i, `no clip "${id}"`)
  }
  const str = (k: string) => op[k] as string
  const opt = <T>(k: string) => op[k] as T | undefined | null

  switch (op.op) {
    case 'addTrack': {
      const kind = opt<string>('kind') ?? 'midi'
      if (kind !== 'midi' && kind !== 'audio') return bad(i, `bad kind "${kind}": use "midi" or "audio"`)
      const name = str('name').trim().slice(0, 80)
      if (!name) return bad(i, 'name is empty')
      const clefs = opt<unknown>('clefs') == null ? undefined : clefsOf(i, op.clefs)
      if (clefs && kind !== 'midi') return bad(i, 'only midi tracks take clefs')
      let inst = kind === 'midi' ? DEVICES[FINNWAVE] : undefined
      const likeRef = opt<string>('like')
      if (likeRef != null) {
        if (opt<unknown>('preset') != null) return bad(i, '"like" and "preset" are alternatives: give one')
        const src = likeTrack(doc, likeRef)
        if (!src) return bad(i, `like: no track "${likeRef}" (tracks: ${getTracks(doc).map((t) => `"${t.name}"`).join(', ') || 'none'}); use a track's id or name`)
        if (src.kind !== kind) return bad(i, `like: "${src.name}" is a ${src.kind} track, this one is ${kind}`)
        let id = ''
        doc.transact(() => {
          id = addTrack(doc, name, kind, undefined, undefined, src.color)
          copyDevices(doc, src.id, id)
          if (clefs) updateTrack(doc, id, { clefs })
        })
        return id
      }
      const preset = opt<unknown>('preset')
      if (preset != null) {
        if (preset === 'none' || preset === false) inst = undefined
        else {
          inst = deviceType(preset)
          if (!inst?.instrument) return bad(i, `bad preset ${JSON.stringify(preset)}: name an instrument (${Object.values(DEVICES).filter((d) => d.instrument).map((d) => d.name).join(', ')}) or "none"`)
          if (kind !== 'midi') return bad(i, 'only midi tracks take an instrument')
        }
      }
      let id = ''
      doc.transact(() => {
        id = addTrack(doc, name, kind)
        if (clefs) updateTrack(doc, id, { clefs })
        if (inst) addDevice(doc, id, inst.type)
      })
      return id
    }
    case 'updateTrack': {
      const t = track(op.id)
      const patch: Record<string, unknown> = {}
      for (const k of ['name', 'muted', 'soloed', 'color']) if (op[k] !== undefined && op[k] !== null) patch[k] = k === 'name' ? str('name').trim().slice(0, 80) : op[k]
      if (patch.name === '') return bad(i, 'name is empty')
      if (op.clefs !== undefined) {
        if (op.clefs !== null) {
          if (t.kind !== 'midi') return bad(i, 'only midi tracks take clefs')
          patch.clefs = clefsOf(i, op.clefs)
        }
      }
      doc.transact(() => {
        if (op.clefs === null) tracksMap(doc).get(t.id)?.delete('clefs')
        updateTrack(doc, t.id, patch)
      })
      return t.id
    }
    case 'removeTrack': {
      const t = track(op.id)
      deleteTrack(doc, t.id)
      return t.id
    }
    case 'addMidiClip': {
      const t = track(op.trackId)
      if (t.kind !== 'midi') return bad(i, `track "${t.name}" is ${t.kind}: MIDI clips go on midi tracks`)
      const startTick = position(i, () => parsePosition(map(), op.start))
      const lengthTicks = position(i, () => parseDuration(map(), startTick, op.length))
      if (!(lengthTicks > 0)) return bad(i, 'length must be > 0')
      const loop = opt<unknown>('loop')
      const loopTicks = loop == null || loop === 0 ? 0 : position(i, () => parseDuration(map(), startTick, loop))
      if (opt<string>('view') !== undefined && opt<string>('view') !== null && op.view !== 'drums' && op.view !== 'piano') return bad(i, 'view must be "drums" or "piano"')
      return addMidiClip(doc, {
        trackId: t.id, startTick, lengthTicks,
        ...(loopTicks > 0 && loopTicks < lengthTicks ? { loopTicks } : {}), ...(op.view === 'drums' ? { view: 'drums' as const } : {}),
      })
    }
    case 'updateClip': {
      const c = clip(op.id)
      const patch: Record<string, unknown> = {}
      const m = map()
      if (c.kind === 'midi') {
        const startTick = opt<unknown>('start') != null ? position(i, () => parsePosition(m, op.start)) : c.startTick
        if (opt<unknown>('start') != null) patch.startTick = startTick
        if (opt<unknown>('length') != null) {
          const len = position(i, () => parseDuration(m, startTick, op.length))
          if (!(len > 0)) return bad(i, 'length must be > 0')
          patch.lengthTicks = len
        }
        if ('loop' in op && op.loop !== undefined) {
          const len = (patch.lengthTicks as number | undefined) ?? c.lengthTicks
          const loop = op.loop == null || op.loop === 0 ? 0 : position(i, () => parseDuration(m, startTick, op.loop))
          if (loop > 0 && loop < len) patch.loopTicks = loop
          else clipsMap(doc).get(c.id)!.delete('loopTicks')
        }
        if (op.view !== undefined && op.view !== null) {
          if (op.view !== 'drums' && op.view !== 'piano') return bad(i, 'view must be "drums" or "piano"')
          if (op.view === 'drums') patch.view = 'drums'
          else clipsMap(doc).get(c.id)!.delete('view')
        }
      } else {
        if (op.loop !== undefined || op.view != null) return bad(i, 'audio clips can be moved (start, trackId) and resized (length) only')
        const startTick = opt<unknown>('start') != null ? position(i, () => parsePosition(m, op.start)) : m.sampleToTick(c.start)
        if (opt<unknown>('start') != null) patch.start = m.tickToSample(startTick)
        if (opt<unknown>('length') != null) {
          const len = position(i, () => parseDuration(m, startTick, op.length))
          patch.length = m.tickToSample(startTick + len) - m.tickToSample(startTick)
          if (!(patch.length as number > 0)) return bad(i, 'length must be > 0')
        }
      }
      if (op.trackId != null) {
        const t = track(op.trackId)
        if (t.kind !== c.kind) return bad(i, `a ${c.kind} clip cannot move to the ${t.kind} track "${t.name}"`)
        patch.trackId = t.id
      }
      updateClip(doc, c.id, patch)
      return c.id
    }
    case 'removeClip': {
      const c = clip(op.id)
      deleteClip(doc, c.id)
      return c.id
    }
    case 'addNotes': {
      const c = clip(op.clipId)
      if (c.kind !== 'midi') return bad(i, `clip "${c.id}" is an audio clip`)
      const ids: string[] = []
      const m = map()
      doc.transact(() => {
        for (const [j, n] of (op.notes as Record<string, unknown>[]).entries()) {
          const where = `notes[${j}]`
          const pitch = pitchOf(i, n.pitch ?? n.p ?? bad(i, `${where}: "p" (pitch) is required`))
          const tick = position(i, () => parseDuration(m, c.startTick, n.t))
          const dur = position(i, () => parseDuration(m, c.startTick + tick, n.d))
          if (!(dur > 0)) return bad(i, `${where}: d (length) must be > 0`)
          if (tick >= c.lengthTicks) return bad(i, `${where}: t=${tick} is past the end of the clip (${c.lengthTicks} ticks)`)
          const hint = n.hint == null ? undefined : hintOf(i, where, n.hint, [tick, dur, pitch])
          ids.push(addNote(doc, { clipId: c.id, tick, durTicks: dur, pitch, velocity: velocityOf(i, n.v as number | undefined), ...(hint ? { hint } : {}) }))
        }
      })
      return ids
    }
    case 'updateNotes': {
      const ids: string[] = []
      const m = map()
      doc.transact(() => {
        for (const [j, n] of (op.notes as Record<string, unknown>[]).entries()) {
          const id = r(n.id)
          const cur = notesMap(doc).get(id)?.toJSON() as { clipId: string; tick: number; durTicks: number; pitch: number } | undefined
          if (!cur) return bad(i, `notes[${j}]: no note "${id}"`)
          const clipStart = (clipsMap(doc).get(cur.clipId)?.get('startTick') as number | undefined) ?? 0
          const patch: Record<string, unknown> = {}
          if (n.pitch !== undefined || n.p !== undefined) patch.pitch = pitchOf(i, n.pitch ?? n.p)
          if (n.t !== undefined) patch.tick = position(i, () => parseDuration(m, clipStart, n.t))
          if (n.d !== undefined) {
            patch.durTicks = position(i, () => parseDuration(m, clipStart + ((patch.tick as number | undefined) ?? cur.tick), n.d))
            if (!((patch.durTicks as number) > 0)) return bad(i, `notes[${j}]: d (length) must be > 0`)
          }
          if (n.v !== undefined) patch.velocity = velocityOf(i, n.v as number)
          if (n.hint != null) patch.hint = hintOf(i, `notes[${j}]`, n.hint, [(patch.tick as number | undefined) ?? cur.tick, (patch.durTicks as number | undefined) ?? cur.durTicks, (patch.pitch as number | undefined) ?? cur.pitch])
          updateNote(doc, id, patch)
          if (n.hint === null) notesMap(doc).get(id)?.delete('hint')
          ids.push(id)
        }
      })
      return ids
    }
    case 'removeNotes': {
      const ids = (op.ids as unknown[]).map(r)
      for (const id of ids) if (!notesMap(doc).has(id)) return bad(i, `no note "${id}"`)
      doc.transact(() => ids.forEach((id) => deleteNote(doc, id)))
      return ids
    }
    case 'addDevice': {
      const tid = r(op.trackId)
      const def = deviceType(op.type)
      if (!def || def.hidden) return bad(i, `unknown device type ${JSON.stringify(op.type)} (types: ${Object.values(DEVICES).filter((d) => !d.hidden).map((d) => d.name).join(', ')})`)
      if (tid === MASTER_TRACK) {
        if (def.instrument) return bad(i, 'the master bus takes effects only')
      } else {
        const t = track(tid)
        if (def.instrument && t.kind !== 'midi') return bad(i, `${def.name} is an instrument: it goes on a midi track`)
      }
      const extra: { name?: string; keyLo?: number; keyHi?: number } = {}
      if (op.name) extra.name = String(op.name).slice(0, 60)
      if (op.key != null) {
        if (!def.instrument) return bad(i, '"key" is for instruments (a drum plays one key)')
        extra.keyLo = extra.keyHi = pitchOf(i, op.key)
      }
      const initial: Record<string, number> = {}
      for (const [k, v] of Object.entries((op.params as Record<string, unknown> | undefined) ?? {})) {
        const pv = paramValue(i, def, k, v)
        initial[String(pv.id)] = pv.value
      }
      return addDevice(doc, tid, def.type, extra, initial)
    }
    case 'removeDevice': {
      const id = r(op.id)
      const d = devicesMap(doc).get(id)
      if (!d) return bad(i, `no device "${id}"`)
      if (d.get('type') === MIX) return bad(i, 'the mix device (fader and pan) stays with its track')
      deleteDevice(doc, id)
      return id
    }
    case 'setParam': {
      const id = r(op.deviceId)
      const d = devicesMap(doc).get(id)
      if (!d) return bad(i, `no device "${id}"`)
      const pv = paramValue(i, DEVICES[d.get('type') as number], op.param, op.value)
      setParam(doc, id, pv.id, pv.value)
      return id
    }
    case 'addRegion': {
      const bar = Math.round(op.bar as number)
      if (bar < 1) return bad(i, 'bar starts at 1')
      if (opt<number>('free') != null) {
        const secs = op.free as number
        if (!(secs > 0 && secs <= 3600)) return bad(i, 'free: seconds, > 0')
        return addRegion(doc, { bar, kind: 'free', length: Math.round(secs * (doc.getMap('meta').get('sampleRate') as number | undefined ?? 48000)) })
      }
      const here = regionAtBar(doc, bar)
      const base = here.kind === 'metered' ? here : (getRegions(doc).filter((x) => x.kind === 'metered' && x.bar < bar).at(-1) as Extract<Region, { kind: 'metered' }> | undefined)
      const meter = opt<string>('meter') ? parseMeter(i, op.meter as string) : { num: base?.num ?? 4, den: base?.den ?? 4, groups: base?.groups }
      const bpm = opt<number>('bpm') != null ? bpmOf(i, op.bpm as number) : (base?.bpm ?? 120)
      return addRegion(doc, { bar, kind: 'metered', bpm, ...meter, ...(opt<number>('rampTo') != null ? { rampTo: bpmOf(i, op.rampTo as number) } : {}) })
    }
    case 'setRegion': {
      const rs = getRegions(doc)
      const reg = op.id != null ? rs.find((x) => x.id === r(op.id)) : op.bar != null ? rs.find((x) => x.bar === Math.round(op.bar as number)) : bad(i, 'give "id" or "bar"')
      if (!reg) return bad(i, `no region ${op.id != null ? `"${op.id}"` : `starting at bar ${op.bar}`} (regions start at bars ${rs.map((x) => x.bar).join(', ')})`)
      const patch: RegionPatch = {}
      if (opt<number>('free') != null) Object.assign(patch, { kind: 'free', length: Math.round((op.free as number) * (doc.getMap('meta').get('sampleRate') as number | undefined ?? 48000)) })
      else {
        if (reg.kind === 'free' && (op.bpm != null || op.meter)) patch.kind = 'metered'
        if (opt<number>('bpm') != null) patch.bpm = bpmOf(i, op.bpm as number)
        if (opt<string>('meter')) Object.assign(patch, parseMeter(i, op.meter as string), { groups: parseMeter(i, op.meter as string).groups })
        if ('rampTo' in op) patch.rampTo = op.rampTo == null ? undefined : bpmOf(i, op.rampTo as number)
      }
      if (!setRegion(doc, reg.id, patch)) {
        // the default region of a project that never had its timeline edited is implied, not stored: write it out with the change
        const next = { ...reg, ...patch } as Region
        if (next.kind === 'metered' && patch.num != null && patch.groups === undefined && !('groups' in patch)) delete (next as { groups?: number[] }).groups
        const { id: _id, ...fields } = next
        return addRegion(doc, fields as Parameters<typeof addRegion>[1])
      }
      return reg.id
    }
    case 'removeRegion': {
      const rs = getRegions(doc)
      const reg = op.id != null ? rs.find((x) => x.id === r(op.id)) : op.bar != null ? rs.find((x) => x.bar === Math.round(op.bar as number)) : bad(i, 'give "id" or "bar"')
      if (!reg) return bad(i, 'no such region')
      if (!deleteRegion(doc, reg.id)) return bad(i, 'the region at bar 1 cannot be removed (change it with setRegion)')
      return reg.id
    }
    case 'addMarker': {
      const label = str('label').trim().slice(0, 40)
      if (!label) return bad(i, 'label is empty')
      return addMarker(doc, { bar: op.bar as number, label, ...(op.text ? { text: String(op.text).slice(0, 200) } : {}) })
    }
    case 'updateMarker': {
      const id = r(op.id)
      if (!markersMap(doc).has(id)) return bad(i, `no marker "${id}"`)
      updateMarker(doc, id, { ...(op.bar != null ? { bar: op.bar as number } : {}), ...(op.label != null ? { label: String(op.label).slice(0, 40) } : {}), ...('text' in op ? { text: op.text as string } : {}) })
      return id
    }
    case 'removeMarker': {
      const id = r(op.id)
      if (!markersMap(doc).has(id)) return bad(i, `no marker "${id}"`)
      deleteMarker(doc, id)
      return id
    }
    case 'setKey':
      setKey(doc, str('key').trim().slice(0, 40) || undefined)
      return null
  }
  return bad(i, `unknown op "${op.op}"`)
}

/**
 * Run `ops` on a scratch copy of `doc`; if they all work, apply the scratch's change to `doc` (a CRDT merge, so the ids the ops made
 * are the ones that land). If one fails nothing is written. Call inside the transaction that should carry the change.
 */
export function applyAtomic(doc: Y.Doc, ops: Op[]): OpResult[] {
  const scratch = new Y.Doc()
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc))
  const sv = Y.encodeStateVector(scratch)
  const results = runOps(scratch, ops)
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(scratch, sv))
  scratch.destroy()
  return results
}

export type OpsResult = { ids: OpResult[]; seq: number | null }
/**
 * Validate and apply a batch to a project as `user`'s API identity: one transaction, so one history entry, attributed to
 * "<user> (api)" and named `label` (cut to 40 characters) when given. Throws OpError for a bad batch.
 */
export async function applyOps(_ctx: Ctx, collab: Collab, projectId: string, user: { id: number; username: string }, body: { label?: unknown; ops: unknown }): Promise<OpsResult> {
  const ops = parseOps(body.ops)
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  const { value, seq } = await writeAs(collab, projectId, { userId: user.id, username: apiName(user.username), via: 'api' }, label, (doc) => applyAtomic(doc, ops))
  return { ids: value, seq }
}

/** The ops and their conventions, as text (the MCP tool description and `GET /api/agent/catalog` carry it). */
export const OPS_HELP = `Ops are objects {"op": name, ...fields}; a batch runs in order, all or nothing, as ONE history entry (give it a short "label", at most 40 characters).

Conventions
- Positions: "bar.beat.tick" strings ("5", "5.1", "9.3.240": bar and beat start at 1, tick within the beat) or a tick number from bar 1 beat 1. The state shows every position this way and in ticks.
- Lengths (clip length, loop, note t and d): ticks as a number, or text of units: "4 bars", "2 beats", "1 bar 2 beats", "240 ticks". A beat is one 1/den note of the bar's meter (a quarter in 4/4, an eighth in 7/8); ppq (ticks per quarter) is in the state.
- Note t is the tick inside the clip (0 = the clip start), d the length. Pitch: "C4" (middle C = 60), "F#3", "Bb2" or a number 0..127. Velocity v: 1..127 (default 100).
- Ids: use the ids from the state. "$N" in any id field is the id op N (0-based, earlier in the same batch) made: add a track and put a clip on it in one batch. addNotes returns a list: "$N.0", "$N.1" ...
- Every op returns an id (the one it made or changed); the batch result lists them in order.

Ops
- addTrack {name, kind?: "midi"|"audio" (default midi), preset?: instrument name or "none", like?: a track's id or name, clefs?: ["treble","bass",...] one per staff of the score view}: a midi track gets the "finnwave" synth unless preset says otherwise. like copies another track's whole chain (instrument, effects, every param, fader and pan, colour): the way to make a second violin sound like the first. Presets are device TYPES (the instruments in the device list below), not the display names on devices.
- updateTrack {id, name?, muted?, soloed?, color?, clefs? (null clears)}; removeTrack {id} (its clips, notes and devices go too).
- addMidiClip {trackId, start, length, loop?, view?: "drums"|"piano"}: loop is the pattern length that repeats until length ends.
- updateClip {id, start?, length?, trackId?, loop? (0 or null clears), view?}; removeClip {id}.
- addNotes {clipId, notes: [{p|pitch, t, d, v?, hint?}]}; updateNotes {notes: [{id, p?, t?, d?, v?, hint?}]}; removeNotes {ids: []}.
- hint (optional, on a note) is how the note is WRITTEN, so the score view shows it so instead of guessing: {on: [num,den], len: [num,den], segs?: [[n,d],...], tup?: {n, of, start: [n,d], span: [n,d]}, staff?, voice?, spell?: "F#4", art?: ">^'_"}. Hint times are QUARTER NOTES as exact fractions, relative to the clip start (not ticks): a quintuplet sixteenth is len [1,5]. on/len cover the whole tied chain, segs are its written pieces (summing to len), tup the tuplet bracket [start, start+span), staff/voice 1-based, spell must name the note's pitch, art any of > accent ^ marcato ' staccato _ tenuto. Do not send "at": the server sets it from the note's tick, length and pitch. A hint goes stale when the note is later moved, resized or transposed; to keep it, send a new hint with that change. hint: null in updateNotes removes it.
- addDevice {trackId (or "master"), type, name?, key?, params?: {name: value}}: type is a device name (list below). key makes a one-key drum (an instrument that plays only that note, e.g. a lofi drum on key 36).
- removeDevice {id}; setParam {deviceId, param (name), value (number, or an option's name)}: values are clamped to the param's range.
- addRegion {bar, bpm?, meter?: "7/8" or "7/8 2+2+3", rampTo?, free?: seconds}: tempo / meter from that bar on (replaces the region that starts there); what you leave out carries on from before. free makes a one-bar unmetered stretch. setRegion {id|bar, bpm?, meter?, rampTo? (null clears)}; removeRegion {id|bar}.
- addMarker {bar, label, text?}; updateMarker {id, bar?, label?, text?}; removeMarker {id}.
- setKey {key} (display only, e.g. "D minor"; "" clears).

Not available: importing audio, automation, loopers.`
