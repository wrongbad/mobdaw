import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SESSION_MS, revokeSessions, sweepSessions } from '../src/auth.ts'
import { openDb } from '../src/db.ts'
import { ADMIN, admit, client, login, pw, startTest, userId } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
beforeAll(async () => { t = await startTest() })
afterAll(() => t.cleanup())

describe('auth', () => {
  it('/me requires sign in', async () => {
    expect((await client(t.base).get('/api/me')).status).toBe(401)
    expect((await client(t.base, 'garbage.token').get('/api/me')).status).toBe(401)
  })
  it('login sets cookie and reports the user', async () => {
    const res = await fetch(t.base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ' Admin ', password: pw(ADMIN) }),
    })
    expect(res.headers.get('set-cookie')).toMatch(/mobdaw_session=.*HttpOnly.*SameSite=Lax/i)
    const body = await res.json()
    expect(body.me).toMatchObject({ username: ADMIN, isAdmin: true, bytesUsed: 0 })
    const me = await fetch(t.base + '/api/me', { headers: { cookie: res.headers.get('set-cookie')!.split(';')[0] } })
    expect((await me.json()).username).toBe(ADMIN)
  })
  it('rejects wrong passwords and unknown users alike', async () => {
    const bad = (username: string, password: string) => client(t.base).post('/api/auth/login', { username, password })
    for (const r of [await bad(ADMIN, 'wrong-password'), await bad('nobody-here', 'wrong-password'), await bad(ADMIN, '')]) {
      expect(r.status).toBe(401)
      expect(r.body).toEqual({ error: 'invalid_credentials' })
    }
  })
  it('stores a salted scrypt hash, never the password', async () => {
    const db = openDb(t.config.dbPath)
    const a = await admit(t.base, await login(t.base, ADMIN), 'salty1')
    const b = await admit(t.base, await login(t.base, ADMIN), 'salty2') // same password style, different salt
    const rows = db.prepare("SELECT password_hash FROM users WHERE username IN ('salty1','salty2')").all() as { password_hash: string }[]
    db.close()
    expect(a.token && b.token).toBeTruthy()
    expect(rows[0].password_hash).toMatch(/^scrypt\$65536\$8\$1\$/)
    expect(rows[0].password_hash).not.toContain('password')
    expect(rows[0].password_hash).not.toBe(rows[1].password_hash)
  })
  it('throttles repeated failures per username', async () => {
    const bad = () => client(t.base).post('/api/auth/login', { username: 'throttled', password: 'nope-nope' })
    for (let i = 0; i < 8; i++) expect((await bad()).status).toBe(401)
    expect((await bad()).status).toBe(429)
  })
  it('unknown, tampered and old-format tokens are rejected', async () => {
    const a = await login(t.base, ADMIN)
    const old = `${Buffer.from(JSON.stringify({ uid: 1, exp: Date.now() + 1e6 })).toString('base64url')}.sig`
    for (const bad of [a.token!.slice(0, -1) + (a.token!.endsWith('A') ? 'B' : 'A'), `${a.token}x`, old, 'x'.repeat(43)])
      expect((await client(t.base, bad).get('/api/me')).status).toBe(401)
    expect((await a.get('/api/me')).status).toBe(200)
  })
})

