// The ruler's edits, without any DOM: parsing and validating what the dialogs ask for, and the doc writes behind the menu
// (each one transaction, so one undo step, and collaborative through the regions / markers maps).
import { addRegion, getRegions, setRegion, type Region } from '@mobdaw/shared'
import type * as Y from 'yjs'

export const BPM_MIN = 20
export const BPM_MAX = 400
export const DENOMINATORS = [1, 2, 4, 8, 16, 32]
export const MAX_NUM = 32
/** A free region's length bounds, in seconds. */
export const FREE_MIN_SEC = 0.1
export const FREE_MAX_SEC = 600

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

export function parseBpm(text: string): Parsed<number> {
  const v = Number(text.trim())
  if (!text.trim() || !Number.isFinite(v)) return fail('tempo: a number of quarter notes per minute')
  if (v < BPM_MIN || v > BPM_MAX) return fail(`tempo: between ${BPM_MIN} and ${BPM_MAX}`)
  return { ok: true, value: v }
}

/** "7/8" -> { num: 7, den: 8 }. */
export function parseMeter(text: string): Parsed<{ num: number; den: number }> {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text)
  if (!m) return fail('meter: like 4/4 or 7/8')
  const num = Number(m[1]), den = Number(m[2])
  if (num < 1 || num > MAX_NUM) return fail(`meter: 1 to ${MAX_NUM} beats`)
  if (!DENOMINATORS.includes(den)) return fail(`meter: the note value is one of ${DENOMINATORS.join(', ')}`)
  return { ok: true, value: { num, den } }
}

/** "2+2+3" -> [2, 2, 3]; empty means the default grouping (undefined). The groups must add up to `num`. */
export function parseGroups(text: string, num: number): Parsed<number[] | undefined> {
  const t = text.trim()
  if (!t) return { ok: true, value: undefined }
  const parts = t.split(/\s*\+\s*/).map(Number)
  if (parts.some((g) => !Number.isInteger(g) || g < 1)) return fail('groups: whole numbers joined by +, like 2+2+3')
  const sum = parts.reduce((a, b) => a + b, 0)
  if (sum !== num) return fail(`groups: ${parts.join('+')} adds up to ${sum}, not ${num}`)
  return { ok: true, value: parts }
}

export type TempoForm = { bpm: number; num: number; den: number; groups?: number[] }
/** All three tempo-dialog fields at once. */
export function parseTempoForm(bpm: string, meter: string, groups: string): Parsed<TempoForm> {
  const b = parseBpm(bpm)
  if (!b.ok) return b
  const m = parseMeter(meter)
  if (!m.ok) return m
  const g = parseGroups(groups, m.value.num)
  if (!g.ok) return g
  return { ok: true, value: { bpm: b.value, ...m.value, ...(g.value ? { groups: g.value } : {}) } }
}

/** A free region's length from the dialog's seconds, in samples. */
export function parseFreeSeconds(text: string, rate: number): Parsed<number> {
  const v = Number(text.trim())
  if (!text.trim() || !Number.isFinite(v)) return fail('length: a number of seconds')
  if (v < FREE_MIN_SEC || v > FREE_MAX_SEC) return fail(`length: between ${FREE_MIN_SEC} and ${FREE_MAX_SEC} seconds`)
  return { ok: true, value: Math.round(v * rate) }
}

export const parseMarkerLabel = (text: string): Parsed<string> => (text.trim() ? { ok: true, value: text.trim().slice(0, 40) } : fail('label: a short name, like A or Verse 2'))

/** The region in effect at a bar (the last one starting at or before it). */
export const regionAt = (regions: readonly Region[], bar: number): Region => regions.filter((r) => r.bar <= bar).at(-1) ?? regions[0]

/** What "ramp to next" does at a bar: add one, remove the one there, or nothing (with the reason). */
export type RampOption = { kind: 'add' | 'remove'; regionId: string; to: number } | { kind: 'none'; reason: string }
export function rampOption(regions: readonly Region[], bar: number): RampOption {
  const r = regionAt(regions, bar)
  if (r.kind === 'free') return { kind: 'none', reason: 'a free region has no tempo' }
  const next = regions[regions.indexOf(r) + 1]
  if (!next) return { kind: 'none', reason: 'there is no later region to ramp to' }
  if (next.kind === 'free') return { kind: 'none', reason: 'the next region is free' }
  if (r.rampTo != null) return { kind: 'remove', regionId: r.id, to: r.rampTo }
  if (next.bpm === r.bpm) return { kind: 'none', reason: 'the next region has the same tempo' }
  return { kind: 'add', regionId: r.id, to: next.bpm }
}

// --- doc writes (one transaction each)

/** Tempo and meter from `bar` on (until the next region): a new region there, or the one starting there changed. A ramp already on it stays. */
export function setTempoHere(doc: Y.Doc, bar: number, f: TempoForm) {
  const here = getRegions(doc).find((r) => r.bar === bar)
  const rampTo = here?.kind === 'metered' ? here.rampTo : undefined
  return addRegion(doc, { bar, kind: 'metered', bpm: f.bpm, num: f.num, den: f.den, ...(f.groups ? { groups: f.groups } : {}), ...(rampTo != null && rampTo !== f.bpm ? { rampTo } : {}) })
}

/** A free region of `samples` at `bar`. */
export const setFreeHere = (doc: Y.Doc, bar: number, samples: number) => addRegion(doc, { bar, kind: 'free', length: samples })

/** Toggle the ramp of the region in effect at `bar` (to the next region's tempo). Returns what happened. */
export function toggleRamp(doc: Y.Doc, bar: number): RampOption {
  const o = rampOption(getRegions(doc), bar)
  if (o.kind === 'add') setRegion(doc, o.regionId, { rampTo: o.to })
  else if (o.kind === 'remove') setRegion(doc, o.regionId, { rampTo: undefined })
  return o
}
