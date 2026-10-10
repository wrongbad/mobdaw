import { randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import * as Y from 'yjs'
import { docName, projectPreview, type Member, type ProjectPreview, type ProjectDetail, type ProjectSummary, type Role } from '@mobdaw/shared'
import { accountBlocked, findUser, isDevUser, memberRole, requireSignedIn, writeBlock, type Ctx, type Env } from '../auth.ts'
import { kick, type Collab } from '../collab.ts'
import { tx } from '../db.ts'

type ProjectRow = {
  id: string; name: string; owner_username: string; created_at: number; role: Role
  plan_status: 'active' | 'read_only'; retention_ends_at: number | null // the owner's
}
const summary = (p: ProjectRow): ProjectSummary => ({
  id: p.id, name: p.name, ownerUsername: p.owner_username, createdAt: p.created_at, role: p.role,
  frozen: p.plan_status === 'read_only', retentionEndsAt: p.plan_status === 'read_only' ? p.retention_ends_at : null,
})
// Projects joined with their owner's plan, which decides whether the project is frozen.
const WITH_OWNER = 'JOIN users o ON o.id = p.owner_id'
const COLS = 'p.id, p.name, p.created_at, o.username AS owner_username, o.plan_status, o.retention_ends_at'

export function projectRoutes(ctx: Ctx, collab: Collab) {
  const { db } = ctx
  const r = new Hono<Env>()
  r.use('*', requireSignedIn)

  const detail = (id: string, userId: number): ProjectDetail | null => {
    const role = memberRole(ctx, id, userId)
    const row = role && (db.prepare(`SELECT ${COLS} FROM projects p ${WITH_OWNER} WHERE p.id = ?`).get(id) as Omit<ProjectRow, 'role'> | undefined)
    if (!row) return null
    const p = { ...row, role } as ProjectRow
    const members = db
      .prepare(
        `SELECT u.username, m.role FROM project_members m JOIN users u ON u.id = m.user_id
         WHERE m.project_id = ? ORDER BY m.role = 'owner' DESC, u.username`,
      )
      .all(id) as Member[]
    return { ...summary(p), members }
  }

  r.get('/', (c) => {
    const me = c.var.session!.id
    const rows = isDevUser(ctx, me)
      ? (db.prepare(`SELECT ${COLS}, 'owner' AS role FROM projects p ${WITH_OWNER} ORDER BY p.created_at DESC`).all() as ProjectRow[])
      : (db
          .prepare(
            `SELECT ${COLS}, m.role FROM projects p ${WITH_OWNER} JOIN project_members m ON m.project_id = p.id
             WHERE m.user_id = ? ORDER BY p.created_at DESC`,
          )
          .all(me) as ProjectRow[])
    return c.json(rows.map(summary))
  })

  r.post('/', async (c) => {
    const name = String((await c.req.json().catch(() => ({}))).name ?? '').trim()
    if (!name) return c.json({ error: 'bad_request' }, 400)
    const me = c.var.session!.id
    if (accountBlocked(ctx, me)) return c.json({ error: 'account_read_only' }, 403)
    const id = randomBytes(9).toString('base64url')
    tx(db, () => {
      db.prepare('INSERT INTO projects(id, name, owner_id, created_at) VALUES(?,?,?,?)').run(id, name, me, Date.now())
      db.prepare("INSERT INTO project_members(project_id, user_id, role) VALUES(?,?,'owner')").run(id, me)
    })
    return c.json(detail(id, me), 201)
  })

  r.get('/:id', (c) => {
    const p = detail(c.req.param('id'), c.var.session!.id)
    return p ? c.json(p) : c.json({ error: 'not_found' }, 404)
  })

  // Access gate: null if the caller may proceed, else a 404 (non-member) / 403 (not owner when required) response.
  // `changes` marks routes that modify the project: they also refuse a read-only account or a frozen project.
  const gate = (c: Context<Env>, ownerOnly = false, changes = false) => {
    const id = c.req.param('id')!, me = c.var.session!.id
    const role = memberRole(ctx, id, me)
    if (!role || (ownerOnly && role !== 'owner')) return c.json({ error: role ? 'forbidden' : 'not_found' }, role ? 403 : 404)
    const blocked = changes && writeBlock(ctx, id, me)
    return blocked ? c.json({ error: blocked }, 403) : null
  }

  // A small picture of the project (see shared/src/preview.ts), from the live document if it is open, else the stored one.
  r.get('/:id/preview', (c) => {
    const denied = gate(c)
    if (denied) return denied
    const name = docName(c.req.param('id'))
    const live = collab.hocuspocus.documents.get(name)
    if (live) return c.json<ProjectPreview>(projectPreview(live))
    const row = db.prepare('SELECT data FROM documents WHERE name = ?').get(name) as { data: Uint8Array } | undefined
    const doc = new Y.Doc()
    if (row) Y.applyUpdate(doc, new Uint8Array(row.data))
    return c.json<ProjectPreview>(projectPreview(doc))
  })

  r.patch('/:id', async (c) => {
    const denied = gate(c, true, true)
    if (denied) return denied
    const name = String((await c.req.json().catch(() => ({}))).name ?? '').trim()
    if (!name) return c.json({ error: 'bad_request' }, 400)
    db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, c.req.param('id'))
    return c.json(detail(c.req.param('id'), c.var.session!.id))
  })

  r.delete('/:id', (c) => {
    const denied = gate(c, true)
    if (denied) return denied
    const id = c.req.param('id')
    tx(db, () => {
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id)
      db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      db.prepare('DELETE FROM documents WHERE name = ?').run(docName(id))
      // Only the library links go: uploads stay with their owners (and keep counting toward their quota).
      db.prepare('DELETE FROM project_samples WHERE project_id = ?').run(id)
    })
    kick(collab, id)
    return c.json({ ok: true })
  })

  r.post('/:id/members', async (c) => {
    const denied = gate(c, true, true)
    if (denied) return denied
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const username = String(body.username ?? '').trim().toLowerCase()
    const newRole = body.role ?? 'editor'
    if (newRole !== 'editor' && newRole !== 'viewer') return c.json({ error: 'bad_request' }, 400)
    const target = findUser(db, username)
    if (!target) return c.json({ error: 'not_admitted' }, 400)
    const current = memberRole(ctx, id, target.id)
    if (current === 'owner') return c.json({ error: 'cannot_change_owner' }, 400)
    db.prepare(
      'INSERT INTO project_members(project_id, user_id, role) VALUES(?,?,?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role',
    ).run(id, target.id, newRole)
    if (current && current !== newRole) kick(collab, id, target.id) // reconnects with the new role
    return c.json(detail(id, c.var.session!.id))
  })

  r.delete('/:id/members/:username', (c) => {
    const denied = gate(c, true, true)
    if (denied) return denied
    const id = c.req.param('id')
    const target = findUser(db, decodeURIComponent(c.req.param('username')).toLowerCase())
    if (target) {
      if (memberRole(ctx, id, target.id) === 'owner') return c.json({ error: 'cannot_remove_owner' }, 400)
      db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, target.id)
      kick(collab, id, target.id)
    }
    return c.json(detail(id, c.var.session!.id))
  })

  r.post('/:id/leave', (c) => {
    const denied = gate(c)
    if (denied) return denied
    const id = c.req.param('id')
    const me = c.var.session!.id
    if (memberRole(ctx, id, me) === 'owner') return c.json({ error: 'owner_cannot_leave' }, 400)
    db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(id, me)
    kick(collab, id, me)
    return c.json({ ok: true })
  })

  r.post('/:id/copy', async (c) => {
    const denied = gate(c)
    if (denied) return denied
    const id = c.req.param('id')
    const me = c.var.session!.id
    if (accountBlocked(ctx, me)) return c.json({ error: 'account_read_only' }, 403)
    const src = db.prepare('SELECT name FROM projects WHERE id = ?').get(id) as { name: string }
    const given = String((await c.req.json().catch(() => ({}))).name ?? '').trim()
    const copy = randomBytes(9).toString('base64url')
    // Latest state: the live Y.Doc if Hocuspocus has it loaded (the stored row lags by the store debounce).
    const live = collab.hocuspocus.documents.get(docName(id))
    const stored = db.prepare('SELECT data FROM documents WHERE name = ?').get(docName(id)) as { data: Uint8Array } | undefined
    const state = live ? Y.encodeStateAsUpdate(live) : stored?.data
    tx(db, () => {
      db.prepare('INSERT INTO projects(id, name, owner_id, created_at) VALUES(?,?,?,?)').run(copy, given || `${src.name} (copy)`, me, Date.now())
      db.prepare("INSERT INTO project_members(project_id, user_id, role) VALUES(?,?,'owner')").run(copy, me)
      db.prepare(
        `INSERT INTO project_samples(project_id, hash, owner_id, added_at)
         SELECT ?, hash, owner_id, added_at FROM project_samples WHERE project_id = ?`,
      ).run(copy, id)
      if (state) db.prepare('INSERT INTO documents(name, data, updated_at) VALUES(?,?,?)').run(docName(copy), state, Date.now())
    })
    return c.json(detail(copy, me), 201)
  })

  return r
}
