import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN, admit, client, login, startTest } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
beforeAll(async () => { t = await startTest() })
afterAll(() => t.cleanup())

describe('auth', () => {
  it('config is public', async () => {
    expect((await client(t.base).get('/api/config')).body).toEqual({ authMode: 'dev', googleClientId: null })
  })
  it('/me requires sign in', async () => {
    expect((await client(t.base).get('/api/me')).status).toBe(401)
    expect((await client(t.base, 'garbage.token').get('/api/me')).status).toBe(401)
  })
  it('dev login sets cookie and reports admitted flag', async () => {
    const res = await fetch(t.base + '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Admin@X.com', name: 'Ad' }),
    })
    expect(res.headers.get('set-cookie')).toMatch(/mobdaw_session=.*HttpOnly.*SameSite=Lax/i)
    const body = await res.json()
    expect(body.me).toMatchObject({ email: ADMIN, admitted: true, isAdmin: true, bytesUsed: 0 })
    const me = await fetch(t.base + '/api/me', { headers: { cookie: res.headers.get('set-cookie')!.split(';')[0] } })
    expect((await me.json()).email).toBe(ADMIN)

    const stranger = await login(t.base, 'stranger@x.com')
    expect((await stranger.get('/api/me')).body).toMatchObject({ admitted: false, isAdmin: false })
  })
  it('tampered token is rejected', async () => {
    const a = await login(t.base, ADMIN)
    const [body, sig] = a.token!.split('.')
    const forged = Buffer.from(JSON.stringify({ email: 'evil@x.com', name: '', exp: Date.now() + 1e6 })).toString('base64url')
    expect((await client(t.base, `${forged}.${sig}`).get('/api/me')).status).toBe(401)
    expect(body).toBeTruthy()
  })
})

