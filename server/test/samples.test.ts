import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db.ts'
import { sweepSamples } from '../src/routes/samples.ts'
import { createStorage, objectKey, type Storage } from '../src/storage/index.ts'
import { ADMIN, admit, client, login, startTest, until, userId, type Client } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client, alice: Client, bob: Client
let db: Db
let storage: Storage
let pA: string
const uid = (username: string, d: Db = db) => userId(d, username)
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const put = (url: string, body: Buffer | string, base = t.base) => fetch(base + url, { method: 'PUT', body: body as BodyInit })
const P = (id: string) => `/api/projects/${id}/samples`
const mk = async (c: Client, name = 'P') => (await c.post('/api/projects', { name })).body.id as string
const share = (owner: Client, id: string, username: string, role?: string) => owner.post(`/api/projects/${id}/members`, { username, role })
/** Full upload flow into a project; returns the hash. */
async function upload(c: Client, project: string, d: Buffer, base = t.base) {
  const up = await c.post(`${P(project)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav' })
  if (!up.body.exists) {
    expect((await put(up.body.url, d, base)).status).toBe(200)
    expect((await c.post(`${P(project)}/${sha(d)}/complete`)).body).toEqual({ ok: true })
  }
  return sha(d)
}
const state = (hash: string) => (db.prepare('SELECT state FROM uploads WHERE hash = ?').get(hash) as { state: string } | undefined)?.state
const used = async (c: Client) => (await c.get('/api/me')).body.bytesUsed as number

beforeAll(async () => {
  t = await startTest({ MAX_UPLOAD_BYTES: '1000', USER_QUOTA_BYTES: '1500' })
  admin = await login(t.base, ADMIN)
  alice = await admit(t.base, admin, 'alice')
  bob = await admit(t.base, admin, 'bob')
  db = openDb(t.config.dbPath)
  storage = createStorage(t.config, () => undefined)
  pA = await mk(admin, 'A')
})
afterAll(async () => {
  db.close()
  await t.cleanup()
})

describe('samples (local driver)', () => {
  const data = Buffer.alloc(600, 7)
  const hash = sha(data)

  it('upload, complete, download, dedupe', async () => {
    const up = await admin.post(`${P(pA)}/upload-url`, { hash, size: data.length, mime: 'audio/wav' })
    expect(up.body).toMatchObject({ exists: false, method: 'PUT', headers: {} })
    expect(up.body.url).toMatch(new RegExp(`^/api/storage/${objectKey(uid(ADMIN), hash)}\\?exp=\\d+&sig=`))

    // not uploaded yet
    expect((await admin.post(`${P(pA)}/${hash}/complete`)).status).toBe(400)
    expect((await admin.get(`${P(pA)}/${hash}/url`)).status).toBe(404)

    expect((await put(up.body.url, data)).status).toBe(200)
    expect((await admin.post(`${P(pA)}/${hash}/complete`)).body).toEqual({ ok: true })
    expect((await admin.post(`${P(pA)}/${hash}/complete`)).body).toEqual({ ok: true }) // idempotent
    expect(await used(admin)).toBe(600) // charged once

    const { url } = (await admin.get(`${P(pA)}/${hash}/url`)).body
    const res = await fetch(t.base + url) // no cookie needed
    expect(res.headers.get('content-type')).toBe('audio/wav')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(Buffer.from(await res.arrayBuffer()).equals(data)).toBe(true)
    expect(Number(new URL(t.base + url).searchParams.get('exp')) - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000)

    expect((await admin.post(`${P(pA)}/upload-url`, { hash, size: 600, mime: 'audio/wav' })).body).toEqual({ exists: true })
    expect((await admin.get(P(pA))).body).toMatchObject([{ hash, size: 600, mime: 'audio/wav', owner: ADMIN }])
  })

  it('storage urls are signature-checked', async () => {
    const { url } = (await admin.get(`${P(pA)}/${hash}/url`)).body
    expect((await fetch(t.base + url.replace(/sig=./, 'sig=x'))).status).toBe(403)
    expect((await fetch(t.base + `/api/storage/${objectKey(uid(ADMIN), hash)}`)).status).toBe(403)
    expect((await fetch(t.base + url.replace(/exp=\d+/, 'exp=1'))).status).toBe(403)
    // a GET signature can't be used to PUT
    expect((await put(url, data)).status).toBe(403)
  })

  it('rejects hash mismatch', async () => {
    const h = sha(Buffer.from('hello world, a small sample'))
    const up = await admin.post(`${P(pA)}/upload-url`, { hash: h, size: 5, mime: 'audio/wav' })
    const r = await put(up.body.url, 'wrong')
    expect(r.status).toBe(400)
    expect((await r.json()).error).toBe('hash_mismatch')
    expect((await admin.post(`${P(pA)}/${h}/complete`)).status).toBe(400)
  })

  it('rejects oversize (declared and streamed)', async () => {
    const big = Buffer.alloc(1001, 1)
    const r = await admin.post(`${P(pA)}/upload-url`, { hash: sha(big), size: big.length, mime: 'audio/wav' })
    expect(r.status).toBe(413)

    // declare small, stream big
    const up = await admin.post(`${P(pA)}/upload-url`, { hash: sha(big), size: 10, mime: 'audio/wav' })
    expect((await put(up.body.url, big)).status).toBe(413)
  })

  it('complete rejects size different from declared', async () => {
    const d = Buffer.alloc(50, 3)
    const up = await admin.post(`${P(pA)}/upload-url`, { hash: sha(d), size: 40, mime: 'audio/wav' })
    await put(up.body.url, d)
    expect((await admin.post(`${P(pA)}/${sha(d)}/complete`)).body.error).toBe('size_mismatch')
  })

  it('enforces quota', async () => {
    const d = Buffer.alloc(950, 9) // 600 used + 950 > 1500
    const r = await admin.post(`${P(pA)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav' })
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('quota_exceeded')
  })

  it('requires sign-in, membership and valid input', async () => {
    expect((await admin.post(`${P(pA)}/upload-url`, { hash: 'zz', size: 1, mime: 'a/b' })).status).toBe(400)
    expect((await client(t.base).post(`${P(pA)}/upload-url`, {})).status).toBe(401)
    expect((await alice.post(`${P(pA)}/upload-url`, { hash, size: 1, mime: 'a/b' })).status).toBe(404) // non-member
    expect((await alice.get(`${P(pA)}/${hash}/url`)).status).toBe(404)
    expect((await alice.get(P(pA))).status).toBe(404)
  })
})

