import type { Ctx } from './auth.ts'
import type { Storage } from './storage/index.ts'

export type AuditReport = {
  leaked: string[] // objects with no samples row
  broken: string[] // complete rows with no object
  unreferenced: string[] // complete samples with zero project links
  drift: { email: string; recorded: number; expected: number }[] // bytes_used != sum of the user's charged uploads
}

/** Reconcile storage with the DB. With `fix`: delete leaked objects and recompute bytes_used. */
export async function audit(ctx: Ctx, storage: Storage, fix = false): Promise<AuditReport> {
  const { db } = ctx
  const rows = db.prepare('SELECT hash, state FROM samples').all() as { hash: string; state: string }[]
  const known = new Set(rows.map((r) => r.hash))
  const objects = new Set(await storage.list())
  const report: AuditReport = {
    leaked: [...objects].filter((h) => !known.has(h)),
    broken: rows.filter((r) => r.state === 'complete' && !objects.has(r.hash)).map((r) => r.hash),
    unreferenced: (
      db
        .prepare("SELECT hash FROM samples WHERE state = 'complete' AND hash NOT IN (SELECT hash FROM project_samples)")
        .all() as { hash: string }[]
    ).map((r) => r.hash),
    // Charged = complete or still-tombstoned (refunded only once the sweep purges them).
    drift: db
      .prepare(
        `SELECT u.email, u.bytes_used AS recorded,
           (SELECT COALESCE(SUM(size), 0) FROM samples WHERE uploaded_by = u.email AND state != 'pending') AS expected
         FROM users u WHERE recorded != expected`,
      )
      .all() as AuditReport['drift'],
  }
  if (fix) {
    for (const h of report.leaked) await storage.delete(h)
    for (const d of report.drift) db.prepare('UPDATE users SET bytes_used = ? WHERE email = ?').run(d.expected, d.email)
  }
  return report
}

export const isClean = (r: AuditReport) => !r.leaked.length && !r.broken.length && !r.unreferenced.length && !r.drift.length
