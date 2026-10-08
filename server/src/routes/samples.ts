import { Hono } from 'hono'
import type { LibrarySample, UploadUrlRequest } from '@mobdaw/shared'
import { hmac, isDevUser, memberRole, requireSignedIn, type Ctx, type Env } from '../auth.ts'
import { tx } from '../db.ts'
import { isHash, type Storage } from '../storage/index.ts'

type SampleRow = { hash: string; size: number; mime: string; uploaded_by: string; created_at: number; state: 'pending' | 'complete' | 'deleting' }

/** Project-scoped sample routes, mounted at /projects/:id/samples. */
export function sampleRoutes(ctx: Ctx, storage: Storage) {
  const { db, config } = ctx
  const r = new Hono<Env>()
  r.use('*', requireSignedIn)
  const get = (hash: string) => db.prepare('SELECT * FROM samples WHERE hash = ?').get(hash) as SampleRow | undefined
  const link = (project: string, hash: string, by: string) =>
    db.prepare('INSERT OR IGNORE INTO project_samples(project_id, hash, added_by, added_at) VALUES(?,?,?,?)').run(project, hash, by, Date.now())
  // Can this user already read the sample through any project they belong to?
  const canRead = (username: string, hash: string) =>
    isDevUser(ctx, username) ||
    !!db
      .prepare('SELECT 1 FROM project_samples ps JOIN project_members m ON m.project_id = ps.project_id WHERE ps.hash = ? AND m.username = ?')
      .get(hash, username)

  // Per-requester, per-project proof object (proofs/<hash>/<token>): only this user can PUT there.
  const proofOf = (project: string, username: string, hash: string) => hmac(config.sessionSecret, `proof:${project}:${username}:${hash}`)

  // Membership gate: 404 for non-members; `write` additionally refuses viewers.
  r.use('/*', async (c, next) => {
    const role = memberRole(ctx, c.req.param('id')!, c.var.session!.username)
    if (!role) return c.json({ error: 'not_found' }, 404)
    if (c.req.method !== 'GET' && role === 'viewer') return c.json({ error: 'forbidden' }, 403)
    await next()
  })

  r.get('/', (c) =>
    c.json(
      (
        db
          .prepare(
            `SELECT s.hash, s.size, s.mime, ps.added_by AS addedBy, ps.added_at AS addedAt FROM project_samples ps
             JOIN samples s ON s.hash = ps.hash WHERE ps.project_id = ? AND s.state = 'complete' ORDER BY ps.added_at`,
          )
          .all(c.req.param('id')!) as LibrarySample[]
      ),
    ),
  )

  r.post('/upload-url', async (c) => {
    const project = c.req.param('id')!
    const { hash, size, mime } = (await c.req.json().catch(() => ({}))) as Partial<UploadUrlRequest>
    if (!hash || !isHash(hash) || !Number.isInteger(size) || size! <= 0 || typeof mime !== 'string' || !mime)
      return c.json({ error: 'bad_request' }, 400)
    const username = c.var.session!.username
    const existing = get(hash)
    if (existing?.state === 'deleting') return c.json({ error: 'sample_deleting' }, 409)
    if (existing?.state === 'complete') {
      if (canRead(username, hash)) {
        link(project, hash, username)
        return c.json({ exists: true })
      }
      // Proof of possession: no access yet, so a real upload is required, to a private proof key (the
      // storage layer verifies the bytes hash). /complete checks that object, links, and never charges again.
      const proof = proofOf(project, username, hash)
      return c.json({ exists: false, method: 'PUT', ...(await storage.uploadUrl(hash, existing.size, existing.mime, proof)) })
    }
    if (size! > config.maxUploadBytes) return c.json({ error: 'too_large' }, 413)

    const used = (db.prepare('SELECT bytes_used FROM users WHERE username = ?').get(username) as { bytes_used: number } | undefined)?.bytes_used ?? 0
    // Pending uploads reserve quota until they complete or are swept (see sweepSamples).
    const { pending } = db
      .prepare("SELECT COALESCE(SUM(size), 0) AS pending FROM samples WHERE uploaded_by = ? AND state = 'pending' AND hash != ?")
      .get(username, hash) as { pending: number }
    if (used + pending + size! > config.userQuotaBytes) return c.json({ error: 'quota_exceeded' }, 403)

    // Record the declared size/mime; /complete verifies the stored object against it.
    // Re-requesting refreshes created_at so the sweeper doesn't reap an upload in progress.
    db.prepare(
      `INSERT INTO samples(hash, size, mime, uploaded_by, created_at) VALUES(?,?,?,?,?)
       ON CONFLICT(hash) DO UPDATE SET size = excluded.size, mime = excluded.mime, uploaded_by = excluded.uploaded_by,
         created_at = excluded.created_at
       WHERE state = 'pending'`,
    ).run(hash, size!, mime, username, Date.now())
    return c.json({ exists: false, method: 'PUT', ...(await storage.uploadUrl(hash, size!, mime)) })
  })

  r.post('/:hash/complete', async (c) => {
    const hash = c.req.param('hash')
    const s = isHash(hash) ? get(hash) : undefined
    if (!s) return c.json({ error: 'not_found' }, 404)
    if (s.state === 'deleting') return c.json({ error: 'sample_deleting' }, 409)
    // Too old to finish: keeps /complete clear of the sweeper, which only reaps rows past PENDING_TTL_MS.
    if (s.state === 'pending' && s.created_at < Date.now() - COMPLETE_WINDOW_MS) return c.json({ error: 'upload_expired' }, 410)
    const project = c.req.param('id')!
    const username = c.var.session!.username
    // Already complete and not readable by the caller: only their own proof upload counts, never samples/<hash>.
    const proof = s.state === 'complete' && !canRead(username, hash) ? proofOf(project, username, hash) : undefined
    const actual = await storage.size(hash, proof)
    if (actual !== s.size) return c.json({ error: actual == null ? 'not_uploaded' : 'size_mismatch' }, 400)
    const linked = tx(db, () => {
      // `state = 'pending'` guard makes the quota charge happen exactly once.
      const done = db.prepare("UPDATE samples SET state = 'complete' WHERE hash = ? AND state = 'pending'").run(hash)
      if (done.changes) db.prepare('UPDATE users SET bytes_used = bytes_used + ? WHERE username = ?').run(s.size, s.uploaded_by)
      // It may have been tombstoned while we awaited storage (last link dropped): don't resurrect it.
      if (get(hash)?.state !== 'complete') return false
      link(project, hash, username)
      return true
    })
    if (!linked) return c.json({ error: 'sample_deleting' }, 409)
    if (proof) await storage.delete(hash, proof)
    return c.json({ ok: true })
  })

  r.get('/:hash/url', async (c) => {
    const hash = c.req.param('hash')
    const linked = db
      .prepare("SELECT 1 FROM project_samples ps JOIN samples s ON s.hash = ps.hash WHERE ps.project_id = ? AND ps.hash = ? AND s.state = 'complete'")
      .get(c.req.param('id')!, hash)
    if (!linked) return c.json({ error: 'not_found' }, 404)
    return c.json({ url: await storage.downloadUrl(hash) })
  })

  return r
}