describe('sessions', () => {
  const rows = (username: string) => t.ctx.db.prepare('SELECT * FROM sessions WHERE user_id = ?').all(userId(t.ctx.db, username)) as
    { token_hash: string; expires_at: number; created_at: number }[]

  it('login creates a session; only its hash is stored', async () => {
    await admit(t.base, await login(t.base, ADMIN), 'sess1')
    const c = await login(t.base, 'sess1')
    expect((await c.get('/api/me')).body.username).toBe('sess1')
    const [r] = rows('sess1').slice(-1)
    expect(r.token_hash).toBe(createHash('sha256').update(c.token!).digest('hex'))
    expect(r.expires_at - r.created_at).toBe(SESSION_MS)
    const all = JSON.stringify(t.ctx.db.prepare('SELECT * FROM sessions').all())
    expect(all).not.toContain(c.token!)
  })
  it('logout revokes that session only', async () => {
    await admit(t.base, await login(t.base, ADMIN), 'sess2')
    const a = await login(t.base, 'sess2'), b = await login(t.base, 'sess2')
    expect((await a.post('/api/auth/logout')).body).toEqual({ ok: true })
    expect((await a.get('/api/me')).status).toBe(401)
    expect((await b.get('/api/me')).status).toBe(200)
  })
  it('revokeSessions signs the user out everywhere (password change)', async () => {
    await admit(t.base, await login(t.base, ADMIN), 'sess3')
    const a = await login(t.base, 'sess3'), b = await login(t.base, 'sess3'), admin = await login(t.base, ADMIN)
    expect(revokeSessions(t.ctx.db, userId(t.ctx.db, 'sess3'))).toBeGreaterThanOrEqual(2)
    expect((await a.get('/api/me')).status).toBe(401)
    expect((await b.get('/api/me')).status).toBe(401)
    expect((await admin.get('/api/me')).status).toBe(200)
  })
  it('the admin passwd command revokes sessions', async () => {
    await admit(t.base, await login(t.base, ADMIN), 'sess4')
    const a = await login(t.base, 'sess4')
    const run = spawnSync('node', ['--disable-warning=ExperimentalWarning', '--import', 'tsx', 'scripts/admin.ts', 'passwd', 'sess4'], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8',
      env: { ...process.env, DB_PATH: t.config.dbPath, STORAGE_DIR: t.config.storageDir, MOBDAW_PASSWORD: 'brand-new-password' },
    })
    expect(run.status, run.stderr).toBe(0)
    expect((await a.get('/api/me')).status).toBe(401)
    expect((await client(t.base).post('/api/auth/login', { username: 'sess4', password: 'brand-new-password' })).status).toBe(200)
  })
  it('expired sessions are rejected and swept', async () => {
    await admit(t.base, await login(t.base, ADMIN), 'sess5')
    const c = await login(t.base, 'sess5')
    t.ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1, userId(t.ctx.db, 'sess5'))
    expect((await c.get('/api/me')).status).toBe(401)
    expect(rows('sess5').length).toBeGreaterThan(0)
    expect(sweepSessions(t.ctx.db)).toBeGreaterThanOrEqual(1)
    expect(rows('sess5')).toHaveLength(0)
    expect((await (await login(t.base, ADMIN)).get('/api/me')).status).toBe(200) // live sessions survive the sweep
  })
})

describe('invites and registration', () => {
  const register = (username: string, invite: string, password = pw(username)) =>
    client(t.base).post('/api/auth/register', { username, password, invite })

  it('registration needs a valid invite', async () => {
    expect((await register('uninvited', 'nope')).body.error).toBe('invite_invalid')
    expect((await register('uninvited', '')).body.error).toBe('invite_invalid')
    expect((await client(t.base).post('/api/auth/login', { username: 'uninvited', password: pw('uninvited') })).status).toBe(401)
  })

  it('non-admin cannot create invites', async () => {
    const u = await admit(t.base, await login(t.base, ADMIN), 'plain')
    expect((await u.post('/api/invites')).status).toBe(403)
    expect((await u.get('/api/invites')).status).toBe(403)
    expect((await client(t.base).post('/api/invites')).status).toBe(401)
  })

  it('create, register, reuse', async () => {
    const admin = await login(t.base, ADMIN)
    const inv = (await admin.post('/api/invites')).body
    expect(inv.url).toBe(`http://localhost:5173/#/register/${inv.token}`)
    expect(inv.token).toHaveLength(43)

    const r = await register(' Bob ', inv.token, pw('bob'))
    expect(r.status).toBe(200)
    expect(r.body.me).toMatchObject({ username: 'bob', isAdmin: false })
    const bob = client(t.base, r.body.token)
    expect((await bob.get('/api/projects')).status).toBe(200)
    expect((await login(t.base, 'bob')).token).toBeTruthy()

    const reuse = await register('carol', inv.token)
    expect(reuse.status).toBe(410)
    expect(reuse.body.error).toBe('invite_used')
    expect((await admin.get('/api/invites')).body.find((i: any) => i.token === inv.token).redeemedBy).toBe('bob')
  })

  it('validates username and password, and a failed attempt keeps the invite', async () => {
    const admin = await login(t.base, ADMIN)
    const { token } = (await admin.post('/api/invites')).body
    expect((await register('ab', token)).body.error).toBe('bad_username')
    expect((await register('has space', token)).body.error).toBe('bad_username')
    expect((await register('a@b.com', token)).body.error).toBe('bad_username')
    expect((await register('shortpw', token, 'short')).body.error).toBe('bad_password')
    expect((await register(ADMIN, token)).body.error).toBe('username_taken')
    expect((await register('validname', token)).status).toBe(200) // invite was never consumed
  })

  it('expired invite', async () => {
    const admin = await login(t.base, ADMIN)
    const inv = (await admin.post('/api/invites', { expiresInDays: 1 })).body
    const realNow = Date.now
    Date.now = () => realNow() + 2 * 86400_000
    try {
      const r = await register('dave', inv.token)
      expect(r.status).toBe(410)
      expect(r.body.error).toBe('invite_expired')
    } finally {
      Date.now = realNow
    }
  })
})

