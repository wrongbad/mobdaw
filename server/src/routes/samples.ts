import { Hono } from 'hono'
import type { LibrarySample, UploadUrlRequest } from '@mobdaw/shared'
import { isDevUser, memberRole, requireSignedIn, writeBlock, type Ctx, type Env } from '../auth.ts'
import { tx } from '../db.ts'
import { isHash, type Storage } from '../storage/index.ts'
import { getUpload } from '../uploads.ts'

/** Project-scoped sample routes, mounted at /projects/:id/samples. */
export function sampleRoutes(ctx: Ctx, storage: Storage) {
  const { db, config } = ctx
  const r = new Hono<Env>()
  r.use('*', requireSignedIn)
  const link = (project: string, hash: string, owner: number) =>
    db.prepare('INSERT OR IGNORE INTO project_samples(project_id, hash, owner_id, added_at) VALUES(?,?,?,?)').run(project, hash, owner, Date.now())
  // Someone else's upload of this file that the user can already read through a project they belong to.
  const readableUpload = (userId: number, hash: string) =>
    (isDevUser(ctx, userId)
      ? db.prepare("SELECT owner_id AS owner, size, mime FROM uploads WHERE hash = ? AND owner_id != ? AND state = 'complete' LIMIT 1").get(hash, userId)
      : db
          .prepare(
            `SELECT u.owner_id AS owner, u.size, u.mime FROM project_samples ps
             JOIN project_members m ON m.project_id = ps.project_id
             JOIN uploads u ON u.owner_id = ps.owner_id AND u.hash = ps.hash
             WHERE ps.hash = ? AND m.user_id = ? AND u.owner_id != m.user_id AND u.state = 'complete' LIMIT 1`,
          )
          .get(hash, userId)) as { owner: number; size: number; mime: string } | undefined
  // Quota: bytes already charged, plus other uploads still pending (they reserve space until completed or swept).
  const overQuota = (userId: number, hash: string, size: number) => {
    const used = (db.prepare('SELECT bytes_used FROM users WHERE id = ?').get(userId) as { bytes_used: number } | undefined)?.bytes_used ?? 0
    const { pending } = db
      .prepare("SELECT COALESCE(SUM(size), 0) AS pending FROM uploads WHERE owner_id = ? AND state = 'pending' AND hash != ?")
      .get(userId, hash) as { pending: number }
    return used + pending + size > config.userQuotaBytes
  }
  // Re-requesting refreshes created_at so the sweeper doesn't reap an upload in progress.
  const putPending = (userId: number, hash: string, size: number, mime: string, name: string) =>
    db.prepare(
      `INSERT INTO uploads(owner_id, hash, name, size, mime, created_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(owner_id, hash) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, ''), name), size = excluded.size,
         mime = excluded.mime, created_at = excluded.created_at WHERE state = 'pending'`,
    ).run(userId, hash, name, size, mime, Date.now())

  // Membership gate: 404 for non-members; writes additionally refuse viewers, read-only accounts and frozen projects.
  r.use('/*', async (c, next) => {
    const role = memberRole(ctx, c.req.param('id')!, c.var.session!.id)
    if (!role) return c.json({ error: 'not_found' }, 404)
    if (c.req.method !== 'GET') {
      if (role === 'viewer') return c.json({ error: 'forbidden' }, 403)
      const blocked = writeBlock(ctx, c.req.param('id')!, c.var.session!.id)
      if (blocked) return c.json({ error: blocked }, 403)
    }
    await next()
  })

  r.get('/', (c) =>
    c.json(
      (
        db
          .prepare(
            // One entry per hash even when several owners uploaded it; MIN() picks the earliest link's row.
            `SELECT s.hash, s.size, s.mime, o.username AS owner, MIN(ps.added_at) AS addedAt FROM project_samples ps
             JOIN uploads s ON s.hash = ps.hash AND s.owner_id = ps.owner_id
             JOIN users o ON o.id = ps.owner_id
             WHERE ps.project_id = ? AND s.state = 'complete' GROUP BY ps.hash ORDER BY addedAt`,
          )
          .all(c.req.param('id')!) as LibrarySample[]
      ),
    ),
  )

  r.post('/upload-url', async (c) => {
    const project = c.req.param('id')!
    const body = (await c.req.json().catch(() => ({}))) as Partial<UploadUrlRequest>
    const { hash, size, mime } = body
    if (!hash || !isHash(hash) || !Number.isInteger(size) || size! <= 0 || typeof mime !== 'string' || !mime)
      return c.json({ error: 'bad_request' }, 400)
    const name = typeof body.name === 'string' ? body.name.slice(0, 255) : ''
    const me = c.var.session!.id
    const own = getUpload(db, me, hash)
    // A tombstone blocks a re-upload until its bytes are gone, so a PUT can't race the object delete.
    if (own?.state === 'deleting') return c.json({ error: 'sample_deleting' }, 409)
    if (own?.state === 'complete') {
      // Uploads from before filenames were recorded have none: take it from this request.
      if (name && !own.name) db.prepare('UPDATE uploads SET name = ? WHERE owner_id = ? AND hash = ?').run(name, me, hash)
      link(project, hash, me)
      return c.json({ exists: true })
    }
    const other = readableUpload(me, hash)
    if (other) {
      // They can already read someone else's upload of it: copy that into an upload of their own (owned by
      // and charged to them) instead of making them send the bytes again.
      if (overQuota(me, hash, other.size)) return c.json({ error: 'quota_exceeded' }, 403)
      const copied = await storage.copy(other.owner, me, hash).then(() => true, () => false)
      if (copied) {
        tx(db, () => {
          // `state = 'pending'` guard: a concurrent request may have completed it already; charge once.
          const done = db.prepare(
            `INSERT INTO uploads(owner_id, hash, name, size, mime, state, created_at) VALUES(?,?,?,?,?,'complete',?)
             ON CONFLICT(owner_id, hash) DO UPDATE SET name = excluded.name, size = excluded.size, mime = excluded.mime,
               state = 'complete', created_at = excluded.created_at WHERE state = 'pending'`,
          ).run(me, hash, name, other.size, other.mime, Date.now())
          if (done.changes) db.prepare('UPDATE users SET bytes_used = bytes_used + ? WHERE id = ?').run(other.size, me)
          if (getUpload(db, me, hash)?.state === 'complete') link(project, hash, me)
        })
        return c.json({ exists: true })
      }
      // The source went away meanwhile (its owner deleted it): fall back to a normal upload.
    }
    if (size! > config.maxUploadBytes) return c.json({ error: 'too_large' }, 413)
    if (overQuota(me, hash, size!)) return c.json({ error: 'quota_exceeded' }, 403)
    // Record the declared size/mime; /complete verifies the stored object against it.
    putPending(me, hash, size!, mime, name)
    return c.json({ exists: false, method: 'PUT', ...(await storage.uploadUrl(me, hash, size!, mime)) })
  })

  r.post('/:hash/complete', async (c) => {
    const hash = c.req.param('hash')
    const project = c.req.param('id')!
    const me = c.var.session!.id
    const s = isHash(hash) ? getUpload(db, me, hash) : undefined
    if (!s) return c.json({ error: 'not_found' }, 404)
    if (s.state === 'deleting') return c.json({ error: 'sample_deleting' }, 409)
    if (s.state === 'complete') {
      link(project, hash, me) // already theirs and charged: just (re)link
      return c.json({ ok: true })
    }
    // Too old to finish: keeps /complete clear of the sweeper, which only reaps rows past PENDING_TTL_MS.
    if (s.created_at < Date.now() - COMPLETE_WINDOW_MS) return c.json({ error: 'upload_expired' }, 410)
    const actual = await storage.size(me, hash)
    if (actual !== s.size) return c.json({ error: actual == null ? 'not_uploaded' : 'size_mismatch' }, 400)
    const linked = tx(db, () => {
      // `state = 'pending'` guard makes the quota charge happen exactly once.
      const done = db.prepare("UPDATE uploads SET state = 'complete' WHERE owner_id = ? AND hash = ? AND state = 'pending'").run(me, hash)
      if (done.changes) db.prepare('UPDATE users SET bytes_used = bytes_used + ? WHERE id = ?').run(s.size, me)
      // The owner may have deleted it while we awaited storage: don't resurrect it.
      if (getUpload(db, me, hash)?.state !== 'complete') return false
      link(project, hash, me)
      return true
    })
    if (!linked) return c.json({ error: 'sample_deleting' }, 409)
    return c.json({ ok: true })
  })

  r.get('/:hash/url', async (c) => {
    const hash = c.req.param('hash')
    // Any owner's upload linked here will do: the bytes are the same.
    const linked = db
      .prepare(
        `SELECT ps.owner_id AS owner FROM project_samples ps JOIN uploads s ON s.hash = ps.hash AND s.owner_id = ps.owner_id
         WHERE ps.project_id = ? AND ps.hash = ? AND s.state = 'complete' LIMIT 1`,
      )
      .get(c.req.param('id')!, hash) as { owner: number } | undefined
    if (!linked) return c.json({ error: 'not_found' }, 404)
    return c.json({ url: await storage.downloadUrl(linked.owner, hash) })
  })

  return r
}

