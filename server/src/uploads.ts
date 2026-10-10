import type { Db } from './db.ts'
import { tx } from './db.ts'

export type UploadState = 'pending' | 'complete' | 'deleting'
export type UploadRow = {
  owner: string; hash: string; name: string; size: number; mime: string
  state: UploadState; proof: number; created_at: number
}

export const getUpload = (db: Db, owner: string, hash: string) =>
  db.prepare('SELECT * FROM uploads WHERE owner = ? AND hash = ?').get(owner, hash) as UploadRow | undefined

/** Stored bytes for `hash` that belong to someone other than `owner` and are complete. */
export const completeElsewhere = (db: Db, owner: string, hash: string) =>
  db.prepare("SELECT size, mime FROM uploads WHERE hash = ? AND owner != ? AND state = 'complete' LIMIT 1").get(hash, owner) as
    | { size: number; mime: string }
    | undefined

/**
 * The owner deletes an upload: it leaves every project library at once and becomes a tombstone. The
 * sweep removes the stored bytes (unless another owner's identical upload still needs them), then the
 * row, and refunds the owner's quota. Returns false if there was nothing to delete.
 */
export function tombstoneUpload(db: Db, owner: string, hash: string): boolean {
  return tx(db, () => {
    db.prepare('DELETE FROM project_samples WHERE owner = ? AND hash = ?').run(owner, hash)
    return !!db.prepare("UPDATE uploads SET state = 'deleting' WHERE owner = ? AND hash = ? AND state = 'complete'").run(owner, hash).changes
  })
}

/**
 * Tombstone everything a user uploaded (account deletion). Pending rows are marked stale so the sweep reaps
 * them. Runs inside the caller's transaction.
 */
export function tombstoneAllUploads(db: Db, owner: string) {
  db.prepare('DELETE FROM project_samples WHERE owner = ?').run(owner)
  db.prepare("UPDATE uploads SET state = 'deleting' WHERE owner = ? AND state = 'complete'").run(owner)
  db.prepare("UPDATE uploads SET created_at = 0 WHERE owner = ? AND state = 'pending'").run(owner)
}
