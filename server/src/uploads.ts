import type { Db } from './db.ts'
import { tx } from './db.ts'

export type UploadState = 'pending' | 'complete' | 'deleting'
export type UploadRow = {
  owner_id: number; hash: string; name: string; size: number; mime: string
  state: UploadState; created_at: number
}

export const getUpload = (db: Db, owner: number, hash: string) =>
  db.prepare('SELECT * FROM uploads WHERE owner_id = ? AND hash = ?').get(owner, hash) as UploadRow | undefined

/** Where an owner's uploads are linked (every one, or one hash): read this before unlinking, to mark them missing after. */
export function linksOf(db: Db, owner: number, hash?: string): Link[] {
  return (hash
    ? db.prepare('SELECT project_id, hash FROM project_samples WHERE owner_id = ? AND hash = ?').all(owner, hash)
    : db.prepare('SELECT project_id, hash FROM project_samples WHERE owner_id = ?').all(owner)) as Link[]
}
export type Link = { project_id: string; hash: string }

/**
 * The owner deletes an upload: it leaves every project library at once and becomes a tombstone. The
 * sweep removes the stored object, then the row, and refunds the owner's quota. Returns false if there was nothing to delete.
 */
export function tombstoneUpload(db: Db, owner: number, hash: string): boolean {
  return tx(db, () => {
    db.prepare('DELETE FROM project_samples WHERE owner_id = ? AND hash = ?').run(owner, hash)
    return !!db.prepare("UPDATE uploads SET state = 'deleting' WHERE owner_id = ? AND hash = ? AND state = 'complete'").run(owner, hash).changes
  })
}

/**
 * Tombstone everything a user uploaded (account deletion). Pending rows are marked stale so the sweep reaps
 * them. Runs inside the caller's transaction.
 */
export function tombstoneAllUploads(db: Db, owner: number) {
  db.prepare('DELETE FROM project_samples WHERE owner_id = ?').run(owner)
  db.prepare("UPDATE uploads SET state = 'deleting' WHERE owner_id = ? AND state = 'complete'").run(owner)
  db.prepare("UPDATE uploads SET created_at = 0 WHERE owner_id = ? AND state = 'pending'").run(owner)
}
