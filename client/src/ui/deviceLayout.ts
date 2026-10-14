// How a device card arranges its params: knobs in titled sections on a grid. Known devices name their sections; any other
// device (a new synth, say) falls back to a generic split, so adding a device needs no layout code.
import { COMPRESSOR, DELAY, EQ, FINNWAVE, LOFI_DRUM, REVERB, SIMPLE_FILTER, TREMOLO, type DeviceDef, type ParamDef } from '@mobdaw/shared'

export type Section = { title: string; params: ParamDef[] }

/** Param ids per section, in display order, for the devices whose params fall into musical groups. */
const SECTIONS: Record<number, [string, number[]][]> = {
  [FINNWAVE]: [['tone', [0, 1]], ['envelope', [2, 3, 4, 5]], ['output', [6]]],
  [LOFI_DRUM]: [['filter', [0, 1]], ['voice', [2, 3]]],
  [COMPRESSOR]: [['detector', [0, 1]], ['timing', [2, 3]], ['output', [4]]],
  [DELAY]: [['delay', [0, 1, 2]], ['tape', [3, 4]], ['filter', [5, 6, 7]]],
  [REVERB]: [['reverb', [0, 1, 2, 3]]],
  [TREMOLO]: [['tremolo', [0, 1, 2, 3]]],
  [SIMPLE_FILTER]: [['', [0, 1, 2, 3]]],
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

export function sections(def: DeviceDef): Section[] {
  const known = SECTIONS[def.type]
  if (known) {
    const by = new Map(def.params.map((p) => [p.id, p]))
    const out = known.map(([title, ids]) => ({ title, params: ids.flatMap((id) => by.get(id) ?? []) }))
    const rest = def.params.filter((p) => !known.some(([, ids]) => ids.includes(p.id)))
    if (rest.length) out.push({ title: '', params: rest })
    return out.filter((s) => s.params.length)
  }
  if (def.type === EQ) return byPrefix(def.params) ?? [{ title: '', params: def.params }]
  const prefixed = byPrefix(def.params)
  if (prefixed) return prefixed
  // generic: envelope params together, output-ish ones last, everything else first, in definition order
  const env = def.params.filter((p) => ENV.includes(p.name))
  const out = def.params.filter((p) => OUT.includes(p.name) && !env.includes(p))
  const rest = def.params.filter((p) => !env.includes(p) && !out.includes(p))
  const all: Section[] = def.params.length <= 4 ? [{ title: '', params: def.params }] : [
    { title: def.instrument ? 'sound' : '', params: rest }, { title: 'envelope', params: env }, { title: 'output', params: out },
  ]
  return all.filter((s) => s.params.length)
}

/** Columns for a section of n cells: one row up to 4, otherwise two balanced rows (three at most per row past 8). */
export const columns = (n: number) => (n <= 4 ? Math.max(1, n) : Math.ceil(n / (n > 8 ? 3 : 2)))
