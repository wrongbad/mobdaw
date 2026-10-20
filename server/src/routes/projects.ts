import { randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import * as Y from 'yjs'
import { docName, projectPreview, type Member, type ProjectPreview, type ProjectDetail, type ProjectSummary, type Role } from '@mobdaw/shared'
import { accountBlocked, findUser, isAdmin, isDevUser, memberRole, projectRole, requireSignedInOrPublic, writeBlock, type Ctx, type Env } from '../auth.ts'
import { kick, KICK_REASON, type Collab } from '../collab.ts'
import { tx } from '../db.ts'

type ProjectRow = {
  id: string; name: string; owner_username: string; created_at: number; role: Role
  plan_status: 'active' | 'read_only'; retention_ends_at: number | null // the owner's
  is_public: number; is_demo: number
}
const summary = (p: ProjectRow): ProjectSummary => ({
  id: p.id, name: p.name, ownerUsername: p.owner_username, createdAt: p.created_at, role: p.role, public: p.is_public === 1, demo: p.is_demo === 1,
  frozen: p.plan_status === 'read_only', retentionEndsAt: p.plan_status === 'read_only' ? p.retention_ends_at : null,
})
// Projects joined with their owner's plan, which decides whether the project is frozen.
const WITH_OWNER = 'JOIN users o ON o.id = p.owner_id'
const COLS = 'p.id, p.name, p.created_at, p.is_public, p.is_demo, o.username AS owner_username, o.plan_status, o.retention_ends_at'

export function projectRoutes(ctx: Ctx, collab: Collab) {
  const { db } = ctx
  const r = new Hono<Env>()
  r.use('*', requireSignedInOrPublic(ctx)) // (only GETs of a public project's details and preview get through signed out)

  const detail = (id: string, userId: number | null): ProjectDetail | null => {
    const role = projectRole(ctx, id, userId)
    const row = role && (db.prepare(`SELECT ${COLS} FROM projects p ${WITH_OWNER} WHERE p.id = ?`).get(id) as Omit<ProjectRow, 'role'> | undefined)
    if (!row) return null
    const p = { ...row, role } as ProjectRow
    // (collaborators are only listed to signed-in accounts)
    const members = userId === null ? [] : db
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

  // Demo projects: public projects an admin has flagged. Listed for everyone, signed in or not.
  r.get('/demos', (c) => {
    const me = c.var.session?.id ?? null
    const rows = db
      .prepare(
        `SELECT ${COLS}, COALESCE((SELECT m.role FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?), 'viewer') AS role
         FROM projects p ${WITH_OWNER} WHERE p.is_public = 1 AND p.is_demo = 1 ORDER BY p.created_at DESC`,
      )
      .all(me) as ProjectRow[]
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
    const p = detail(c.req.param('id'), c.var.session?.id ?? null)
    return p ? c.json(p) : c.json({ error: 'not_found' }, 404)
  })

  // Access gate: null if the caller may proceed, else a 404 (non-member) / 403 (not owner when required) response.
  // `changes` marks routes that modify the project: they also refuse a read-only account or a frozen project.
  const gate = (c: Context<Env>, ownerOnly = false, changes = false) => {
    const id = c.req.param('id')!, me = c.var.session?.id ?? null
    const role = projectRole(ctx, id, me)
    if (!role || (ownerOnly && role !== 'owner')) return c.json({ error: role ? 'forbidden' : 'not_found' }, role ? 403 : 404)
    const blocked = changes && me !== null && writeBlock(ctx, id, me)
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

  // The whole document as one Yjs update, from the live document if it is open, else the stored one. This is all that
  // anyone who cannot edit live (viewers, public visitors) gets: no websocket, no updates after it.
  r.get('/:id/snapshot', (c) => {
    const denied = gate(c)
    if (denied) return denied
    const name = docName(c.req.param('id'))
    const live = collab.hocuspocus.documents.get(name)
    let state: Uint8Array
    if (live) state = Y.encodeStateAsUpdate(live)
    else {
      const row = db.prepare('SELECT data FROM documents WHERE name = ?').get(name) as { data: Uint8Array } | undefined
      state = row ? new Uint8Array(row.data) : Y.encodeStateAsUpdate(new Y.Doc())
    }
    return c.body(state as Uint8Array<ArrayBuffer>, 200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
  })

  r.patch('/:id', async (c) => {
    const denied = gate(c, true, true)
    if (denied) return denied
    const id = c.req.param('id')
    const body = await c.req.json().catch(() => ({}))
    const name = body.name === undefined ? undefined : String(body.name).trim()
    const isPublic = body.public === undefined ? undefined : body.public
    const isDemo = body.demo === undefined ? undefined : body.demo
    if ((name === undefined && isPublic === undefined && isDemo === undefined) || name === '' ||
      (isPublic !== undefined && typeof isPublic !== 'boolean') || (isDemo !== undefined && typeof isDemo !== 'boolean'))
      return c.json({ error: 'bad_request' }, 400)
    if (isDemo !== undefined && !isAdmin(ctx, c.var.session!.id)) return c.json({ error: 'forbidden' }, 403)
    if (isDemo && (isPublic === false || (isPublic === undefined && !db.prepare('SELECT 1 FROM projects WHERE id = ? AND is_public = 1').get(id))))
      return c.json({ error: 'bad_request' }, 400) // a demo must be public
    if (name !== undefined) db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
    if (isPublic !== undefined) {
      db.prepare('UPDATE projects SET is_public = ? WHERE id = ?').run(isPublic ? 1 : 0, id)
      if (!isPublic) db.prepare('UPDATE projects SET is_demo = 0 WHERE id = ?').run(id) // no longer public, so no longer a demo
      if (!isPublic) // making it private again drops everyone who was only here through the link
        for (const conn of collab.hocuspocus.documents.get(docName(id))?.getConnections() ?? [])
          if (conn.context.userId == null || !memberRole(ctx, id, conn.context.userId)) conn.close({ code: 1000, reason: KICK_REASON })
    }
    if (isDemo !== undefined) db.prepare('UPDATE projects SET is_demo = ? WHERE id = ?').run(isDemo ? 1 : 0, id)
    return c.json(detail(id, c.var.session!.id))
  })

  r.delete('/:id', (c) => {
    const denied = gate(c, true)
    if (denied) return denied
    const id = c.req.param('id')
    tx(db, () => {
      db.prepare('DELETE FROM project_members WHERE project_id = ?').run(id)
      db.prepare('DELETE FROM projects WHERE id = ?').run(id)
      db.prepare('DELETE FROM documents WHERE name = ?').run(docName(id))
      db.prepare('DELETE FROM history WHERE project_id = ?').run(id)
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
    if (current !== newRole) kick(collab, id, target.id) // reconnects with the new role (or as a collaborator, if they were only looking at a snapshot)
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
