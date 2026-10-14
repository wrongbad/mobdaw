// How a device card arranges its params: knobs in titled sections on a grid. Known devices name their sections; any other
// device (a new synth, say) falls back to a generic split, so adding a device needs no layout code.
import { BORE, COMPRESSOR, DELAY, EQ, FINNWAVE, LOFI_DRUM, REVERB, SIMPLE_FILTER, TREMOLO, type DeviceDef, type ParamDef } from '@mobdaw/shared'

/** One justified row of cells (knobs and selectors); `title` captions it (only the first row of a section has one). */
export type Row = { title: string; params: ParamDef[] }

/** Explicit rows (param ids) per known device; selectors are given their own rows. Anything unlisted falls to the generic rule. */
const ROWS: Record<number, [string, number[]][]> = {
  [SIMPLE_FILTER]: [['', [0]], ['', [1, 2, 3]]],
  [FINNWAVE]: [['tone / output', [0, 1, 6]], ['envelope', [2, 3, 4, 5]]],
  [BORE]: [['voice', [0, 1, 2]], ['', [4]], ['bore', [3, 5, 6]], ['breath', [7, 8, 13]], ['vibrato', [9, 10]], ['envelope', [11, 12]]],
  [LOFI_DRUM]: [['filter', [0, 1]], ['voice', [2, 3]]],
  [COMPRESSOR]: [['detector', [0, 1]], ['timing', [2, 3]], ['output', [4]]],
  [DELAY]: [['delay', [0, 1, 2]], ['filter', [5]], ['', [6, 7]], ['tape', [3, 4]]],
  [REVERB]: [['reverb', [0, 1]], ['', [2, 3]]],
  [TREMOLO]: [['', [2]], ['tremolo', [0, 1, 3]]],
}

const ENV = ['attack', 'decay', 'sustain', 'release', 'hold']
const OUT = ['gain', 'output', 'volume', 'level', 'makeup', 'mix']

/** Groups params whose names share a leading word ("low freq", "low gain": the EQ bands), in order. */
function byPrefix(params: ParamDef[]): Section[] | null {
  const out: Section[] = []
  for (const p of params) {
    const i = p.name.lastIndexOf(' ')
    const key = i > 0 ? p.name.slice(0, i) : ''
    const last = out[out.length - 1]
    if (last && last.title === key) last.params.push(p)
    else out.push({ title: key, params: [p] })
  }
  const named = out.filter((s) => s.title && s.params.length > 1)
  return named.length >= 2 ? out.map((s) => (s.params.length === 1 && !s.title ? { ...s, title: '' } : s)) : null
}

/** Split a group into balanced rows of at most 3 knob widths (4 only for an ADSR-style envelope), so cards stay near square. */
function chunk(title: string, params: ParamDef[]): Row[] {
  const units = params.reduce((n, p) => n + span(p), 0)
  const max = params.every((p) => ENV.includes(p.name)) ? 4 : 3
  const rows = Math.ceil(units / max)
  const per = Math.ceil(units / rows)
  const out: Row[] = []
  let cur: ParamDef[] = [], w = 0
  for (const p of params) {
    if (cur.length && w + span(p) > per) { out.push({ title: '', params: cur }); cur = []; w = 0 }
    cur.push(p); w += span(p)
  }
  if (cur.length) out.push({ title: '', params: cur })
  out[0].title = title
  return out
}

export function rows(def: DeviceDef): Row[] {
  const known = ROWS[def.type]
  if (known) {
    const by = new Map(def.params.map((p) => [p.id, p]))
    const out = known.map(([title, ids]) => ({ title, params: ids.flatMap((id) => by.get(id) ?? []) }))
    const rest = def.params.filter((p) => !known.some(([, ids]) => ids.includes(p.id)))
    return [...out, ...(rest.length ? chunk('', rest) : [])].filter((r) => r.params.length)
  }
  // generic: selectors first (packed into rows), then each group as justified rows
  const sel = def.params.filter((p) => p.options)
  const knobs = def.params.filter((p) => !p.options)
  const groups: Section[] = def.type === EQ ? (byPrefix(knobs) ?? [{ title: '', params: knobs }]) : (byPrefix(knobs) ?? envOut(def, knobs))
  return [...(sel.length ? chunk('', sel) : []), ...groups.flatMap((g) => chunk(g.title, g.params))].filter((r) => r.params.length)
}

type Section = { title: string; params: ParamDef[] }
function envOut(def: DeviceDef, knobs: ParamDef[]): Section[] {
  const env = knobs.filter((p) => ENV.includes(p.name))
  const out = knobs.filter((p) => OUT.includes(p.name) && !env.includes(p))
  const rest = knobs.filter((p) => !env.includes(p) && !out.includes(p))
  if (knobs.length <= 4) return [{ title: '', params: knobs }]
  return [{ title: def.instrument ? 'sound' : '', params: rest }, { title: 'envelope', params: env }, { title: 'output', params: out }].filter((s) => s.params.length)
}

/** How many knob widths a param's cell takes: a knob 1; a radio selector 2 (two options) or 3; a drop-down 2. */
export const SEG_MAX = 4
export const span = (p: ParamDef) => (!p.options ? 1 : p.options.length <= SEG_MAX ? (p.options.length <= 2 ? 2 : 3) : 2)

