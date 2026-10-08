// Automatable parameters. A `ParamTarget` addresses one by stable ids; the registry resolves it to a
// definition (label, range, scale) shared by the UI (menus, axes, value labels) and the engine (denormalising points).
//   scope  a track id, or MASTER_TRACK for the global fx chain      ("track[i]" / "track[-1]")
//   kind   'synth' | 'effect' (a device on the chain) or 'looper'   (".synth[j]" / ".effect[j]" / ".looper[j]")
//   owner  the device or looper id
//   param  device: ParamDef.id as a string; looper: a field name of LOOPER_PARAMS
import type * as Y from 'yjs'
import { DEVICES, paramToPos, paramToValue, type ParamDef } from './devices.ts'
import { LOOP_CUTOFF_MAX, LOOP_CUTOFF_MIN, LOOP_SPEED_MAX, LOOP_SPEED_MIN, devicesMap, loopersMap, type AutoCurve, type Looper } from './schema.ts'

export type ParamKind = 'synth' | 'effect' | 'looper'
export type ParamTarget = { scope: string; kind: ParamKind; owner: string; param: string }

/** Looper params; `id` is the engine's code (engine.rs `LOOPER_*`) and `key` the field on `Looper`. */
export type LooperParamDef = ParamDef & { key: 'gain' | 'speed' | 'sat' | 'cutoff' | 'warble' }
export const LOOPER_PARAMS: LooperParamDef[] = [
  { id: 0, key: 'gain', name: 'volume', min: 0, max: 1, def: 1, scale: 'lin' },
  { id: 1, key: 'speed', name: 'speed', min: LOOP_SPEED_MIN, max: LOOP_SPEED_MAX, def: 1, scale: 'log', unit: '×' },
  { id: 2, key: 'sat', name: 'saturate', min: 0, max: 1, def: 0, scale: 'lin' },
  { id: 3, key: 'cutoff', name: 'filter', min: LOOP_CUTOFF_MIN, max: LOOP_CUTOFF_MAX, def: LOOP_CUTOFF_MAX, scale: 'log', unit: 'Hz' },
  { id: 4, key: 'warble', name: 'warble', min: 0, max: 1, def: 0, scale: 'lin' },
]

export const targetKey = (t: ParamTarget) => `${t.scope}/${t.kind}/${t.owner}/${t.param}`
export const sameTarget = (a: ParamTarget, b: ParamTarget) => targetKey(a) === targetKey(b)

/** The definition behind a device param target (`kind` 'synth' | 'effect'), given the device's `type`. */
export const deviceParamDef = (type: number, param: string): ParamDef | undefined => DEVICES[type]?.params.find((p) => String(p.id) === param)
export const looperParamDef = (param: string): LooperParamDef | undefined => LOOPER_PARAMS.find((p) => p.key === param)

/** Engine scale code (engine.rs `Scale`). */
export const SCALE_CODE = { lin: 0, log: 1, pow: 2 } as const

export { paramToPos, paramToValue }
export type { ParamDef }

/** A target resolved against the doc: the definition, a display name, and the param's static (un-automated) value. */
export type ResolvedParam = { def: ParamDef; owner: string; label: string; value: number }

/** Where `t` points, or null when its device/looper is gone or the param is unknown. */
export function resolveTarget(doc: Y.Doc, t: ParamTarget): ResolvedParam | null {
  if (t.kind === 'looper') {
    const lp = loopersMap(doc).get(t.owner)?.toJSON() as Looper | undefined
    const def = looperParamDef(t.param)
    if (!lp || !def) return null
    return { def, owner: `loop ${lp.slot + 1}`, label: def.name, value: (lp[def.key] as number | undefined) ?? def.def }
  }
  const dev = devicesMap(doc).get(t.owner)
  const type = dev?.get('type') as number | undefined
  const def = type != null ? deviceParamDef(type, t.param) : undefined
  if (!dev || type == null || !def) return null
  const v = (dev.get('params') as Y.Map<number> | undefined)?.get(t.param)
  return { def, owner: DEVICES[type].name, label: def.name, value: typeof v === 'number' ? v : def.def }
}

/**
 * The normalised value (0..1) of a lane's points (sorted by `pos`) at `pos`, or null when there are none.
 * Before the first point and after the last the lane holds that point's value; between two, the left point's curve decides.
 * Mirrors engine.rs `Lane::value_at`.
 */
export function evalPoints(points: readonly { pos: number; value: number; curve: AutoCurve }[], pos: number): number | null {
  if (points.length === 0) return null
  let lo = 0, hi = points.length // first point with p.pos > pos
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].pos > pos) hi = mid
    else lo = mid + 1
  }
  if (lo === 0) return points[0].value
  const a = points[lo - 1]
  const b = points[lo]
  if (!b || a.curve === 'hold') return a.value
  return a.value + (b.value - a.value) * ((pos - a.pos) / (b.pos - a.pos))
}
