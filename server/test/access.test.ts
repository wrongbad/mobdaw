import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addTrack, getTracks } from '@mobdaw/shared'
import { audit } from '../src/audit.ts'
import { openDb } from '../src/db.ts'
import { createStorage } from '../src/storage/index.ts'
import { ADMIN, admit, client, connect, login, startTest, until, type Client } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client, alice: Client

beforeAll(async () => {
  t = await startTest()
  admin = await login(t.base, ADMIN)
  alice = await admit(t.base, admin, 'alice')
})
afterAll(() => t.cleanup())

const create = async (name: string) => (await admin.post('/api/projects', { name })).body.id as string
const names = (c: ReturnType<typeof connect>) => getTracks(c.doc).map((x) => x.name)
/** Resolves true once the server closes this provider's document connection for an access change. */
const kicked = (c: ReturnType<typeof connect>) => {
  const flag = { closed: false }
  c.provider.on('close', ({ event }: { event: { reason?: string } }) => { if (event.reason === 'access_changed') flag.closed = true })
  return flag
}
const denied = (token: string, project: string) =>
  new Promise<void>((resolve, reject) => {
    const { provider } = connect(t.port, project, token)
    provider.on('authenticationFailed', () => { provider.destroy(); resolve() })
    provider.on('synced', () => { provider.destroy(); reject(new Error('synced but should be rejected')) })
    setTimeout(() => reject(new Error('timeout')), 5000)
  })

describe('websocket access', () => {
  it('removed member is disconnected and cannot reconnect', async () => {
    const p = await create('Kick')
    await admin.post(`/api/projects/${p}/members`, { username: 'alice' })
    const v = connect(t.port, p, alice.token!)
    await until(() => v.provider.synced)
    const gone = kicked(v)
    await admin.del(`/api/projects/${p}/members/alice`)
    await until(() => gone.closed)
    v.provider.destroy()
    await denied(alice.token!, p)
  })

  it('deleting a project closes connections and leaves no document row behind', async () => {
    const p = await create('Doomed')
    await admin.post(`/api/projects/${p}/members`, { username: 'alice' })
    const v = connect(t.port, p, alice.token!)
    const a = connect(t.port, p, admin.token!)
    await until(() => v.provider.synced && a.provider.synced)
    addTrack(a.doc, 'x') // dirty doc: a debounced store is pending
    const gone = kicked(v)
    expect((await admin.del(`/api/projects/${p}`)).body).toEqual({ ok: true })
    await until(() => gone.closed)
    await new Promise((r) => setTimeout(r, 2500)) // past the store debounce
    a.provider.destroy()
    v.provider.destroy()
    const db = openDb(t.config.dbPath)
    expect(db.prepare('SELECT 1 FROM documents WHERE name = ?').get(`project:${p}`)).toBeUndefined()
    db.close()
  })

  it('leaving and downgrading also close the connection', async () => {
    const p = await create('Leave')
    await admin.post(`/api/projects/${p}/members`, { username: 'alice' })
    const v = connect(t.port, p, alice.token!)
    await until(() => v.provider.synced)
    const gone = kicked(v)
    await admin.post(`/api/projects/${p}/members`, { username: 'alice', role: 'viewer' })
    await until(() => gone.closed)
    v.provider.destroy()
  })
})

describe('copy', () => {
  it('copies live doc state and library; caller owns the copy', async () => {
    const src = await create('Source')
    await admin.post(`/api/projects/${src}/members`, { username: 'alice', role: 'viewer' })
    const data = Buffer.alloc(20, 5)
    const hash = createHash('sha256').update(data).digest('hex')
    const up = await admin.post(`/api/projects/${src}/samples/upload-url`, { hash, size: 20, mime: 'audio/wav' })
    await fetch(t.base + up.body.url, { method: 'PUT', body: data })
    await admin.post(`/api/projects/${src}/samples/${hash}/complete`)

    // keep the doc loaded so the copy must read the live Y.Doc, not a stale/missing stored row
    const a = connect(t.port, src, admin.token!)
    await until(() => a.provider.synced)
    addTrack(a.doc, 'Drums')
    await until(() => a.provider.unsyncedChanges === 0)

    const copy = await alice.post(`/api/projects/${src}/copy`, { name: 'Mine' }) // a viewer may copy
    expect(copy.status).toBe(201)
    expect(copy.body).toMatchObject({ name: 'Mine', ownerUsername: 'alice', role: 'owner' })
    expect(copy.body.members).toHaveLength(1)
    expect((await alice.get(`/api/projects/${copy.body.id}/samples`)).body.map((s: any) => s.hash)).toEqual([hash])
    expect((await alice.get(`/api/projects/${copy.body.id}/samples/${hash}/url`)).status).toBe(200)
    const b = connect(t.port, copy.body.id, alice.token!)
    await until(() => b.provider.synced)
    expect(names(b)).toEqual(['Drums'])
    a.provider.destroy()
    b.provider.destroy()

    expect((await client(t.base).post(`/api/projects/${src}/copy`)).status).toBe(401) // not signed in
    expect((await admit(t.base, admin, 'carol').then((c) => c.post(`/api/projects/${src}/copy`))).status).toBe(404)
    expect((await admin.post(`/api/projects/${src}/copy`)).body.name).toBe('Source (copy)')
  })
})

