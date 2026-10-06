import { randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import * as Y from 'yjs'
import { docName, type Member, type ProjectDetail, type ProjectSummary, type Role } from '@mobdaw/shared'
import { isAdmitted, memberRole, requireAdmitted, type Ctx, type Env } from '../auth.ts'
import { kick, type Collab } from '../collab.ts'
import { tx } from '../db.ts'
import type { Storage } from '../storage/index.ts'
import { sweepSamples } from './samples.ts'

type ProjectRow = { id: string; name: string; owner_email: string; created_at: number; role: Role }
const summary = (p: ProjectRow): ProjectSummary => ({
  id: p.id, name: p.name, ownerEmail: p.owner_email, createdAt: p.created_at, role: p.role,
})

export function projectRoutes(ctx: Ctx, storage: Storage, collab: Collab) {
  const { db } = ctx
  const r = new Hono<Env>()
  r.use('*', requireAdmitted(ctx))

  const detail = (id: string, email: string): ProjectDetail | null => {
    const p = db
      .prepare(
        `SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id = p.id AND m.email = ? WHERE p.id = ?`,
      )
      .get(email, id) as ProjectRow | undefined
    if (!p) return null
    const members = db
      .prepare(
        `SELECT m.email, COALESCE(u.name, '') AS name, m.role FROM project_members m
         LEFT JOIN users u ON u.email = m.email WHERE m.project_id = ? ORDER BY m.role = 'owner' DESC, m.email`,
      )
      .all(id) as Member[]
    return { ...summary(p), members }
  }

  r.get('/', (c) =>
    c.json(
      (
        db
          .prepare(
            `SELECT p.*, m.role FROM projects p JOIN project_members m ON m.project_id = p.id
             WHERE m.email = ? ORDER BY p.created_at DESC`,
          )
          .all(c.var.session!.email) as ProjectRow[]
      ).map(summary),
    ),
  )

  r.post('/', async (c) => {
    const name = String((await c.req.json().catch(() => ({}))).name ?? '').trim()
    if (!name) return c.json({ error: 'bad_request' }, 400)
    const email = c.var.session!.email
    const id = randomBytes(9).toString('base64url')
    tx(db, () => {
      db.prepare('INSERT INTO projects(id, name, owner_email, created_at) VALUES(?,?,?,?)').run(id, name, email, Date.now())
      db.prepare("INSERT INTO project_members(project_id, email, role) VALUES(?,?,'owner')").run(id, email)
    })
    return c.json(detail(id, email), 201)
  })

  r.get('/:id', (c) => {
    const p = detail(c.req.param('id'), c.var.session!.email)
    return p ? c.json(p) : c.json({ error: 'not_found' }, 404)
  })

  // Access gate: null if the caller may proceed, else a 404 (non-member) / 403 (not owner when required) response.
  const gate = (c: Context<Env>, ownerOnly = false) => {
    const role = memberRole(ctx, c.req.param('id')!, c.var.session!.email)
    return role && (!ownerOnly || role === 'owner') ? null : c.json({ error: role ? 'forbidden' : 'not_found' }, role ? 403 : 404)
  }

  r.patch('/:id', async (c) => {
    const denied = gate(c, true)
    if (denied) return denied
    const name = String((await c.req.json().catch(() => ({}))).name ?? '').trim()
    if (!name) return c.json({ error: 'bad_request' }, 400)
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, c.req.param('id'))
    return c.json(detail(c.req.param('id'), c.var.session!.email))
  })

  r.delete('/:id', (c) => {
    const denied = gate(c, true)
    if (denied) return denied
    const id = c.req.param('id')
    tx(db, () => {
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id)
      db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      db.prepare('DELETE FROM documents WHERE name = ?').run(docName(id))
      db.prepare('DELETE FROM project_samples WHERE project_id = ?').run(id)
      // Tombstone samples nobody references any more; the sweep deletes the bytes and refunds.
      db.prepare(
        "UPDATE samples SET state = 'deleting' WHERE state = 'complete' AND hash NOT IN (SELECT hash FROM project_samples)",
      ).run()
    })
    kick(collab, id)
    void sweepSamples(ctx, storage).catch((e) => console.error('sweep failed', e))
    return c.json({ ok: true })
  })

  r.post('/:id/members', async (c) => {
    const denied = gate(c, true)
    if (denied) return denied
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const email = String(body.email ?? '').trim().toLowerCase()
    const newRole = body.role ?? 'editor'
    if (newRole !== 'editor' && newRole !== 'viewer') return c.json({ error: 'bad_request' }, 400)
    if (!isAdmitted(ctx, email)) return c.json({ error: 'not_admitted' }, 400)
    const current = memberRole(ctx, id, email)
    if (current === 'owner') return c.json({ error: 'cannot_change_owner' }, 400)
    db.prepare(
      'INSERT INTO project_members(project_id, email, role) VALUES(?,?,?) ON CONFLICT(project_id, email) DO UPDATE SET role = excluded.role',
    ).run(id, email, newRole)
    if (current && current !== newRole) kick(collab, id, email) // reconnects with the new role
    return c.json(detail(id, c.var.session!.email))
  })

  r.delete('/:id/members/:email', (c) => {
    const denied = gate(c, true)
    if (denied) return denied
    const id = c.req.param('id')
    const email = decodeURIComponent(c.req.param('email')).toLowerCase()
    if (memberRole(ctx, id, email) === 'owner') return c.json({ error: 'cannot_remove_owner' }, 400)
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND email = ?').run(id, email)
    kick(collab, id, email)
    return c.json(detail(id, c.var.session!.email))
  })

  r.post('/:id/leave', (c) => {
    const denied = gate(c)
    if (denied) return denied
    if (memberRole(ctx, c.req.param('id'), c.var.session!.email) === 'owner') return c.json({ error: 'owner_cannot_leave' }, 400)
    const id = c.req.param('id')
    const email = c.var.session!.email
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND email = ?').run(id, email)
    kick(collab, id, email)
    return c.json({ ok: true })
  })

  r.post('/:id/copy', async (c) => {
    const denied = gate(c)
    if (denied) return denied
    const id = c.req.param('id')
    const me = c.var.session!.email
    const src = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string }
    const given = String((await c.req.json().catch(() => ({}))).name ?? '').trim()
    const copy = randomBytes(9).toString('base64url')
    // Latest state: the live Y.Doc if Hocuspocus has it loaded (the stored row lags by the store debounce).
    const live = collab.hocuspocus.documents.get(docName(id))
    const stored = db.prepare('SELECT data FROM documents WHERE name = ?').get(docName(id)) as { data: Uint8Array } | undefined
    const state = live ? Y.encodeStateAsUpdate(live) : stored?.data
    tx(db, () => {
      db.prepare('INSERT INTO projects(id, name, owner_email, created_at) VALUES(?,?,?,?)').run(copy, given || `${src.name} (copy)`, me, Date.now())
      db.prepare("INSERT INTO project_members(project_id, email, role) VALUES(?,?,'owner')").run(copy, me)
      db.prepare(
        `INSERT INTO project_samples(project_id, hash, added_by, added_at)
         SELECT ?, hash, added_by, added_at FROM project_samples WHERE project_id = ?`,
      ).run(copy, id)
      if (state) db.prepare('INSERT INTO documents(name, data, updated_at) VALUES(?,?,?)').run(docName(copy), state, Date.now())
    })
    return c.json(detail(copy, me), 201)
  })

  return r
}
