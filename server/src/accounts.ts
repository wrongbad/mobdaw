import { addMonths, docName } from '@mobdaw/shared'
import { getUser, type Ctx } from './auth.ts'
import { kick, kickUser, type Collab } from './collab.ts'
import { tx } from './db.ts'
import { sweepSamples } from './routes/samples.ts'
import type { Storage } from './storage/index.ts'
import { tombstoneAllUploads } from './uploads.ts'

/** How long an account stays read-only after its subscription ends, before its cloud data is deleted (docs/data-policy.md). */
export const RETENTION_MS = 30 * 24 * 3600 * 1000

/** The subscription ended: the account turns read-only and the retention window starts. No-op if it already has. */
export function endSubscription(ctx: Ctx, collab: Collab | null, userId: number, now = Date.now()): boolean {
  const changed = !!ctx.db
    .prepare("UPDATE users SET plan_status = 'read_only', retention_ends_at = ? WHERE id = ? AND plan_status = 'active' AND account_role = 'user'")
    .run(now + RETENTION_MS, userId).changes
  if (changed && collab) refreshAccess(ctx, collab, userId)
  return changed
}

/** More time was added: the account is active again. Within the retention window everything is as it was; after it, the cloud starts empty. */
export function resumeSubscription(ctx: Ctx, collab: Collab | null, userId: number): boolean {
  const changed = !!ctx.db
    .prepare("UPDATE users SET plan_status = 'active', retention_ends_at = NULL, data_purged_at = NULL WHERE id = ? AND plan_status = 'read_only'")
    .run(userId).changes
  if (changed && collab) refreshAccess(ctx, collab, userId)
  return changed
}

/** Connections made before a plan change keep their old write access: drop them so they reconnect with the new one. */
export function refreshAccess(ctx: Ctx, collab: Collab, userId: number) {
  kickUser(collab, userId)
  for (const { id } of ctx.db.prepare('SELECT id FROM projects WHERE owner_id = ?').all(userId) as { id: string }[]) kick(collab, id)
}

/**
 * Add pre-paid months to an account. Time stacks on whatever is left (or starts from now if the account has run out). An
 * account that was read-only because its time ran out is restored, as long as the new time reaches into the future.
 * Returns the new paid-through date, or null if there is no such account.
 */
export function giftMonths(ctx: Ctx, collab: Collab | null, userId: number, months: number, now = Date.now()): number | null {
  const user = getUser(ctx.db, userId)
  if (!user) return null
  const paidThrough = addMonths(Math.max(user.paid_through, now), months)
  ctx.db.prepare('UPDATE users SET paid_through = ? WHERE id = ?').run(paidThrough, userId)
  if (paidThrough > now) resumeSubscription(ctx, collab, userId)
  return paidThrough
}

/** End the subscription of every active account whose pre-paid time has run out. Returns their ids. */
export function endExpiredSubscriptions(ctx: Ctx, collab: Collab | null, now = Date.now()): number[] {
  const due = (
    ctx.db.prepare("SELECT id FROM users WHERE plan_status = 'active' AND account_role = 'user' AND paid_through <= ?").all(now) as { id: number }[]
  ).map((u) => u.id)
  return due.filter((id) => endSubscription(ctx, collab, id, now))
}

/** Delete every project the user owns (for all its members) and tombstone every upload they own. Runs inside the caller's transaction. */
function deleteCloudData(ctx: Ctx, userId: number): string[] {
  const { db } = ctx
  const projects = (db.prepare('SELECT id FROM projects WHERE owner_id = ?').all(userId) as { id: string }[]).map((p) => p.id)
  for (const id of projects) {
    db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM project_samples WHERE project_id = ?').run(id)
    db.prepare('DELETE FROM documents WHERE name = ?').run(docName(id))
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }
  tombstoneAllUploads(db, userId) // the sweep then deletes the bytes and refunds the quota
  return projects
}

/**
 * The retention window is over: delete the account's cloud audio and projects. The account itself stays (accounts are only
 * ever deleted by their owner): it can sign in, and gets a clean start when more time is added. Returns the deleted project ids.
 */
export function purgeCloudData(ctx: Ctx, collab: Collab | null, userId: number, now = Date.now()): string[] {
  const user = getUser(ctx.db, userId)
  if (!user || user.account_role === 'dev') return []
  const projects = tx(ctx.db, () => {
    const deleted = deleteCloudData(ctx, userId)
    ctx.db.prepare('UPDATE users SET retention_ends_at = NULL, data_purged_at = ? WHERE id = ?').run(now, userId)
    return deleted
  })
  if (collab) {
    for (const id of projects) kick(collab, id)
    kickUser(collab, userId)
  }
  return projects
}

/**
 * The owner deletes their account, immediately: their cloud data, their memberships in other people's projects, and
 * the account. Returns the ids of the deleted projects.
 */
export function deleteAccount(ctx: Ctx, collab: Collab | null, userId: number): string[] {
  const { db } = ctx
  const user = getUser(db, userId)
  if (!user || user.account_role === 'dev') return []
  const projects = tx(db, () => {
    const deleted = deleteCloudData(ctx, userId)
    db.prepare('DELETE FROM project_members WHERE user_id = ?').run(userId)
    db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    return deleted
  })
  if (collab) {
    for (const id of projects) kick(collab, id)
    kickUser(collab, userId)
  }
  return projects
}

/** Delete the cloud data of every account whose retention window has ended, then sweep their bytes. Returns their ids. */
export async function purgeExpiredData(ctx: Ctx, storage: Storage, collab: Collab | null, now = Date.now()) {
  const due = (
    ctx.db
      .prepare("SELECT id FROM users WHERE plan_status = 'read_only' AND retention_ends_at IS NOT NULL AND retention_ends_at <= ?")
      .all(now) as { id: number }[]
  ).map((u) => u.id)
  for (const id of due) purgeCloudData(ctx, collab, id, now)
  if (due.length) await sweepSamples(ctx, storage)
  return due
}