describe('invites', () => {
  it('non-admitted user is blocked', async () => {
    const u = await login(t.base, 'blocked@x.com')
    for (const p of ['/api/projects', '/api/users', '/api/invites']) {
      const r = await u.get(p)
      expect(r.status).toBe(403)
      expect(r.body.error).toBe('not_invited')
    }
    expect((await u.post('/api/projects', { name: 'x' })).body.error).toBe('not_invited')
  })

  it('non-admin cannot create invites', async () => {
    const admin = await login(t.base, ADMIN)
    const u = await login(t.base, 'plain@x.com')
    const inv = (await admin.post('/api/invites')).body
    await u.post(`/api/invites/${inv.token}/redeem`)
    expect((await u.post('/api/invites')).status).toBe(403)
  })

  it('create, redeem, reuse, expire', async () => {
    const admin = await login(t.base, ADMIN)
    const inv = (await admin.post('/api/invites')).body
    expect(inv.url).toBe(`http://localhost:5173/#/invite/${inv.token}`)
    expect(inv.token).toHaveLength(43)

    const bob = await login(t.base, 'bob@x.com', 'Bob')
    const redeemed = await bob.post(`/api/invites/${inv.token}/redeem`)
    expect(redeemed.status).toBe(200)
    expect(redeemed.body).toMatchObject({ email: 'bob@x.com', admitted: true, isAdmin: false })
    expect((await bob.get('/api/projects')).status).toBe(200)

    const carol = await login(t.base, 'carol@x.com')
    const reuse = await carol.post(`/api/invites/${inv.token}/redeem`)
    expect(reuse.status).toBe(410)
    expect(reuse.body.error).toBe('invite_used')

    // already admitted: 200 and invite not consumed
    const inv2 = (await admin.post('/api/invites')).body
    expect((await bob.post(`/api/invites/${inv2.token}/redeem`)).status).toBe(200)
    const list = (await admin.get('/api/invites')).body
    expect(list.find((i: any) => i.token === inv2.token).redeemedBy).toBeNull()
    expect(list.find((i: any) => i.token === inv.token).redeemedBy).toBe('bob@x.com')

    expect((await carol.post('/api/invites/nope/redeem')).status).toBe(404)
  })

  it('expired invite', async () => {
    const admin = await login(t.base, ADMIN)
    const inv = (await admin.post('/api/invites', { expiresInDays: 1 })).body
    const dave = await login(t.base, 'dave@x.com')
    const realNow = Date.now
    Date.now = () => realNow() + 2 * 86400_000
    try {
      // fresh session for the shifted clock
      const r = await dave.post(`/api/invites/${inv.token}/redeem`)
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
    const alice = await login(t.base, 'alice@x.com', 'Alice')
    await alice.post(`/api/invites/${(await admin.post('/api/invites')).body.token}/redeem`)
    const stranger = await login(t.base, 'nobody@x.com')

    const p = (await admin.post('/api/projects', { name: 'Song' })).body
    expect(p).toMatchObject({ name: 'Song', ownerEmail: ADMIN, role: 'owner' })
    expect(p.id).toHaveLength(12)
    expect((await admin.get('/api/projects')).body.map((x: any) => x.id)).toContain(p.id)

    // non-member: 404 and not listed
    expect((await alice.get(`/api/projects/${p.id}`)).status).toBe(404)
    expect((await alice.get('/api/projects')).body).toEqual([])

    expect((await admin.post(`/api/projects/${p.id}/members`, { email: 'nobody@x.com' })).body.error).toBe('not_admitted')
    expect((await stranger.get('/api/users')).status).toBe(403)

    const shared = await admin.post(`/api/projects/${p.id}/members`, { email: 'Alice@X.com' })
    expect(shared.status).toBe(200)
    expect(shared.body.members.map((m: any) => m.email)).toEqual([ADMIN, 'alice@x.com'])
    expect((await alice.get(`/api/projects/${p.id}`)).body.role).toBe('editor')
    expect((await alice.get('/api/users')).body.map((u: any) => u.email)).toContain('alice@x.com')

    // editors can't manage members; owner can't be removed
    expect((await alice.post(`/api/projects/${p.id}/members`, { email: ADMIN })).status).toBe(403)
    expect((await admin.del(`/api/projects/${p.id}/members/${ADMIN}`)).status).toBe(400)
    const removed = await admin.del(`/api/projects/${p.id}/members/alice%40x.com`)
    expect(removed.body.members).toHaveLength(1)
    expect((await alice.get(`/api/projects/${p.id}`)).status).toBe(404)
  })
})

describe('roles, rename, leave', () => {
  it('manages roles and membership', async () => {
    const admin = await login(t.base, ADMIN)
    const bob = await admit(t.base, admin, 'bob2@x.com')
    const p = (await admin.post('/api/projects', { name: 'Roles' })).body.id
    const url = `/api/projects/${p}`

    const v = await admin.post(`${url}/members`, { email: 'bob2@x.com', role: 'viewer' })
    expect(v.body.members.find((m: any) => m.email === 'bob2@x.com').role).toBe('viewer')
    expect((await bob.get(url)).body.role).toBe('viewer')
    expect((await admin.post(`${url}/members`, { email: 'bob2@x.com', role: 'owner' })).status).toBe(400)
    expect((await admin.post(`${url}/members`, { email: ADMIN, role: 'viewer' })).body.error).toBe('cannot_change_owner')

    // only the owner renames or manages
    expect((await bob.patch(url, { name: 'x' })).status).toBe(403)
    expect((await admin.patch(url, { name: ' ' })).status).toBe(400)
    expect((await admin.patch(url, { name: 'Renamed' })).body.name).toBe('Renamed')
    expect((await bob.post(`${url}/members`, { email: 'bob2@x.com', role: 'editor' })).status).toBe(403)

    // owner can't leave; others can, then lose access
    expect((await admin.post(`${url}/leave`)).body.error).toBe('owner_cannot_leave')
    expect((await bob.post(`${url}/leave`)).body).toEqual({ ok: true })
    expect((await bob.get(url)).status).toBe(404)
    expect((await bob.post(`${url}/leave`)).status).toBe(404)
    expect((await bob.del(url)).status).toBe(404)
  })
})
