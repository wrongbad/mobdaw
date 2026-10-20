// The shared change log (docs/spec.md "History"). Every loaded project document gets a JSON mirror of its tracked entities; each
// transaction is diffed against it into a patch, which becomes one attributed entry: a row in SQLite (the patch, for revert and
// restore) and a one-line summary appended to the doc's `history` array (so it syncs live like chat). Revert and restore write
// through a direct connection, so they are entries of their own.
import { isTransactionOrigin, type Hocuspocus } from '@hocuspocus/server'
import type * as Y from 'yjs'
import {
  HISTORY_COLLS, HISTORY_MAX, META_ID, SYSTEM_USER, changedFields, collMap, cut, deepEqual, describe, docName, entityJson, fieldsOf,
  historyLog, metaMap, removeEntity, setEntity, userColor, writeFields, createEntity,
  type HistoryColl, type HistoryEntry, type HistoryItem, type HistoryResult, type HistorySkip, type Json, type Patch,
} from '@mobdaw/shared'
import type { Ctx } from './auth.ts'

/** Origin of the server's own summary appends: the capture ignores them, so the log never records itself. */
export const HISTORY_ORIGIN = { source: 'local', context: { via: 'history' } } as const

/** Who made a change. `via`: 'ws' (a live editor), 'ui' (revert / restore from the history panel), 'api' (the agent API), 'system'. */
export type Who = { userId: number | null; username: string; via: string }
type State = {
  projectId: string
  mirror: Map<HistoryColl, Map<string, Json>>
  next: number
  /** The seq of the last entry written (0: none). */
  last: number
}
const states = new WeakMap<Y.Doc, State>()

const SUMMARY_TRIM_AT = HISTORY_MAX + 100

function actor(origin: unknown): Who & { label?: string } {
  if (isTransactionOrigin(origin)) {
    const c = (origin.source === 'connection' ? origin.connection.context : origin.source === 'local' ? origin.context : undefined) as
      | { userId?: number; username?: string; via?: string; label?: string } | undefined
    if (c?.username) return { userId: c.userId ?? null, username: c.username, via: c.via ?? (origin.source === 'connection' ? 'ws' : 'system'), label: c.label }
  }
  return { userId: null, username: SYSTEM_USER, via: 'system' }
}

/** The entities a transaction touched, as collection -> ids (walking each changed type up to the entity map it lives in). */
function touched(doc: Y.Doc, tr: Y.Transaction): Map<HistoryColl, Set<string>> {
  const tops = new Map<unknown, HistoryColl>(HISTORY_COLLS.map((c) => [c === 'meta' ? metaMap(doc) : collMap(doc, c), c]))
  const out = new Map<HistoryColl, Set<string>>()
  const add = (c: HistoryColl, id: string) => out.set(c, (out.get(c) ?? new Set()).add(id))
  for (const [type, keys] of tr.changed) {
    const top = tops.get(type)
    if (top) {
      if (top === 'meta') add('meta', META_ID)
      else for (const k of keys) if (k !== null) add(top, k)
      continue
    }
    let t = type as unknown as { _item: { parent: unknown; parentSub: string | null } | null }
    while (t._item) {
      const parent = t._item.parent
      const c = tops.get(parent)
      if (c) {
        if (c === 'meta') add('meta', META_ID)
        else if (t._item.parentSub != null) add(c, t._item.parentSub)
        break
      }
      t = parent as typeof t
    }
  }
  return out
}

const summary = (seq: number, who: Who, text: string, ts: number): HistoryEntry => ({
  seq, username: who.username, color: userColor(who.username), text, ts, ...(who.via === 'api' ? { api: true } : {}),
})