describe('audit', () => {
  it('detects leaked objects and bytes_used drift; --fix repairs both', async () => {
    const db = openDb(t.config.dbPath)
    const storage = createStorage(t.config, () => undefined)
    const ctx = { config: t.config, db }
    try {
      const p = await create('Audit')
      const data = Buffer.alloc(30, 9)
      const hash = createHash('sha256').update(data).digest('hex')
      const up = await admin.post(`/api/projects/${p}/samples/upload-url`, { hash, size: 30, mime: 'audio/wav' })
      await fetch(t.base + up.body.url, { method: 'PUT', body: data })
      await admin.post(`/api/projects/${p}/samples/${hash}/complete`)
      const base = await audit(ctx, storage)
      expect(base.leaked).toEqual([])
      expect(base.broken).toEqual([])
      expect(base.drift).toEqual([])

      const leak = 'f'.repeat(64)
      await (await import('node:fs/promises')).writeFile(`${t.config.storageDir}/${leak}`, 'stray')
      db.prepare('UPDATE users SET bytes_used = bytes_used + 777 WHERE username = ?').run(ADMIN)

      const found = await audit(ctx, storage)
      expect(found.leaked).toEqual([leak])
      expect(found.drift).toMatchObject([{ username: ADMIN, recorded: found.drift[0].expected + 777 }])

      await audit(ctx, storage, true)
      const after = await audit(ctx, storage)
      expect(after).toEqual({ leaked: [], broken: [], orphanLinks: [], drift: [] })
      expect(await storage.size(leak)).toBeNull()
      expect(await storage.size(hash)).toBe(30) // referenced objects untouched
    } finally {
      db.close()
    }
  })
})

describe('migration', () => {
  it('converts complete->state and backfills project links from stored docs', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const Y = await import('yjs')
    const dir = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'mobdaw-mig-'))
    const path = `${dir}/old.db`
    // Build a pass-1 database: only the first migration applied.
    const raw = new DatabaseSync(path)
    raw.exec(`CREATE TABLE users(email TEXT PRIMARY KEY, name TEXT, is_admin INTEGER NOT NULL DEFAULT 0, bytes_used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE invites(token TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, redeemed_by TEXT, redeemed_at INTEGER);
      CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_email TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE project_members(project_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','editor')), PRIMARY KEY(project_id,email));
      CREATE TABLE documents(name TEXT PRIMARY KEY, data BLOB NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE samples(hash TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0);
      PRAGMA user_version = 1;`)
    const [h1, h2, h3] = ['1', '2', '3'].map((c) => c.repeat(64))
    raw.prepare("INSERT INTO users(email, name, created_at) VALUES('o', 'Old', 1)").run()
    raw.prepare("INSERT INTO projects VALUES('p1','P','o',1)").run()
    raw.prepare("INSERT INTO project_members VALUES('p1','o','owner')").run()
    for (const [h, c] of [[h1, 1], [h2, 1], [h3, 0]] as const) raw.prepare('INSERT INTO samples VALUES(?,?,?,?,?,?)').run(h, 5, 'audio/wav', 'o', 1, c)
    const doc = new Y.Doc()
    doc.getMap('samples').set(h1, { hash: h1 })
    const clip = new Y.Map<unknown>()
    clip.set('sampleHash', h2)
    doc.getMap('clips').set('c1', clip)
    raw.prepare("INSERT INTO documents VALUES('project:p1',?,5)").run(Y.encodeStateAsUpdate(doc))
    raw.close()

    const db = openDb(path)
    try {
      // Google-era identities are kept as usernames, with no password until an admin sets one.
      expect(db.prepare('SELECT * FROM users').all()).toMatchObject([{ username: 'o', password_hash: null }])
      expect(db.prepare('SELECT owner_username FROM projects').all()).toMatchObject([{ owner_username: 'o' }])
      // Uploads belong to the old uploader; library links name the upload they point at.
      expect(db.prepare('SELECT owner, hash, state FROM uploads ORDER BY hash').all()).toMatchObject([
        { owner: 'o', state: 'complete' }, { owner: 'o', state: 'complete' }, { owner: 'o', state: 'pending' },
      ])
      expect(db.prepare('SELECT hash, owner FROM project_samples WHERE project_id = ? ORDER BY hash').all('p1')).toMatchObject([
        { hash: h1, owner: 'o' }, { hash: h2, owner: 'o' },
      ])
    } finally {
      db.close()
    }
  })
})

// Last: restarts the server to prove the viewer's edit was never persisted.
describe('read-only viewers', () => {
  it('viewer edits are not applied or persisted', async () => {
    const p = await create('Viewer')
    await admin.post(`/api/projects/${p}/members`, { username: 'alice', role: 'viewer' })
    const a = connect(t.port, p, admin.token!)
    const v = connect(t.port, p, alice.token!)
    await until(() => a.provider.synced && v.provider.synced)
    addTrack(v.doc, 'Sneaky') // applied locally only
    addTrack(a.doc, 'Real')
    await until(() => names(v).includes('Real')) // viewer still receives the owner's edits
    await until(() => a.provider.unsyncedChanges === 0)
    await new Promise((r) => setTimeout(r, 300))
    expect(names(a)).toEqual(['Real'])
    a.provider.destroy()
    v.provider.destroy()
    await t.close() // flush; then reload from the DB
    const t2 = await startTest({}, t.dir)
    try {
      const d = connect(t2.port, p, admin.token!)
      await until(() => d.provider.synced)
      expect(names(d)).toEqual(['Real'])
      d.provider.destroy()
    } finally {
      await t2.close()
    }
  })
})