describe('projects', () => {
  it('create, list, share, ACL', async () => {
    const admin = await login(t.base, ADMIN)
    const alice = await admit(t.base, admin, 'alice')
    const stranger = client(t.base)

    const p = (await admin.post('/api/projects', { name: 'Song' })).body
    expect(p).toMatchObject({ name: 'Song', ownerUsername: ADMIN, role: 'owner' })
    expect(p.id).toHaveLength(12)
    expect((await admin.get('/api/projects')).body.map((x: any) => x.id)).toContain(p.id)

    // non-member: 404 and not listed
    expect((await alice.get(`/api/projects/${p.id}`)).status).toBe(404)
    expect((await alice.get('/api/projects')).body).toEqual([])

    expect((await admin.post(`/api/projects/${p.id}/members`, { username: 'nobody' })).body.error).toBe('not_admitted')
    expect((await stranger.get('/api/users')).status).toBe(401)

    const shared = await admin.post(`/api/projects/${p.id}/members`, { username: 'Alice' })
    expect(shared.status).toBe(200)
    expect(shared.body.members.map((m: any) => m.username)).toEqual([ADMIN, 'alice'])
    expect((await alice.get(`/api/projects/${p.id}`)).body.role).toBe('editor')
    expect((await alice.get('/api/users')).body.map((u: any) => u.username)).toContain('alice')

    // editors can't manage members; owner can't be removed
    expect((await alice.post(`/api/projects/${p.id}/members`, { username: ADMIN })).status).toBe(403)
    expect((await admin.del(`/api/projects/${p.id}/members/${ADMIN}`)).status).toBe(400)
    const removed = await admin.del(`/api/projects/${p.id}/members/alice`)
    expect(removed.body.members).toHaveLength(1)
    expect((await alice.get(`/api/projects/${p.id}`)).status).toBe(404)
  })
})

describe('roles, rename, leave', () => {
  it('manages roles and membership', async () => {
    const admin = await login(t.base, ADMIN)
    const bob = await admit(t.base, admin, 'bob2')
    const p = (await admin.post('/api/projects', { name: 'Roles' })).body.id
    const url = `/api/projects/${p}`

    const v = await admin.post(`${url}/members`, { username: 'bob2', role: 'viewer' })
    expect(v.body.members.find((m: any) => m.username === 'bob2').role).toBe('viewer')
    expect((await bob.get(url)).body.role).toBe('viewer')
    expect((await admin.post(`${url}/members`, { username: 'bob2', role: 'owner' })).status).toBe(400)
    expect((await admin.post(`${url}/members`, { username: ADMIN, role: 'viewer' })).body.error).toBe('cannot_change_owner')

    // only the owner renames or manages
    expect((await bob.patch(url, { name: 'x' })).status).toBe(403)
    expect((await admin.patch(url, { name: ' ' })).status).toBe(400)
    expect((await admin.patch(url, { name: 'Renamed' })).body.name).toBe('Renamed')
    expect((await bob.post(`${url}/members`, { username: 'bob2', role: 'editor' })).status).toBe(403)

    // owner can't leave; others can, then lose access
    expect((await admin.post(`${url}/leave`)).body.error).toBe('owner_cannot_leave')
    expect((await bob.post(`${url}/leave`)).body).toEqual({ ok: true })
    expect((await bob.get(url)).status).toBe(404)
    expect((await bob.post(`${url}/leave`)).status).toBe(404)
    expect((await bob.del(url)).status).toBe(404)
  })
})
