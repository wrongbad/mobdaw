// A history entry's one-line description (docs/spec.md "History"): what a transaction's patch did, in at most 40 characters.
import { DEVICES, MIX } from './devices.ts'
import { MASTER_TRACK } from './schema.ts'
import { changedFields, type HistoryColl, type Json, type Patch, type PatchItem } from './history.ts'

export const DESCRIBE_MAX = 40
/** Cut to `n` characters, ending in an ellipsis when something was left out. */
export const cut = (s: string, n = DESCRIBE_MAX) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`)

/** Entities that are not in the patch (a note's clip, a clip's track) are read from here: their current JSON, or undefined. */
export type Lookup = (coll: HistoryColl, id: string) => Json | undefined

const WORD: Record<HistoryColl, string> = {
  meta: 'setting', regions: 'tempo region', markers: 'marker', tracks: 'track', clips: 'clip', notes: 'note',
  loopers: 'looper', pads: 'pad', devices: 'device', lanes: 'automation lane', points: 'automation point',
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : w.endsWith('s') ? 'es' : 's'}`
const fmt = (v: unknown, dp = true) => {
  const x = Number(v)
  if (!Number.isFinite(x)) return String(v)
  return Math.abs(x) >= 100 || !dp ? String(Math.round(x * 100) / 100) : x.toFixed(2)
}
/** `was→now`: whole numbers stay whole (a mode switch), anything else shows two decimals (0.32→0.50). */
const arrow = (was: unknown, now: unknown) => {
  const whole = Number.isInteger(Number(was)) && Number.isInteger(Number(now))
  return `${fmt(was, !whole)}→${fmt(now, !whole)}`
}
/** A whole number (bars, tempo) without decimals. */
const int = (v: unknown) => String(+Number(v).toFixed(2))
const nm = (s: unknown, n = 14) => cut(String(s ?? '?'), n)
const subset = (fields: string[], allowed: string[]) => fields.length > 0 && fields.every((f) => allowed.includes(f))

/**
 * Describe one transaction's patch. `lookup` resolves entities outside the patch (names via a note's clip and the clip's track).
 * The result is at most `DESCRIBE_MAX` characters.
 */