// Upload URLs live 15 min. /complete is accepted for 30 min after the request, and the
// sweeper only reaps after 60, so a sweep can never race a PUT or a /complete.
const COMPLETE_WINDOW_MS = 30 * 60 * 1000
export const PENDING_TTL_MS = 60 * 60 * 1000

/**
 * The one GC pass. Reaps (a) stale pending uploads: no quota charge, only a reservation, so the row
 * and any stored bytes can go; and (b) `deleting` tombstones: object first, then the row, then the
 * uploader's quota is refunded. If an object delete fails the row stays and the next sweep retries.
 * Returns the number of rows removed.
 */
export async function sweepSamples(ctx: Ctx, storage: Storage, olderThanMs = PENDING_TTL_MS) {
  const { db } = ctx
  const cutoff = Date.now() - olderThanMs
  await storage.expireProofs?.(PENDING_TTL_MS).catch((e) => console.error('sweep: proofs', e))
  const rows = db
    .prepare("SELECT hash, state FROM samples WHERE state = 'deleting' OR (state = 'pending' AND created_at < ?)")
    .all(cutoff) as { hash: string; state: string }[]
  let n = 0
  for (const { hash, state } of rows) {
    try {
      await storage.delete(hash)
    } catch (e) {
      console.error(`sweep: failed to delete ${hash}`, e)
      continue
    }
    if (state === 'deleting') {
      n += tx(db, () => {
        const row = db.prepare("DELETE FROM samples WHERE hash = ? AND state = 'deleting' RETURNING size, uploaded_by").get(hash) as
          | { size: number; uploaded_by: string }
          | undefined
        if (row) db.prepare('UPDATE users SET bytes_used = MAX(0, bytes_used - ?) WHERE username = ?').run(row.size, row.uploaded_by)
        return row ? 1 : 0
      })
    } else {
      // Re-check staleness: if it was re-requested meanwhile, keep the row; the client will PUT again.
      n += Number(db.prepare("DELETE FROM samples WHERE hash = ? AND state = 'pending' AND created_at < ?").run(hash, cutoff).changes)
    }
  }
  return n
}