// Upload URLs live 15 min. /complete is accepted for 30 min after the request, and the
// sweeper only reaps after 60, so a sweep can never race a PUT or a /complete.
const COMPLETE_WINDOW_MS = 30 * 60 * 1000
export const PENDING_TTL_MS = 60 * 60 * 1000

/**
 * The one GC pass. Reaps (a) stale pending uploads: no quota charge, only a reservation, so the row
 * and any bytes go; and (b) `deleting` tombstones: the stored object goes first, then the row, then
 * the owner's quota is refunded. If an object delete fails the row stays and the next sweep
 * retries. Returns the number of rows removed.
 */
export async function sweepSamples(ctx: Ctx, storage: Storage, olderThanMs = PENDING_TTL_MS) {
  const { db } = ctx
  const cutoff = Date.now() - olderThanMs
  const rows = db
    .prepare("SELECT owner_id AS owner, hash, state FROM uploads WHERE state = 'deleting' OR (state = 'pending' AND created_at < ?)")
    .all(cutoff) as { owner: number; hash: string; state: string }[]
  let n = 0
  for (const { owner, hash, state } of rows) {
    try {
      await storage.delete(owner, hash)
    } catch (e) {
      console.error(`sweep: failed to delete ${owner}/${hash}`, e)
      continue
    }
    if (state === 'deleting') {
      n += tx(db, () => {
        const row = db.prepare("DELETE FROM uploads WHERE owner_id = ? AND hash = ? AND state = 'deleting' RETURNING size").get(owner, hash) as
          | { size: number }
          | undefined
        if (row) db.prepare('UPDATE users SET bytes_used = MAX(0, bytes_used - ?) WHERE id = ?').run(row.size, owner)
        return row ? 1 : 0
      })
    } else {
      // Re-check staleness: if it was re-requested meanwhile, keep the row; the client will PUT again.
      n += Number(db.prepare("DELETE FROM uploads WHERE owner_id = ? AND hash = ? AND state = 'pending' AND created_at < ?").run(owner, hash, cutoff).changes)
    }
  }
  return n
}
