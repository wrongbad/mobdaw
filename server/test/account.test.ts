import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addTrack, getTracks } from '@mobdaw/shared'
import { RETENTION_MS, endSubscription, giftMonths, purgeExpiredData, resumeSubscription } from '../src/accounts.ts'
import { enforceReadOnly } from '../src/collab.ts'
import { ADMIN, admit, client, connect, login, pw, startTest, until, type Client } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const P = (id: string) => `/api/projects/${id}/samples`
const mk = async (c: Client, name = 'P') => (await c.post('/api/projects', { name })).body.id as string
async function upload(c: Client, project: string, d: Buffer) {
  const up = await c.post(`${P(project)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav' })
  if (!up.body.exists) {
    await fetch(t.base + up.body.url, { method: 'PUT', body: d as BodyInit })
    expect((await c.post(`${P(project)}/${sha(d)}/complete`)).body).toEqual({ ok: true })
  }
  return sha(d)
}
const names = (c: ReturnType<typeof connect>) => getTracks(c.doc).map((x) => x.name)

beforeAll(async () => {
  t = await startTest()
  admin = await login(t.base, ADMIN)
})
afterAll(() => t.cleanup())

describe('read-only accounts (subscription ended)', () => {
  it('can sign in, play, download and delete, but not create or change anything', async () => {
    const zoe = await admit(t.base, admin, 'zoe')
    const A = await mk(zoe, 'Mine')
    const h = await upload(zoe, A, Buffer.alloc(10, 1))
    const other = await upload(zoe, A, Buffer.alloc(11, 2))
    const at = Date.now()
    expect(endSubscription(t.ctx, t.collab, 'zoe', at)).toBe(true)
    expect(endSubscription(t.ctx, t.collab, 'zoe', at + 1000)).toBe(false) // already ended: the window doesn't restart

    const me = (await zoe.get('/api/me')).body
    expect(me).toMatchObject({ planStatus: 'read_only', retentionEndsAt: at + RETENTION_MS })
    expect((await login(t.base, 'zoe')).token).toBeTruthy() // can still sign in

    // allowed
    expect((await zoe.get('/api/projects')).body).toMatchObject([{ id: A, frozen: true, retentionEndsAt: at + RETENTION_MS }])
    expect((await zoe.get(`${P(A)}/${h}/url`)).status).toBe(200)
    expect((await zoe.get(`/api/uploads/${h}/url`)).status).toBe(200)
    expect((await zoe.get('/api/uploads')).body).toHaveLength(2)
    // refused
    for (const r of [
      await zoe.post('/api/projects', { name: 'New' }),
      await zoe.post(`/api/projects/${A}/copy`),
      await zoe.patch(`/api/projects/${A}`, { name: 'Renamed' }),
      await zoe.post(`/api/projects/${A}/members`, { username: 'admin' }),
      await zoe.post(`${P(A)}/upload-url`, { hash: 'a'.repeat(64), size: 5, mime: 'audio/wav' }),
    ]) {
      expect(r.status).toBe(403)
      expect(r.body.error).toBe('account_read_only')
    }
    // deleting is always allowed
    expect((await zoe.del(`/api/uploads/${other}`)).body).toEqual({ ok: true })

    // resubscribing restores everything as it was
    expect(resumeSubscription(t.ctx, t.collab, 'zoe')).toBe(true)
    expect((await zoe.get('/api/me')).body).toMatchObject({ planStatus: 'active', retentionEndsAt: null })
    expect((await zoe.get(`${P(A)}/${h}/url`)).status).toBe(200)
    expect((await zoe.post('/api/projects', { name: 'New' })).status).toBe(201)
  })

  it("freezes the owner's projects for everyone, over HTTP and WebSocket, and restores them", async () => {
    const owner = await admit(t.base, admin, 'olga'), member = await admit(t.base, admin, 'max')
    const A = await mk(owner, 'Band')
    await owner.post(`/api/projects/${A}/members`, { username: 'max' })
    // The server closes connections when access changes; the client then reloads, which is a fresh connection.
    const kicked = (c: ReturnType<typeof connect>) => {
      const flag = { closed: false }
      c.provider.on('close', ({ event }: { event: { reason?: string } }) => { if (event.reason === 'access_changed') flag.closed = true })
      return flag
    }
    let o = connect(t.port, A, owner.token!), m = connect(t.port, A, member.token!)
    await until(() => o.provider.synced && m.provider.synced)
    addTrack(m.doc, 'Before')
    await until(() => names(o).includes('Before'))
    const kicks = [kicked(o), kicked(m)]

    endSubscription(t.ctx, t.collab, 'olga')
    await until(() => kicks.every((k) => k.closed))
    expect((await member.get(`/api/projects/${A}`)).body).toMatchObject({ frozen: true, role: 'editor' })
    const r = await member.post(`${P(A)}/upload-url`, { hash: 'b'.repeat(64), size: 5, mime: 'audio/wav' })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('project_frozen')
    expect((await member.get(P(A))).status).toBe(200) // reading is fine

    o.provider.destroy()
    m.provider.destroy()
    o = connect(t.port, A, owner.token!)
    m = connect(t.port, A, member.token!)
    await until(() => o.provider.synced && m.provider.synced)
    addTrack(m.doc, 'While frozen')
    await new Promise((res) => setTimeout(res, 400))
    expect(names(o)).toEqual(['Before']) // still readable, not writable
    o.provider.destroy()
    m.provider.destroy()

    resumeSubscription(t.ctx, t.collab, 'olga')
    o = connect(t.port, A, owner.token!)
    m = connect(t.port, A, member.token!)
    await until(() => o.provider.synced && m.provider.synced)
    addTrack(m.doc, 'After')
    await until(() => names(o).includes('After'))
    o.provider.destroy()
    m.provider.destroy()
  })

  it('enforceReadOnly drops connections whose plan changed behind the server\'s back (admin CLI)', async () => {
    const owner = await admit(t.base, admin, 'pia')
    const A = await mk(owner, 'Solo')
    const o = connect(t.port, A, owner.token!)
    await until(() => o.provider.synced)
    let closed = false
    o.provider.on('close', ({ event }: { event: { reason?: string } }) => { if (event.reason === 'access_changed') closed = true })
    t.ctx.db.prepare("UPDATE users SET plan_status = 'read_only', retention_ends_at = 1 WHERE username = 'pia'").run() // as the CLI does
    enforceReadOnly(t.ctx, t.collab)
    await until(() => closed)
    o.provider.destroy()
    resumeSubscription(t.ctx, null, 'pia')
  })
})

describe('retention window and purge', () => {
  it("30 days after the subscription ends the account's cloud data is deleted, but the account never is", async () => {
    const vic = await admit(t.base, admin, 'vic'), wes = await admit(t.base, admin, 'wes')
    const V = await mk(vic, 'Vic project'), W = await mk(wes, 'Wes project')
    await vic.post(`/api/projects/${V}/members`, { username: 'wes' })
    await wes.post(`/api/projects/${W}/members`, { username: 'vic' })
    const mine = await upload(vic, W, Buffer.alloc(20, 7)) // vic's audio inside wes's project
    const wesOwn = await upload(wes, W, Buffer.alloc(21, 8))
    const wesInVic = await upload(wes, V, Buffer.alloc(22, 9))
    const wesBefore = (await wes.get('/api/me')).body.bytesUsed

    const at = Date.now()
    endSubscription(t.ctx, t.collab, 'vic', at)
    expect(await purgeExpiredData(t.ctx, t.storage, t.collab, at + RETENTION_MS - 1000)).toEqual([]) // not yet
    expect(await purgeExpiredData(t.ctx, t.storage, t.collab, at + RETENTION_MS)).toEqual(['vic'])
    expect(await purgeExpiredData(t.ctx, t.storage, t.collab, at + 2 * RETENTION_MS)).toEqual([]) // only once

    // the account is still there: same password, same session, nothing owed
    expect(t.ctx.db.prepare("SELECT 1 FROM users WHERE username = 'vic'").get()).toBeTruthy()
    expect((await login(t.base, 'vic')).token).toBeTruthy()
    expect((await vic.get('/api/me')).body).toMatchObject({ planStatus: 'lapsed', retentionEndsAt: null, bytesUsed: 0 })
    // ... but its cloud data is gone
    expect((await vic.get('/api/uploads')).body).toEqual([])
    expect((await wes.get(`/api/projects/${V}`)).status).toBe(404) // vic's project is deleted for its members
    expect(await t.storage.size(mine)).toBeNull() // vic's audio is gone, even from wes's project
    expect((await wes.get(`${P(W)}/${mine}/url`)).status).toBe(404)
    expect((await wes.get(P(W))).body.map((s: any) => s.hash)).toEqual([wesOwn])
    expect(await t.storage.size(wesOwn)).toBe(21) // wes's own audio is untouched
    expect(await t.storage.size(wesInVic)).toBe(22) // ... including audio he put in vic's deleted project
    expect((await wes.get('/api/me')).body.bytesUsed).toBe(wesBefore)
    expect(t.ctx.db.prepare("SELECT COUNT(*) AS n FROM uploads WHERE owner = 'vic'").get()).toEqual({ n: 0 })
    // still a (read-only) member of the project someone else owns
    expect((await wes.get(`/api/projects/${W}`)).body.members).toContainEqual({ username: 'vic', role: 'editor' })
    expect((await vic.post('/api/projects', { name: 'x' })).body.error).toBe('account_read_only')

    // coming back next year: add time and the account works again, starting empty
    giftMonths(t.ctx, t.collab, 'vic', 1, at + 365 * 86_400_000)
    expect((await vic.get('/api/me')).body).toMatchObject({ planStatus: 'active', retentionEndsAt: null })
    expect((await vic.post('/api/projects', { name: 'Fresh start' })).status).toBe(201)
    expect(await upload(vic, W, Buffer.alloc(23, 10))).toBeTruthy()
  })

  it('resubscribing before the window ends keeps the account', async () => {
    const una = await admit(t.base, admin, 'una')
    const A = await mk(una)
    const at = Date.now()
    endSubscription(t.ctx, t.collab, 'una', at)
    resumeSubscription(t.ctx, t.collab, 'una')
    expect(await purgeExpiredData(t.ctx, t.storage, t.collab, at + 2 * RETENTION_MS)).toEqual([])
    expect((await una.get(`/api/projects/${A}`)).status).toBe(200)
  })

  it('the dev account cannot be put on a retention clock', async () => {
    t.ctx.db.prepare("INSERT INTO users(username, password_hash, account_role, created_at) VALUES('devacct', '', 'dev', 1)").run()
    expect(endSubscription(t.ctx, t.collab, 'devacct')).toBe(false)
  })
})

describe('deleting your account', () => {
  it('needs your password, then deletes everything immediately', async () => {
    const ned = await admit(t.base, admin, 'ned'), amy = await admit(t.base, admin, 'amy')
    const N = await mk(ned, 'Ned project')
    await ned.post(`/api/projects/${N}/members`, { username: 'amy' })
    const h = await upload(ned, N, Buffer.alloc(23, 3))

    expect((await ned.post('/api/me/delete', { password: 'nope' })).body.error).toBe('wrong_password')
    expect((await ned.post('/api/me/delete', {})).status).toBe(403)
    expect((await client(t.base).post('/api/me/delete', { password: pw('ned') })).status).toBe(401)
    expect((await ned.get('/api/me')).status).toBe(200) // nothing happened

    expect((await ned.post('/api/me/delete', { password: pw('ned') })).body).toEqual({ ok: true })
    expect((await ned.get('/api/me')).status).toBe(401)
    expect((await amy.get(`/api/projects/${N}`)).status).toBe(404)
    await until(() => t.ctx.db.prepare('SELECT 1 FROM uploads WHERE hash = ?').get(h) === undefined)
    expect(await t.storage.size(h)).toBeNull()
    expect((await client(t.base).post('/api/auth/login', { username: 'ned', password: pw('ned') })).status).toBe(401)
  })
})