describe('access policy', () => {
  it('read leak: a hash linked only in another project is not readable', async () => {
    const A = await mk(admin), B = await mk(admin)
    await share(admin, A, 'alice')
    const h = await upload(admin, B, Buffer.alloc(11, 21))
    expect((await alice.get(`${P(A)}/${h}/url`)).status).toBe(404)
    expect((await admin.get(`${P(A)}/${h}/url`)).status).toBe(404) // even the owner: not linked here
    expect((await admin.get(`${P(B)}/${h}/url`)).status).toBe(200)
  })

  it('viewers can download but not upload', async () => {
    const A = await mk(admin)
    const h = await upload(admin, A, Buffer.alloc(12, 22))
    await share(admin, A, 'alice', 'viewer')
    expect((await alice.get(`${P(A)}/${h}/url`)).status).toBe(200)
    expect((await alice.get(P(A))).body).toHaveLength(1)
    expect((await alice.post(`${P(A)}/upload-url`, { hash: h, size: 12, mime: 'audio/wav' })).status).toBe(403)
    expect((await alice.post(`${P(A)}/${h}/complete`)).status).toBe(403)
    await share(admin, A, 'alice', 'editor') // role update
    expect((await alice.post(`${P(A)}/upload-url`, { hash: h, size: 12, mime: 'audio/wav' })).body).toEqual({ exists: true })
  })

  it('dedupe leak: no access means a real upload, and no second charge', async () => {
    const A = await mk(admin), B = await mk(bob)
    const d = Buffer.alloc(13, 23)
    const h = await upload(admin, A, d)
    const adminUsed = await used(admin), bobUsed = await used(bob)
    const up = await bob.post(`${P(B)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })
    expect(up.body.exists).toBe(false)
    expect(up.body.url).toBeTruthy()
    expect((await bob.get(`${P(B)}/${h}/url`)).status).toBe(404) // not linked until a real upload
    expect((await put(up.body.url, d)).status).toBe(200)
    expect((await bob.post(`${P(B)}/${h}/complete`)).body).toEqual({ ok: true })
    expect((await bob.get(`${P(B)}/${h}/url`)).status).toBe(200)
    expect(await used(bob)).toBe(bobUsed + 13) // bob owns his own upload, so he is charged for it
    expect(await used(admin)).toBe(adminUsed) // and admin is not charged twice
  })

  it("no access: skipping the PUT, wrong bytes, and someone else's stored copy all fail", async () => {
    const A = await mk(admin), B = await mk(bob)
    const d = Buffer.alloc(15, 25)
    const h = await upload(admin, A, d)
    const up = await bob.post(`${P(B)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })
    const r = await bob.post(`${P(B)}/${h}/complete`) // admin's object exists, but it isn't bob's
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('not_uploaded')
    expect((await bob.get(P(B))).body).toEqual([])
    expect((await put(up.body.url, Buffer.alloc(15, 99))).status).toBe(400)
    expect((await bob.post(`${P(B)}/${h}/complete`)).status).toBe(400)
    expect(await storage.size(uid(ADMIN), h)).toBe(15) // admin's object untouched
  })

  it('within-access dedupe links without uploading, and each user owns and is charged for their own upload', async () => {
    const A = await mk(admin), B = await mk(admin)
    const d = Buffer.alloc(14, 24)
    const h = await upload(admin, A, d)
    expect((await admin.post(`${P(B)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })).body).toEqual({ exists: true })
    expect((await admin.get(P(B))).body.map((s: any) => s.hash)).toEqual([h])
    expect((await admin.get(`${P(B)}/${h}/url`)).status).toBe(200)

    // alice can read it through A, so adding it to her own project needs no upload, but she owns a copy
    await share(admin, A, 'alice')
    const C = await mk(alice)
    const before = await used(alice)
    expect((await alice.post(`${P(C)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })).body).toEqual({ exists: true })
    expect(await used(alice)).toBe(before + 14)
    expect((await alice.get(P(C))).body).toMatchObject([{ hash: h, owner: 'alice' }])
    expect(db.prepare('SELECT owner_id FROM uploads WHERE hash = ? ORDER BY owner_id').all(h).map((r: any) => r.owner_id)).toEqual([uid('admin'), uid('alice')])
    expect(await storage.size(uid('alice'), h)).toBe(14) // copied server-side
  })

  it('quota is checked for deduped uploads too', async () => {
    const carol = await admit(t.base, admin, 'carol'), dave = await admit(t.base, admin, 'dave')
    const A = await mk(carol)
    const d = Buffer.alloc(900, 41)
    const h = await upload(carol, A, d)
    await upload(dave, await mk(dave), Buffer.alloc(700, 42))
    await share(carol, A, 'dave')
    const B = await mk(dave)
    const r = await dave.post(`${P(B)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' }) // 700 + 900 > 1500
    expect(r.status).toBe(403)
    expect(r.body.error).toBe('quota_exceeded')
  })
})

describe('project delete and upload ownership', () => {
  it('deleting a project keeps every upload; deleting an upload purges it and refunds', async () => {
    const A = await mk(admin), B = await mk(admin)
    await share(admin, A, 'bob')
    const dx = Buffer.alloc(31, 31), dy = Buffer.alloc(32, 32)
    const X = await upload(admin, A, dx)
    await admin.post(`${P(B)}/upload-url`, { hash: X, size: dx.length, mime: 'audio/wav' }) // links X into B
    const bobBefore = await used(bob)
    const Y = await upload(bob, A, dy)
    expect(await used(bob)).toBe(bobBefore + 32)
    const storage = createStorage(t.config, () => undefined)

    expect((await alice.del(`/api/projects/${A}`)).status).toBe(404)
    expect((await bob.del(`/api/projects/${A}`)).status).toBe(403) // editor can't delete
    expect((await admin.del(`/api/projects/${A}`)).body).toEqual({ ok: true })
    expect((await admin.get(`/api/projects/${A}`)).status).toBe(404)

    // The project is gone but nobody's audio is: bob still owns Y and is still charged for it.
    expect(state(Y)).toBe('complete')
    expect(await storage.size(uid('bob'), Y)).toBe(32)
    expect(await used(bob)).toBe(bobBefore + 32)
    expect((await bob.get('/api/uploads')).body.find((u: any) => u.hash === Y)).toMatchObject({ hash: Y, projects: [], otherProjects: 0 })
    expect((await bob.get(`/api/uploads/${Y}/url`)).status).toBe(200)
    expect(state(X)).toBe('complete')
    expect((await admin.get(`${P(B)}/${X}/url`)).status).toBe(200)

    expect((await bob.del(`/api/uploads/${Y}`)).body).toEqual({ ok: true })
    await until(() => state(Y) === undefined)
    expect(await storage.size(uid('bob'), Y)).toBeNull()
    expect(await used(bob)).toBe(bobBefore) // refunded
  })

  it('upload-url for a deleting upload returns 409', async () => {
    const A = await mk(admin)
    const d = Buffer.alloc(33, 33)
    const h = await upload(admin, A, d)
    db.prepare("UPDATE uploads SET state = 'deleting' WHERE hash = ?").run(h)
    const r = await admin.post(`${P(A)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('sample_deleting')
    expect((await admin.post(`${P(A)}/${h}/complete`)).status).toBe(409)
  })
})

describe('sweepSamples', () => {
  const hour = 3600 * 1000
  let s: Awaited<ReturnType<typeof startTest>>
  let a: Client
  let sdb: Db
  let storage: Storage
  let P1: string
  const up = (d: Buffer) => a.post(`${P(P1)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav' })
  const age = (d: Buffer, ms: number) => sdb.prepare('UPDATE uploads SET created_at = created_at - ? WHERE hash = ?').run(ms, sha(d))
  const row = (d: Buffer) => sdb.prepare('SELECT * FROM uploads WHERE hash = ?').get(sha(d))
  const d1 = Buffer.alloc(900, 1), d2 = Buffer.alloc(700, 2), d3 = Buffer.alloc(300, 3), d4 = Buffer.alloc(100, 4)

  beforeAll(async () => {
    s = await startTest({ MAX_UPLOAD_BYTES: '1000', USER_QUOTA_BYTES: '1500' })
    a = await login(s.base, ADMIN)
    P1 = await mk(a)
    sdb = openDb(s.config.dbPath)
    storage = createStorage(s.config, () => undefined)
  })
  afterAll(async () => {
    sdb.close()
    await s.cleanup()
  })

  it('pending uploads reserve quota until completed or swept', async () => {
    expect((await up(d1)).status).toBe(200) // 900 pending
    expect((await up(d2)).body.error).toBe('quota_exceeded') // 900 + 700 > 1500
    expect((await up(d1)).status).toBe(200) // re-requesting doesn't double-count itself
  })

  it('reaps stale pending uploads only', async () => {
    expect((await put((await up(d1)).body.url, d1, s.base)).status).toBe(200) // uploaded, never completed
    const r3 = await up(d3)
    await put(r3.body.url, d3, s.base)
    expect((await a.post(`${P(P1)}/${sha(d3)}/complete`)).body).toEqual({ ok: true })
    expect((await up(d4)).status).toBe(200) // fresh pending
    age(d1, 2 * hour)
    age(d3, 2 * hour)

    expect(await sweepSamples({ config: s.config, db: sdb }, storage)).toBe(1)
    expect(row(d1)).toBeUndefined()
    expect(await storage.size(uid(ADMIN, sdb), sha(d1))).toBeNull()
    expect(await storage.size(uid(ADMIN, sdb), sha(d3))).toBe(300) // complete: untouched
    expect(row(d4)).toBeDefined() // fresh: untouched
    expect((await up(d2)).status).toBe(200) // reservation freed: 300 used + 100 + 700 pending
  })

  it('/complete is refused once the window has passed', async () => {
    age(d2, 31 * 60 * 1000)
    const r = await a.post(`${P(P1)}/${sha(d2)}/complete`)
    expect(r.status).toBe(410)
    expect(r.body.error).toBe('upload_expired')
  })

  it('moves objects from the older layouts to one per owner id', async () => {
    const root = s.config.storageDir
    const d = Buffer.alloc(16, 6), h = sha(d)
    // oldest: one object per hash, plus a proof upload
    writeFileSync(`${root}/${h}`, d)
    mkdirSync(`${root}/proofs`)
    writeFileSync(`${root}/proofs/${h}.x`, d)
    // previous: keyed by hex(username); one user still exists, one is gone
    const e = Buffer.alloc(17, 7), h2 = sha(e)
    const hex = (n: string) => Buffer.from(n).toString('hex')
    mkdirSync(`${root}/${hex('olduser')}`)
    writeFileSync(`${root}/${hex('olduser')}/${h2}`, e)
    mkdirSync(`${root}/${hex('gone')}`)
    writeFileSync(`${root}/${hex('gone')}/${h2}`, e)

    await storage.migrateLayout({
      ownersOf: (hash) => (hash === h ? [20, 21] : []),
      userId: (name) => (name === 'olduser' ? 22 : undefined),
    })
    expect(await storage.size(20, h)).toBe(16)
    expect(await storage.size(21, h)).toBe(16)
    expect(existsSync(`${root}/${h}`)).toBe(false)
    expect(existsSync(`${root}/proofs`)).toBe(false)
    expect(await storage.size(22, h2)).toBe(17)
    expect(existsSync(`${root}/${hex('olduser')}`)).toBe(false)
    expect(existsSync(`${root}/${hex('gone')}/${h2}`)).toBe(true) // no such user: left for audit
    expect((await storage.list()).filter((o) => o.hash === h).map((o) => o.owner).sort()).toEqual([20, 21])
    await storage.delete(20, h); await storage.delete(21, h); await storage.delete(22, h2)
  })

  it('a failed object delete keeps the row; the next sweep retries and refunds', async () => {
    const d = Buffer.alloc(40, 5)
    await upload(a, P1, d, s.base)
    const before = (await a.get('/api/me')).body.bytesUsed
    sdb.prepare("UPDATE uploads SET state = 'deleting' WHERE hash = ?").run(sha(d))
    const ctx = { config: s.config, db: sdb }
    const failing: Storage = { ...storage, delete: async () => { throw new Error('boom') } } as Storage
    const log = console.error
    console.error = () => {}
    try {
      expect(await sweepSamples(ctx, failing)).toBe(0)
    } finally {
      console.error = log
    }
    expect(row(d)).toBeDefined()
    expect(await storage.size(uid(ADMIN, sdb), sha(d))).toBe(40)
    expect(await sweepSamples(ctx, storage)).toBe(1)
    expect(row(d)).toBeUndefined()
    expect(await storage.size(uid(ADMIN, sdb), sha(d))).toBeNull()
    expect((await a.get('/api/me')).body.bytesUsed).toBe(before - 40)
  })
})
