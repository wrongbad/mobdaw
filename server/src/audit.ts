import type { Ctx } from './auth.ts'
import type { Storage } from './storage/index.ts'

export type AuditReport = {
  leaked: string[] // stored objects that no upload row accounts for
  broken: string[] // complete uploads whose object is missing
  orphanLinks: string[] // library links (project:hash:owner) whose upload is not complete
  drift: { username: string; recorded: number; expected: number }[] // bytes_used != sum of the user's charged uploads
}

/** Reconcile storage with the DB. With `fix`: delete leaked objects and recompute bytes_used. */
export async function audit(ctx: Ctx, storage: Storage, fix = false): Promise<AuditReport> {
  const { db } = ctx
  const rows = db.prepare('SELECT hash, state FROM uploads').all() as { hash: string; state: string }[]
  const known = new Set(rows.map((r) => r.hash))
  const objects = new Set(await storage.list())
  const report: AuditReport = {
    leaked: [...objects].filter((h) => !known.has(h)),
    broken: [...new Set(rows.filter((r) => r.state === 'complete' && !objects.has(r.hash)).map((r) => r.hash))],
    // An upload with no links is normal (its projects were deleted); a link with no live upload is not.
    orphanLinks: (
      db
        .prepare(
          `SELECT ps.project_id || ':' || ps.hash || ':' || ps.owner AS link FROM project_samples ps
           WHERE NOT EXISTS (SELECT 1 FROM uploads u WHERE u.owner = ps.owner AND u.hash = ps.hash AND u.state = 'complete')`,
        )
        .all() as { link: string }[]
    ).map((r) => r.link),
    // Charged = complete or still-tombstoned (refunded only once the sweep purges them).
    drift: db
      .prepare(
        `SELECT u.username, u.bytes_used AS recorded,
           (SELECT COALESCE(SUM(size), 0) FROM uploads WHERE owner = u.username AND state != 'pending') AS expected
         FROM users u WHERE recorded != expected`,
      )
      .all() as AuditReport['drift'],
  }
  if (fix) {
    for (const h of report.leaked) await storage.delete(h)
    for (const d of report.drift) db.prepare('UPDATE users SET bytes_used = ? WHERE username = ?').run(d.expected, d.username)
  }
  return report
}

export const isClean = (r: AuditReport) => !r.leaked.length && !r.broken.length && !r.orphanLinks.length && !r.drift.length
