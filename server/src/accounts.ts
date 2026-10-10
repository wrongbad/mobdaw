import { docName } from '@mobdaw/shared'
import { getUser, type Ctx } from './auth.ts'
import { kick, kickUser, type Collab } from './collab.ts'
import { tx } from './db.ts'
import { sweepSamples } from './routes/samples.ts'
import type { Storage } from './storage/index.ts'
import { tombstoneAllUploads } from './uploads.ts'

/** How long an account stays read-only after its subscription ends, before its data is purged (docs/data-policy.md). */
export const RETENTION_MS = 30 * 24 * 3600 * 1000

/** The subscription ended: the account turns read-only and the retention window starts. No-op if it already has. */
export function endSubscription(ctx: Ctx, collab: Collab | null, username: string, now = Date.now()): boolean {
  const changed = !!ctx.db
    .prepare("UPDATE users SET plan_status = 'read_only', retention_ends_at = ? WHERE username = ? AND plan_status = 'active' AND account_role = 'user'")
    .run(now + RETENTION_MS, username).changes
  if (changed && collab) refreshAccess(ctx, collab, username)
  return changed
}

/** Resubscribed during the retention window: everything is exactly as it was. */
export function resumeSubscription(ctx: Ctx, collab: Collab | null, username: string): boolean {
  const changed = !!ctx.db
    .prepare("UPDATE users SET plan_status = 'active', retention_ends_at = NULL WHERE username = ? AND plan_status = 'read_only'")
    .run(username).changes
  if (changed && collab) refreshAccess(ctx, collab, username)
  return changed
}

/** Connections made before a plan change keep their old write access: drop them so they reconnect with the new one. */
export function refreshAccess(ctx: Ctx, collab: Collab, username: string) {
  kickUser(collab, username)
  for (const { id } of ctx.db.prepare('SELECT id FROM projects WHERE owner_username = ?').all(username) as { id: string }[]) kick(collab, id)
}

/**
 * Permanently delete an account: the projects it owns (for every member), its memberships elsewhere, and
 * every upload it owns (the sweep then purges the bytes). Returns the ids of the deleted projects.
 */
export function purgeAccount(ctx: Ctx, collab: Collab | null, username: string): string[] {
  const { db } = ctx
  const user = getUser(db, username)
  if (!user || user.account_role === 'dev') return []
  const projects = (db.prepare('SELECT id FROM projects WHERE owner_username = ?').all(username) as { id: string }[]).map((p) => p.id)
  tx(db, () => {
    for (const id of projects) {
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id)
      db.prepare('DELETE FROM project_samples WHERE project_id = ?').run(id)
      db.prepare('DELETE FROM documents WHERE name = ?').run(docName(id))
      db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    }
    db.prepare('DELETE FROM project_members WHERE username = ?').run(username)
    tombstoneAllUploads(db, username)
    db.prepare('DELETE FROM users WHERE username = ?').run(username)
  })
  if (collab) {
    for (const id of projects) kick(collab, id)
    kickUser(collab, username)
  }
  return projects
}

/** Purge every account whose retention window has ended, then sweep their bytes. Returns the purged usernames. */
export async function purgeExpiredAccounts(ctx: Ctx, storage: Storage, collab: Collab | null, now = Date.now()) {
  const due = (
    ctx.db.prepare("SELECT username FROM users WHERE plan_status = 'read_only' AND retention_ends_at <= ?").all(now) as { username: string }[]
  ).map((u) => u.username)
  for (const username of due) purgeAccount(ctx, collab, username)
  if (due.length) await sweepSamples(ctx, storage)
  return due
}