function capture(ctx: Ctx, doc: Y.Doc, st: State, tr: Y.Transaction) {
  if (tr.origin === HISTORY_ORIGIN) return
  const ids = touched(doc, tr)
  if (!ids.size) return
  const patch: Patch = []
  for (const [coll, set] of ids) {
    const mirror = st.mirror.get(coll)!
    for (const id of set) {
      const before = mirror.get(id) ?? null
      const after = entityJson(doc, coll, id)
      if (deepEqual(before, after)) continue
      patch.push({ coll, id, before, after })
      if (after) mirror.set(id, after)
      else mirror.delete(id)
    }
  }
  if (!patch.length) return
  const who = actor(tr.origin)
  const text = who.label?.trim() ? cut(who.label.trim()) : describe(patch, (c, id) => st.mirror.get(c)?.get(id))
  const seq = st.next++
  const ts = Date.now()
  // synchronous on purpose: an entry that is in the log is also in SQLite (docs/todo.md)
  ctx.db.prepare('INSERT INTO history(project_id, seq, ts, user_id, username, via, label, patch) VALUES(?,?,?,?,?,?,?,?)')
    .run(st.projectId, seq, ts, who.userId, who.username, who.via, text, JSON.stringify(patch))
  ctx.db.prepare('DELETE FROM history WHERE project_id = ? AND seq <= ?').run(st.projectId, seq - HISTORY_MAX)
  st.last = seq
  appendSummaries(doc, [summary(seq, who, text, ts)])
}

function appendSummaries(doc: Y.Doc, entries: HistoryEntry[]) {
  const log = historyLog(doc)
  doc.transact(() => {
    log.push(entries)
    if (log.length > SUMMARY_TRIM_AT) log.delete(0, log.length - HISTORY_MAX)
  }, HISTORY_ORIGIN)
}

type Row = { seq: number; ts: number; username: string; via: string; label: string }
const item = (r: Row): HistoryItem => ({ seq: r.seq, ts: r.ts, username: r.username, text: r.label, via: r.via, api: r.via === 'api' })

/** Hocuspocus `afterLoadDocument`: mirror the document and start logging its transactions. */
export function attachHistory(ctx: Ctx, doc: Y.Doc, name: string) {
  if (!name.startsWith('project:') || states.has(doc)) return
  const projectId = name.slice('project:'.length)
  const { db } = ctx
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) return // (a deleted project's document, still flushing)
  const mirror = new Map<HistoryColl, Map<string, Json>>()
  for (const c of HISTORY_COLLS) {
    const m = new Map<string, Json>()
    if (c === 'meta') m.set(META_ID, metaMap(doc).toJSON())
    else for (const [id, e] of collMap(doc, c)) m.set(id, e.toJSON() as Json)
    mirror.set(c, m)
  }
  const max = (db.prepare('SELECT MAX(seq) AS m FROM history WHERE project_id = ?').get(projectId) as { m: number | null }).m ?? 0
  const st: State = { projectId, mirror, next: max + 1, last: max }
  states.set(doc, st)
  // The doc's summary array and the table agree again: a copied project carries the original's array (no rows here), and after a
  // crash the array can lag the rows.
  const log = historyLog(doc)
  const tail = log.length ? (log.get(log.length - 1).seq ?? 0) : 0
  if (tail !== max || (log.length && max === 0)) {
    const rows = db.prepare('SELECT seq, ts, username, via, label FROM history WHERE project_id = ? AND seq > ? ORDER BY seq').all(projectId, tail > max ? 0 : tail) as Row[]
    doc.transact(() => {
      if (tail > max || max === 0) log.delete(0, log.length)
      log.push(rows.map((r) => summary(r.seq, { userId: null, username: r.username, via: r.via }, r.label, r.ts)))
    }, HISTORY_ORIGIN)
  }
  doc.on('afterTransaction', (tr: Y.Transaction) => {
    try {
      capture(ctx, doc, st, tr)
    } catch (e) {
      console.error(`history capture for ${projectId} failed`, e)
    }
  })
}

/** The log, oldest first: entries after `since`, at most `limit` (the latest ones when more match). */
export function listHistory(ctx: Ctx, projectId: string, since = 0, limit = 200): HistoryItem[] {
  const rows = ctx.db
    .prepare('SELECT seq, ts, username, via, label FROM history WHERE project_id = ? AND seq > ? ORDER BY seq DESC LIMIT ?')
    .all(projectId, since, Math.max(1, Math.min(limit, HISTORY_MAX))) as Row[]
  return rows.reverse().map(item)
}

const patchOf = (ctx: Ctx, projectId: string, seq: number) => {
  const r = ctx.db.prepare('SELECT label, patch FROM history WHERE project_id = ? AND seq = ?').get(projectId, seq) as { label: string; patch: string } | undefined
  return r && { label: r.label, patch: JSON.parse(r.patch) as Patch }
}

