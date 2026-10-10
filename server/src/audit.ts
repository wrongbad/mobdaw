import type { Ctx } from './auth.ts'
import type { Storage, StoredObject } from './storage/index.ts'

export type AuditReport = {
  leaked: string[] // stored objects (u<owner id>/hash) that no upload row accounts for
  broken: string[] // complete uploads (u<owner id>/hash) whose object is missing
  orphanLinks: string[] // library links (project:hash:owner id) whose upload is not complete
  drift: { id: number; username: string; recorded: number; expected: number }[] // bytes_used != sum of the user's charged uploads
}

/** Reconcile storage with the DB. With `fix`: delete leaked objects and recompute bytes_used. */
export async function audit(ctx: Ctx, storage: Storage, fix = false): Promise<AuditReport> {
  const { db } = ctx
  const rows = db.prepare('SELECT owner_id AS owner, hash, state FROM uploads').all() as { owner: number; hash: string; state: string }[]
  const id = (o: StoredObject) => `u${o.owner}/${o.hash}`
  const known = new Set(rows.map(id))
  const stored = await storage.list()
  const objects = new Set(stored.map(id))
  const report: AuditReport = {
    leaked: stored.map(id).filter((k) => !known.has(k)),
    broken: rows.filter((r) => r.state === 'complete' && !objects.has(id(r))).map(id),
    // An upload with no links is normal (its projects were deleted); a link with no live upload is not.
    orphanLinks: (
      db
        .prepare(
          `SELECT ps.project_id || ':' || ps.hash || ':' || ps.owner_id AS link FROM project_samples ps
           WHERE NOT EXISTS (SELECT 1 FROM uploads u WHERE u.owner_id = ps.owner_id AND u.hash = ps.hash AND u.state = 'complete')`,
        )
        .all() as { link: string }[]
    ).map((r) => r.link),
    // Charged = complete or still-tombstoned (refunded only once the sweep purges them).
    drift: db
      .prepare(
        `SELECT u.id, u.username, u.bytes_used AS recorded,
           (SELECT COALESCE(SUM(size), 0) FROM uploads WHERE owner_id = u.id AND state != 'pending') AS expected
         FROM users u WHERE recorded != expected`,
      )
      .all() as AuditReport['drift'],
  }
  if (fix) {
    for (const o of stored) if (!known.has(id(o))) await storage.delete(o.owner, o.hash)
    for (const d of report.drift) db.prepare('UPDATE users SET bytes_used = ? WHERE id = ?').run(d.expected, d.id)
  }
  return report
}

export const isClean = (r: AuditReport) => !r.leaked.length && !r.broken.length && !r.orphanLinks.length && !r.drift.length
