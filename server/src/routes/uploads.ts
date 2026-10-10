import { Hono } from 'hono'
import type { UploadInfo } from '@mobdaw/shared'
import { isDevUser, memberRole, requireSignedIn, type Ctx, type Env } from '../auth.ts'
import { isHash, type Storage } from '../storage/index.ts'
import { getUpload, tombstoneUpload } from '../uploads.ts'
import { sweepSamples } from './samples.ts'

/** The caller's own uploads, mounted at /uploads. Only the owner can see, download or delete an upload. */
export function uploadRoutes(ctx: Ctx, storage: Storage) {
  const { db } = ctx
  const r = new Hono<Env>()
  r.use('*', requireSignedIn)

  r.get('/', (c) => {
    const me = c.var.session!.username
    const rows = db
      .prepare("SELECT hash, name, size, mime, created_at AS createdAt FROM uploads WHERE owner = ? AND state = 'complete' ORDER BY created_at DESC")
      .all(me) as Omit<UploadInfo, 'projects' | 'otherProjects'>[]
    const uses = db.prepare('SELECT p.id, p.name FROM project_samples ps JOIN projects p ON p.id = ps.project_id WHERE ps.owner = ? AND ps.hash = ? ORDER BY p.name')
    return c.json<UploadInfo[]>(
      rows.map((u) => {
        const all = uses.all(me, u.hash) as { id: string; name: string }[]
        const projects = all.filter((p) => isDevUser(ctx, me) || memberRole(ctx, p.id, me))
        return { ...u, projects, otherProjects: all.length - projects.length }
      }),
    )
  })

  r.delete('/:hash', (c) => {
    const hash = c.req.param('hash')
    if (!isHash(hash) || !tombstoneUpload(db, c.var.session!.username, hash)) return c.json({ error: 'not_found' }, 404)
    void sweepSamples(ctx, storage).catch((e) => console.error('sweep failed', e))
    return c.json({ ok: true })
  })

  // Download your own file (also while the account is read-only).
  r.get('/:hash/url', async (c) => {
    const hash = c.req.param('hash')
    if (!isHash(hash) || getUpload(db, c.var.session!.username, hash)?.state !== 'complete') return c.json({ error: 'not_found' }, 404)
    return c.json({ url: await storage.downloadUrl(hash) })
  })

  return r
}