export type Collab = { hocuspocus: Hocuspocus }
/** Run `fn` on the live document as `who`, in one transaction (so one history entry). Returns what `fn` returned and the entry's seq. */
export async function writeAs<T>(collab: Collab, projectId: string, who: Who, label: string, fn: (doc: Y.Doc) => T): Promise<{ value: T; seq: number | null }> {
  const conn = await collab.hocuspocus.openDirectConnection(docName(projectId), { userId: who.userId, username: who.username, via: who.via, label: cut(label) })
  try {
    let value!: T, st: State | undefined
    let was = 0
    await conn.transact((doc) => {
      st = states.get(doc)
      was = st?.last ?? 0
      value = fn(doc)
    })
    // (the entry is written when the transaction closes, which is after `fn`)
    return { value, seq: st && st.last !== was ? st.last : null }
  } finally {
    await conn.disconnect()
  }
}

/**
 * Revert one entry: write back what it changed, field by field, where the field still has the value the entry gave it. A created
 * entity is deleted (if untouched since), a deleted one is recreated with its id. Anything changed since is reported as skipped.
 * Returns null when the entry is gone (unknown or pruned).
 */
export async function revertEntry(ctx: Ctx, collab: Collab, projectId: string, seq: number, who: Who): Promise<HistoryResult | null> {
  const row = patchOf(ctx, projectId, seq)
  if (!row) return null
  const { value, seq: made } = await writeAs(collab, projectId, who, `reverted: ${row.label}`, (doc) => {
    let applied = 0
    const skipped: HistorySkip[] = []
    for (const it of row.patch) {
      const skip = (field = '*') => skipped.push({ coll: it.coll, id: it.id, field })
      const cur = entityJson(doc, it.coll, it.id)
      if (it.before === null) { // created: delete it if nobody changed it since
        if (cur === null) continue
        if (deepEqual(fieldsOf(it.coll, cur), fieldsOf(it.coll, it.after))) (removeEntity(doc, it.coll, it.id), applied++)
        else skip()
      } else if (it.after === null) { // deleted: bring it back
        if (cur === null) (createEntity(doc, it.coll, it.id, it.before), applied++)
        else skip()
      } else { // edited: the fields that still hold this entry's value
        if (cur === null) { skip(); continue }
        const was = fieldsOf(it.coll, it.before), now = fieldsOf(it.coll, it.after), have = fieldsOf(it.coll, cur)
        const back: Record<string, unknown> = {}
        for (const f of changedFields(it.coll, it.before, it.after)) {
          if (deepEqual(have[f], now[f])) back[f] = was[f]
          else skip(f)
        }
        if (Object.keys(back).length) (writeFields(doc, it.coll, it.id, back), applied += Object.keys(back).length)
      }
    }
    return { applied, skipped }
  })
  return { ...value, seq: made }
}

/**
 * Restore the project to how it was right after entry `seq`: every later entry, from anyone, is undone in one transaction
 * (unconditionally). Null when `seq` is gone.
 */
export async function restoreTo(ctx: Ctx, collab: Collab, projectId: string, seq: number, who: Who): Promise<HistoryResult | null> {
  const at = ctx.db.prepare('SELECT ts FROM history WHERE project_id = ? AND seq = ?').get(projectId, seq) as { ts: number } | undefined
  if (!at) return null
  const later = ctx.db.prepare('SELECT patch FROM history WHERE project_id = ? AND seq > ? ORDER BY seq').all(projectId, seq) as { patch: string }[]
  // per entity: how it was before the first later entry touched it
  const target = new Map<string, { coll: HistoryColl; id: string; before: Json | null }>()
  for (const r of later) for (const it of JSON.parse(r.patch) as Patch) {
    const k = `${it.coll}/${it.id}`
    if (!target.has(k)) target.set(k, { coll: it.coll, id: it.id, before: it.before })
  }
  const time = new Date(at.ts).toISOString().slice(11, 16)
  const { value, seq: made } = await writeAs(collab, projectId, who, `restored to ${time} UTC`, (doc) => {
    let applied = 0
    // (children first when deleting, parents first when creating isn't needed: entities are independent maps)
    for (const t of target.values()) if (setEntity(doc, t.coll, t.id, t.before)) applied++
    return { applied, skipped: [] as HistorySkip[] }
  })
  return { ...value, seq: made }
}

/** The seq of the newest history entry of a project (0: none). */
export const lastSeq = (ctx: Ctx, projectId: string): number =>
  (ctx.db.prepare('SELECT MAX(seq) AS m FROM history WHERE project_id = ?').get(projectId) as { m: number | null }).m ?? 0
