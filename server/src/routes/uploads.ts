import { Hono } from 'hono'
import type { UploadAnalysis, UploadInfo } from '@mobdaw/shared'
import { isDevUser, memberRole, requireSignedIn, type Ctx, type Env } from '../auth.ts'
import { markMissing, type Collab } from '../collab.ts'
import { isHash, type Storage } from '../storage/index.ts'
import { getUpload, linksOf, tombstoneUpload } from '../uploads.ts'
import { sweepSamples } from './samples.ts'

const str = (v: unknown, max: number) => (typeof v === 'string' && v.length <= max ? v : null)
const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null)

/** The request body as an UploadAnalysis, or null when it is not one (sizes are bounded: it is stored as given). */
export function validAnalysis(b: unknown): UploadAnalysis | null {
  const i = (b as UploadAnalysis | null)?.info
  const peaks = str((b as UploadAnalysis | null)?.peaks, 1024)
  const format = str(i?.format, 40), encoding = str(i?.encoding, 60)
  const channels = num(i?.channels, 1024)
  if (!i || peaks == null || format == null || encoding == null || channels == null || !/^[A-Za-z0-9+/]*={0,2}$/.test(peaks)) return null
  const sampleRate = i.sampleRate === null ? null : num(i.sampleRate, 10_000_000)
  const duration = i.duration === null ? null : num(i.duration, 1e9)
  if ((i.sampleRate !== null && sampleRate == null) || (i.duration !== null && duration == null)) return null
  return { info: { format, encoding, sampleRate, channels, duration }, peaks }
}

/** The caller's own uploads, mounted at /uploads. Only the owner can see, download or delete an upload. */
export function uploadRoutes(ctx: Ctx, storage: Storage, collab: Collab) {
  const { db } = ctx
  const r = new Hono<Env>()
  r.use('*', requireSignedIn)

  r.get('/', (c) => {
    const me = c.var.session!.id
    const rows = db
      .prepare("SELECT hash, name, size, mime, created_at AS createdAt, analysis FROM uploads WHERE owner_id = ? AND state = 'complete' ORDER BY created_at DESC")
      .all(me) as (Omit<UploadInfo, 'projects' | 'otherProjects' | 'analysis'> & { analysis: string | null })[]
    const uses = db.prepare('SELECT p.id, p.name FROM project_samples ps JOIN projects p ON p.id = ps.project_id WHERE ps.owner_id = ? AND ps.hash = ? ORDER BY p.name')
    return c.json<UploadInfo[]>(
      rows.map((u) => {
        const all = uses.all(me, u.hash) as { id: string; name: string }[]
        const projects = all.filter((p) => isDevUser(ctx, me) || memberRole(ctx, p.id, me))
        return { ...u, analysis: u.analysis ? (JSON.parse(u.analysis) as UploadAnalysis) : null, projects, otherProjects: all.length - projects.length }
      }),
    )
  })

  // Cache what the owner's browser measured about the file. Only they see it, so it is stored as given, after a shape check.
  r.put('/:hash/analysis', async (c) => {
    const hash = c.req.param('hash')
    const a = validAnalysis(await c.req.json().catch(() => null))
    if (!a) return c.json({ error: 'bad_request' }, 400)
    if (!isHash(hash) || getUpload(db, c.var.session!.id, hash)?.state !== 'complete') return c.json({ error: 'not_found' }, 404)
    db.prepare('UPDATE uploads SET analysis = ? WHERE owner_id = ? AND hash = ?').run(JSON.stringify(a), c.var.session!.id, hash)
    return c.json({ ok: true })
  })

  r.delete('/:hash', (c) => {
    const hash = c.req.param('hash')
    const links = isHash(hash) ? linksOf(db, c.var.session!.id, hash) : []
    if (!isHash(hash) || !tombstoneUpload(db, c.var.session!.id, hash)) return c.json({ error: 'not_found' }, 404)
    void sweepSamples(ctx, storage).catch((e) => console.error('sweep failed', e))
    void markMissing(ctx, collab, links)
    return c.json({ ok: true })
  })

  // Download your own file (also while the account is read-only).
  r.get('/:hash/url', async (c) => {
    const hash = c.req.param('hash')
    if (!isHash(hash) || getUpload(db, c.var.session!.id, hash)?.state !== 'complete') return c.json({ error: 'not_found' }, 404)
    return c.json({ url: await storage.downloadUrl(c.var.session!.id, hash) })
  })

  return r
}
