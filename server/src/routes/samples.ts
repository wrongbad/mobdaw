import { Hono } from 'hono'
import type { LibrarySample, UploadUrlRequest } from '@mobdaw/shared'
import { hmac, isDevUser, memberRole, requireSignedIn, type Ctx, type Env } from '../auth.ts'
import { tx } from '../db.ts'
import { isHash, type Storage } from '../storage/index.ts'
import { completeElsewhere, getUpload } from '../uploads.ts'

/** Project-scoped sample routes, mounted at /projects/:id/samples. */
export function sampleRoutes(ctx: Ctx, storage: Storage) {
  const { db, config } = ctx
  const r = new Hono<Env>()
  r.use('*', requireSignedIn)
  const link = (project: string, hash: string, owner: string) =>
    db.prepare('INSERT OR IGNORE INTO project_samples(project_id, hash, owner, added_at) VALUES(?,?,?,?)').run(project, hash, owner, Date.now())
  // Can this user already read the bytes through any project they belong to?
  const canRead = (username: string, hash: string) =>
    isDevUser(ctx, username) ||
    !!db
      .prepare('SELECT 1 FROM project_samples ps JOIN project_members m ON m.project_id = ps.project_id WHERE ps.hash = ? AND m.username = ?')
      .get(hash, username)
  // A hash is "going away" when a tombstone exists and no complete upload keeps the bytes alive.
  const goingAway = (hash: string) =>
    !!db.prepare("SELECT 1 FROM uploads WHERE hash = ? AND state = 'deleting'").get(hash) &&
    !db.prepare("SELECT 1 FROM uploads WHERE hash = ? AND state = 'complete'").get(hash)
  // Quota: bytes already charged, plus other uploads still pending (they reserve space until completed or swept).
  const overQuota = (username: string, hash: string, size: number) => {
    const used = (db.prepare('SELECT bytes_used FROM users WHERE username = ?').get(username) as { bytes_used: number } | undefined)?.bytes_used ?? 0
    const { pending } = db
      .prepare("SELECT COALESCE(SUM(size), 0) AS pending FROM uploads WHERE owner = ? AND state = 'pending' AND hash != ?")
      .get(username, hash) as { pending: number }
    return used + pending + size > config.userQuotaBytes
  }
  // Re-requesting refreshes created_at so the sweeper doesn't reap an upload in progress.
  const putPending = (username: string, hash: string, size: number, mime: string, name: string, proof: boolean) =>
    db.prepare(
      `INSERT INTO uploads(owner, hash, name, size, mime, proof, created_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(owner, hash) DO UPDATE SET name = excluded.name, size = excluded.size, mime = excluded.mime,
         proof = excluded.proof, created_at = excluded.created_at WHERE state = 'pending'`,
    ).run(username, hash, name, size, mime, proof ? 1 : 0, Date.now())

  // Per-requester, per-project proof object (proofs/<hash>/<token>): only this user can PUT there.
  const proofOf = (project: string, username: string, hash: string) => hmac(config.sessionSecret, `proof:${project}:${username}:${hash}`)

  // Membership gate: 404 for non-members; writes additionally refuse viewers.
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
            // One entry per hash even when several owners uploaded it; MIN() picks the earliest link's row.
            `SELECT s.hash, s.size, s.mime, ps.owner AS owner, MIN(ps.added_at) AS addedAt FROM project_samples ps
             JOIN uploads s ON s.hash = ps.hash AND s.owner = ps.owner
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
    const username = c.var.session!.username
    const own = getUpload(db, username, hash)
    // A tombstone blocks a re-upload until its bytes are gone, so a PUT can't race the object delete.
    if (own?.state === 'deleting' || goingAway(hash)) return c.json({ error: 'sample_deleting' }, 409)
    if (own?.state === 'complete') {
      link(project, hash, username)
      return c.json({ exists: true })
    }
    const other = completeElsewhere(db, username, hash)
    if (other) {
      // The bytes are already stored for another owner. Everyone still owns their own upload (and is
      // charged for it); the size comes from the stored object, which the hash binds.
      if (overQuota(username, hash, other.size)) return c.json({ error: 'quota_exceeded' }, 403)
      if (canRead(username, hash)) {
        // They can already read it through a project, so no upload is needed to prove they have it.
        tx(db, () => {
          db.prepare(
            `INSERT INTO uploads(owner, hash, name, size, mime, state, created_at) VALUES(?,?,?,?,?,'complete',?)
             ON CONFLICT(owner, hash) DO UPDATE SET name = excluded.name, size = excluded.size, mime = excluded.mime,
               state = 'complete', proof = 0, created_at = excluded.created_at`,
          ).run(username, hash, name, other.size, other.mime, Date.now())
          db.prepare('UPDATE users SET bytes_used = bytes_used + ? WHERE username = ?').run(other.size, username)
          link(project, hash, username)
        })
        return c.json({ exists: true })
      }
      // Proof of possession: no access yet, so a real upload is required, to a private proof key (the
      // storage layer verifies the bytes hash). /complete checks that object, then charges and links.
      putPending(username, hash, other.size, other.mime, name, true)
      return c.json({ exists: false, method: 'PUT', ...(await storage.uploadUrl(hash, other.size, other.mime, proofOf(project, username, hash))) })
    }
    if (size! > config.maxUploadBytes) return c.json({ error: 'too_large' }, 413)
    if (overQuota(username, hash, size!)) return c.json({ error: 'quota_exceeded' }, 403)
    // Record the declared size/mime; /complete verifies the stored object against it.
    putPending(username, hash, size!, mime, name, false)
    return c.json({ exists: false, method: 'PUT', ...(await storage.uploadUrl(hash, size!, mime)) })
  })

  r.post('/:hash/complete', async (c) => {
    const hash = c.req.param('hash')
    const project = c.req.param('id')!
    const username = c.var.session!.username
    const s = isHash(hash) ? getUpload(db, username, hash) : undefined
    if (!s) return c.json({ error: 'not_found' }, 404)
    if (s.state === 'deleting') return c.json({ error: 'sample_deleting' }, 409)
    if (s.state === 'complete') {
      link(project, hash, username) // already theirs and charged: just (re)link
      return c.json({ ok: true })
    }
    // Too old to finish: keeps /complete clear of the sweeper, which only reaps rows past PENDING_TTL_MS.
    if (s.created_at < Date.now() - COMPLETE_WINDOW_MS) return c.json({ error: 'upload_expired' }, 410)
    // Someone else completed the same bytes while this upload was in flight: samples/<hash> now exists whether
    // or not this user PUT anything, so it proves nothing. They must upload again through a proof object.
    if (!s.proof && completeElsewhere(db, username, hash)) return c.json({ error: 'proof_required' }, 409)
    const proof = s.proof ? proofOf(project, username, hash) : undefined
    const actual = await storage.size(hash, proof)
    if (actual !== s.size) return c.json({ error: actual == null ? 'not_uploaded' : 'size_mismatch' }, 400)
    const linked = tx(db, () => {
      // `state = 'pending'` guard makes the quota charge happen exactly once.
      const done = db.prepare("UPDATE uploads SET state = 'complete' WHERE owner = ? AND hash = ? AND state = 'pending'").run(username, hash)
      if (done.changes) db.prepare('UPDATE users SET bytes_used = bytes_used + ? WHERE username = ?').run(s.size, username)
      // The owner may have deleted it while we awaited storage: don't resurrect it.
      if (getUpload(db, username, hash)?.state !== 'complete') return false
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
      .prepare(
        `SELECT 1 FROM project_samples ps JOIN uploads s ON s.hash = ps.hash AND s.owner = ps.owner
         WHERE ps.project_id = ? AND ps.hash = ? AND s.state = 'complete'`,
      )
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
 * goes (and the bytes too, if nobody else's upload needs them); and (b) `deleting` tombstones: the
 * stored bytes go first (unless another owner's upload of the same file still needs them), then the
 * row, then the owner's quota is refunded. If an object delete fails the row stays and the next sweep
 * retries. Returns the number of rows removed.
 */
export async function sweepSamples(ctx: Ctx, storage: Storage, olderThanMs = PENDING_TTL_MS) {
  const { db } = ctx
  const cutoff = Date.now() - olderThanMs
  await storage.expireProofs?.(PENDING_TTL_MS).catch((e) => console.error('sweep: proofs', e))
  const rows = db
    .prepare("SELECT owner, hash, state FROM uploads WHERE state = 'deleting' OR (state = 'pending' AND created_at < ?)")
    .all(cutoff) as { owner: string; hash: string; state: string }[]
  let n = 0
  for (const { owner, hash, state } of rows) {
    // The bytes are shared by everyone who uploaded the same file; the last row out deletes them. Rows are
    // removed as the loop goes, so with two tombstones for one hash the second one deletes the object.
    const needed = !!db.prepare('SELECT 1 FROM uploads WHERE hash = ? AND owner != ?').get(hash, owner)
    if (!needed) {
      try {
        await storage.delete(hash)
      } catch (e) {
        console.error(`sweep: failed to delete ${hash}`, e)
        continue
      }
    }
    if (state === 'deleting') {
      n += tx(db, () => {
        const row = db.prepare("DELETE FROM uploads WHERE owner = ? AND hash = ? AND state = 'deleting' RETURNING size").get(owner, hash) as
          | { size: number }
          | undefined
        if (row) db.prepare('UPDATE users SET bytes_used = MAX(0, bytes_used - ?) WHERE username = ?').run(row.size, owner)
        return row ? 1 : 0
      })
    } else {
      // Re-check staleness: if it was re-requested meanwhile, keep the row; the client will PUT again.
      n += Number(db.prepare("DELETE FROM uploads WHERE owner = ? AND hash = ? AND state = 'pending' AND created_at < ?").run(owner, hash, cutoff).changes)
    }
  }
  return n
}
