// The shared change log's data model (docs/spec.md "History"): a patch is the set of entities one transaction changed, as
// before/after JSON. The helpers here read and write a doc's tracked entities as JSON so the server can capture, revert and restore.
import * as Y from 'yjs'
import { metaMap } from './schema.ts'

/** The collections a history entry covers: everything in the undo scope. (`samples`, `chat` and `history` are outside it.) */
export const HISTORY_COLLS = ['meta', 'regions', 'markers', 'tracks', 'clips', 'notes', 'loopers', 'pads', 'devices', 'lanes', 'points'] as const
export type HistoryColl = (typeof HISTORY_COLLS)[number]
/** `meta` is one entity (the whole map) with this id. */
export const META_ID = 'meta'

export type Json = Record<string, unknown>
/** One entity a transaction changed. `before` is null when it was created, `after` is null when it was deleted. */
export type PatchItem = { coll: HistoryColl; id: string; before: Json | null; after: Json | null }
export type Patch = PatchItem[]

export const isHistoryColl = (s: string): s is HistoryColl => (HISTORY_COLLS as readonly string[]).includes(s)
export const collMap = (doc: Y.Doc, coll: HistoryColl) => doc.getMap<Y.Map<unknown>>(coll)

/** The entity's JSON now, or null when it does not exist. */
export function entityJson(doc: Y.Doc, coll: HistoryColl, id: string): Json | null {
  if (coll === 'meta') return metaMap(doc).toJSON()
  const m = collMap(doc, coll).get(id)
  return m instanceof Y.Map ? (m.toJSON() as Json) : null
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => k in b && deepEqual((a as Json)[k], (b as Json)[k]))
}

/**
 * The entity as flat fields: a device's `params` become `params.<id>` keys, so a patch is field-level for them too. Fields that
 * a revert never touches (`meta.schemaVersion`) are left out.
 */
export function fieldsOf(coll: HistoryColl, json: Json | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(json ?? {})) {
    if (coll === 'meta' && k === 'schemaVersion') continue
    if (k === 'params' && v && typeof v === 'object') for (const [p, x] of Object.entries(v)) out[`params.${p}`] = x
    else out[k] = v
  }
  return out
}

/** The field names whose values differ between two entity versions. */
export function changedFields(coll: HistoryColl, before: Json | null, after: Json | null): string[] {
  const a = fieldsOf(coll, before), b = fieldsOf(coll, after)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !deepEqual(a[k], b[k]))
}

/** Set flat fields on an existing entity (`undefined` deletes the field). No-op for an entity that does not exist. */
export function writeFields(doc: Y.Doc, coll: HistoryColl, id: string, fields: Record<string, unknown>) {
  const m = coll === 'meta' ? metaMap(doc) : collMap(doc, coll).get(id)
  if (!(m instanceof Y.Map)) return
  doc.transact(() => {
    for (const [k, v] of Object.entries(fields)) {
      if (k.startsWith('params.')) {
        let params = m.get('params')
        if (!(params instanceof Y.Map)) {
          if (v === undefined) continue
          params = new Y.Map<number>()
          m.set('params', params)
        }
        if (v === undefined) (params as Y.Map<unknown>).delete(k.slice(7))
        else (params as Y.Map<unknown>).set(k.slice(7), v)
      } else if (v === undefined) m.delete(k)
      else m.set(k, v)
    }
  })
}

/** Create an entity from its JSON (a device's `params` become a nested Y.Map, as `addDevice` builds it). */
export function createEntity(doc: Y.Doc, coll: HistoryColl, id: string, json: Json) {
  if (coll === 'meta') return writeFields(doc, coll, id, fieldsOf(coll, json))
  const m = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(json)) {
    if (k === 'params' && v && typeof v === 'object') {
      const params = new Y.Map<unknown>()
      for (const [p, x] of Object.entries(v)) params.set(p, x)
      m.set('params', params)
    } else m.set(k, v)
  }
  doc.transact(() => collMap(doc, coll).set(id, m))
}

/** Delete an entity (the meta entity cannot be deleted). Children are separate entities: callers delete those too. */
export function removeEntity(doc: Y.Doc, coll: HistoryColl, id: string) {
  if (coll !== 'meta') doc.transact(() => collMap(doc, coll).delete(id))
}

/** Make the entity equal `target` (null: gone): fields are patched in place when it exists, so its identity and other writers' merges survive. */
export function setEntity(doc: Y.Doc, coll: HistoryColl, id: string, target: Json | null): boolean {
  const cur = entityJson(doc, coll, id)
  if (target === null) {
    if (cur === null) return false
    removeEntity(doc, coll, id)
    return true
  }
  if (cur === null) return createEntity(doc, coll, id, target), true
  const fields = changedFields(coll, cur, target)
  if (!fields.length) return false
  const want = fieldsOf(coll, target)
  writeFields(doc, coll, id, Object.fromEntries(fields.map((k) => [k, want[k]])))
  return true
}