export function describe(patch: Patch, lookup: Lookup = () => undefined): string {
  if (!patch.length) return 'no change'
  const get = (coll: HistoryColl, id: unknown): Json | undefined => {
    const it = patch.find((p) => p.coll === coll && p.id === id)
    return it ? (it.after ?? it.before ?? undefined) : typeof id === 'string' ? lookup(coll, id) : undefined
  }
  const trackName = (id: unknown) => (id === MASTER_TRACK ? 'master' : (get('tracks', id)?.name as string | undefined))
  const clipTrack = (clipId: unknown) => trackName(get('clips', clipId)?.trackId)
  const of = (c: HistoryColl) => patch.filter((p) => p.coll === c)
  const added = (l: PatchItem[]) => l.filter((p) => p.before === null)
  const removed = (l: PatchItem[]) => l.filter((p) => p.after === null)
  const edited = (l: PatchItem[]) => l.filter((p) => p.before !== null && p.after !== null)
  const fieldsOfAll = (l: PatchItem[]) => [...new Set(l.flatMap((p) => changedFields(p.coll, p.before, p.after)))]
  const same = (ts: (string | undefined)[]) => (ts.length && ts.every((t) => t === ts[0]) ? ts[0] : undefined)
  const generic = (c: HistoryColl, l: PatchItem[]) => `${l.every((p) => p.before === null) ? 'added' : l.every((p) => p.after === null) ? 'deleted' : 'edited'} ${plural(l.length, WORD[c])}`

  const meta = of('meta')[0]
  if (meta && meta.before?.schemaVersion !== meta.after?.schemaVersion) return 'migrated project'

  const describers: Partial<Record<HistoryColl, (l: PatchItem[]) => string | null>> = {
    tracks(l) {
      const [a, r, e] = [added(l), removed(l), edited(l)]
      if (l.length === 1 && a.length) return `added track ${nm(a[0].after!.name)}`
      if (l.length === 1 && r.length) return `deleted track ${nm(r[0].before!.name)}`
      if (a.length === l.length) return `added ${plural(a.length, 'track')}`
      if (r.length === l.length) return `deleted ${plural(r.length, 'track')}`
      if (e.length === l.length) {
        const f = fieldsOfAll(e), t = e[0].after!
        if (e.length === 1) {
          if (subset(f, ['name'])) return `renamed track ${nm(t.name, 24)}`
          if (subset(f, ['muted'])) return `${t.muted ? 'muted' : 'unmuted'} ${nm(t.name, 24)}`
          if (subset(f, ['soloed'])) return `${t.soloed ? 'soloed' : 'unsoloed'} ${nm(t.name, 24)}`
          if (subset(f, ['order'])) return `moved track ${nm(t.name, 24)}`
          return `edited track ${nm(t.name, 24)}`
        }
        if (subset(f, ['order'])) return 'reordered tracks'
      }
      return generic('tracks', l)
    },
    regions(l) {
      const [a, r, e] = [added(l), removed(l), edited(l)]
      const free = a.find((p) => p.after!.kind === 'free')
      if (free) return `added free bar at bar ${int(free.after!.bar)}`
      if (l.length === 1 && a.length) return `added tempo ${int(a[0].after!.bpm)} at bar ${int(a[0].after!.bar)}`
      if (l.length === 1 && r.length) return `removed tempo at bar ${int(r[0].before!.bar)}`
      if (l.length === 1 && e.length) {
        const { before: b, after: t } = e[0], f = fieldsOf1(e[0]), bar = int(t!.bar)
        if (subset(f, ['bpm'])) return `tempo ${int(b!.bpm)}→${int(t!.bpm)} at bar ${bar}`
        if (subset(f, ['rampTo'])) return `tempo ramp to ${int(t!.rampTo)} at bar ${bar}`
        if (subset(f, ['num', 'den', 'groups'])) return `meter ${t!.num}/${t!.den} at bar ${bar}`
        if (subset(f, ['length'])) return `free bar length at bar ${bar}`
        return `edited tempo at bar ${bar}`
      }
      return generic('regions', l)
    },
    markers(l) {
      const m = (l[0].after ?? l[0].before)!
      if (l.length !== 1) return generic('markers', l)
      if (l[0].before === null) return `added marker ${nm(m.label, 10)} at bar ${int(m.bar)}`
      if (l[0].after === null) return `deleted marker ${nm(m.label, 20)}`
      const f = fieldsOf1(l[0])
      if (subset(f, ['label'])) return `renamed marker ${nm(l[0].before!.label, 9)}→${nm(m.label, 9)}`
      if (subset(f, ['bar'])) return `moved marker ${nm(m.label, 10)} to bar ${int(m.bar)}`
      return `edited marker ${nm(m.label, 20)}`
    },
    clips(l) {
      const [a, r, e] = [added(l), removed(l), edited(l)]
      const tn = same(l.map((p) => trackName((p.after ?? p.before)!.trackId)))
      if (a.length === l.length) return l.length === 1 && tn ? `added clip to ${nm(tn, 20)}` : `added ${plural(l.length, 'clip')}`
      if (r.length === l.length) return l.length === 1 && tn ? `deleted clip from ${nm(tn, 20)}` : `deleted ${plural(l.length, 'clip')}`
      if (e.length === l.length) {
        const f = fieldsOfAll(e)
        const many = l.length === 1 ? (tn ? `clip on ${nm(tn, 18)}` : 'clip') : plural(l.length, 'clip')
        if (subset(f, ['startTick', 'start', 'trackId'])) return `moved ${many}`
        if (subset(f, ['lengthTicks', 'length', 'loopTicks', 'loopLength', 'loopPhase', 'forever', 'sourceOffset', 'fadeIn', 'fadeOut'])) return `resized ${many}`
        if (subset(f, ['gain'])) return `${l.length === 1 ? 'clip' : plural(l.length, 'clip')} gain`
        return `edited ${many}`
      }
      return generic('clips', l)
    },
    notes(l) {
      const [a, r, e] = [added(l), removed(l), edited(l)]
      const tn = same(l.map((p) => clipTrack((p.after ?? p.before)!.clipId)))
      if (a.length === l.length) return `added ${plural(l.length, 'note')}${tn ? ` to ${nm(tn, 14)}` : ''}`
      if (r.length === l.length) return `deleted ${plural(l.length, 'note')}${tn ? ` from ${nm(tn, 12)}` : ''}`
      if (e.length === l.length) {
        const f = fieldsOfAll(e)
        if (subset(f, ['pitch'])) return `transposed ${plural(l.length, 'note')}`
        if (subset(f, ['tick', 'pitch', 'clipId'])) return `moved ${plural(l.length, 'note')}`
        if (subset(f, ['durTicks'])) return `resized ${plural(l.length, 'note')}`
        if (subset(f, ['velocity'])) return `velocity of ${plural(l.length, 'note')}`
      }
      return generic('notes', l)
    },
    devices(l) {
      const devName = (d: Json) => (d.type === MIX ? `${nm(trackName(d.trackId) ?? 'mix', 12)}` : nm(d.name ?? DEVICES[d.type as number]?.name ?? 'device', 14))
      const [a, r, e] = [added(l), removed(l), edited(l)]
      if (a.length === l.length && l.length === 1) return `added ${devName(a[0].after!)} to ${nm(trackName(a[0].after!.trackId) ?? 'track', 14)}`
      if (r.length === l.length && l.length === 1) return `removed ${devName(r[0].before!)} from ${nm(trackName(r[0].before!.trackId) ?? 'track', 10)}`
      if (e.length === 1 && l.length === 1) {
        const d = e[0].after!, f = fieldsOfAll(e), params = f.filter((k) => k.startsWith('params.'))
        if (f.length === 1 && params.length === 1) {
          const id = params[0].slice(7)
          const label = d.type === MIX ? (DEVICES[MIX].params.find((p) => String(p.id) === id)?.name ?? id) : (DEVICES[d.type as number]?.params.find((p) => String(p.id) === id)?.name ?? `p${id}`)
          const was = (e[0].before!.params as Json)?.[id], now = (d.params as Json)?.[id]
          return cut(`${devName(d)} ${label} ${arrow(was, now)}`)
        }
        if (subset(f, ['bypass'])) return `${d.bypass ? 'bypassed' : 'enabled'} ${devName(d)}`
        if (params.length > 1 && params.length === f.length) return `edited ${devName(d)} (${params.length} params)`
        return `edited ${devName(d)}`
      }
      return generic('devices', l)
    },
    lanes(l) {
      if (l.length === 1 && edited(l).length) {
        const f = fieldsOf1(l[0])
        if (subset(f, ['enabled'])) return `automation ${l[0].after!.enabled ? 'on' : 'off'}`
      }
      return generic('lanes', l)
    },
    points(l) {
      if (edited(l).length === l.length && subset(fieldsOfAll(l), ['pos', 'value', 'curve'])) return `moved ${plural(l.length, 'automation point')}`
      return generic('points', l)
    },
    loopers(l) {
      if (l.length === 1 && edited(l).length) {
        const f = fieldsOf1(l[0])
        if (f.length === 1 && typeof l[0].after![f[0]] === 'number') return `looper ${f[0]} ${arrow(l[0].before![f[0]] ?? '?', l[0].after![f[0]])}`
      }
      return generic('loopers', l)
    },
    pads(l) {
      if (edited(l).length === l.length) return subset(fieldsOfAll(l), ['start']) ? `moved ${plural(l.length, 'pad')}` : generic('pads', l)
      return generic('pads', l)
    },
    meta(l) {
      const f = fieldsOfAll(l)
      if (subset(f, ['key'])) return l[0].after!.key ? `key ${nm(l[0].after!.key, 30)}` : 'cleared the key'
      return 'edited project settings'
    },
  }

  const order: HistoryColl[] = ['tracks', 'regions', 'markers', 'clips', 'notes', 'devices', 'lanes', 'points', 'loopers', 'pads', 'meta']
  // a clip that only changed because its notes did (a drag past its end) is the notes' story
  if (of('notes').length && of('clips').length && edited(of('clips')).length === of('clips').length) order.splice(order.indexOf('notes'), 1), order.splice(order.indexOf('clips'), 0, 'notes')
  for (const c of order) {
    const l = of(c).filter((p) => !(c === 'meta' && !changedFields('meta', p.before, p.after).length))
    if (!l.length) continue
    const s = describers[c]?.(l)
    if (s) return cut(s)
  }
  return cut(`edited ${patch.length} entities`)
}

const fieldsOf1 = (p: PatchItem) => changedFields(p.coll, p.before, p.after)
