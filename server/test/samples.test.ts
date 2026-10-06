import { createHash } from 'node:crypto'
import { existsSync, utimesSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db.ts'
import { sweepSamples } from '../src/routes/samples.ts'
import { createStorage, type Storage } from '../src/storage/index.ts'
import { ADMIN, admit, client, login, startTest, until, type Client } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client, alice: Client, bob: Client
let db: Db
let storage: Storage
let pA: string
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const put = (url: string, body: Buffer | string, base = t.base) => fetch(base + url, { method: 'PUT', body: body as BodyInit })
const P = (id: string) => `/api/projects/${id}/samples`
const mk = async (c: Client, name = 'P') => (await c.post('/api/projects', { name })).body.id as string
const share = (owner: Client, id: string, email: string, role?: string) => owner.post(`/api/projects/${id}/members`, { email, role })
/** Full upload flow into a project; returns the hash. */
async function upload(c: Client, project: string, d: Buffer, base = t.base) {
  const up = await c.post(`${P(project)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav' })
  if (!up.body.exists) {
    expect((await put(up.body.url, d, base)).status).toBe(200)
    expect((await c.post(`${P(project)}/${sha(d)}/complete`)).body).toEqual({ ok: true })
  }
  return sha(d)
}
const state = (hash: string) => (db.prepare('SELECT state FROM samples WHERE hash = ?').get(hash) as { state: string } | undefined)?.state
const used = async (c: Client) => (await c.get('/api/me')).body.bytesUsed as number

beforeAll(async () => {
  t = await startTest({ MAX_UPLOAD_BYTES: '1000', USER_QUOTA_BYTES: '1500' })
  admin = await login(t.base, ADMIN)
  alice = await admit(t.base, admin, 'alice@x.com')
  bob = await admit(t.base, admin, 'bob@x.com')
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
    expect(up.body.url).toMatch(new RegExp(`^/api/storage/${hash}\\?exp=\\d+&sig=`))

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
    expect((await admin.get(P(pA))).body).toMatchObject([{ hash, size: 600, mime: 'audio/wav', addedBy: ADMIN }])
  })

  it('storage urls are signature-checked', async () => {
    const { url } = (await admin.get(`${P(pA)}/${hash}/url`)).body
    expect((await fetch(t.base + url.replace(/sig=./, 'sig=x'))).status).toBe(403)
    expect((await fetch(t.base + `/api/storage/${hash}`)).status).toBe(403)
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

  it('requires admitted user, membership and valid input', async () => {
    const u = await login(t.base, 'out@x.com')
    expect((await u.post(`${P(pA)}/upload-url`, { hash, size: 1, mime: 'a/b' })).body.error).toBe('not_invited')
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
    await share(admin, A, 'alice@x.com')
    const h = await upload(admin, B, Buffer.alloc(11, 21))
    expect((await alice.get(`${P(A)}/${h}/url`)).status).toBe(404)
    expect((await admin.get(`${P(A)}/${h}/url`)).status).toBe(404) // even the owner: not linked here
    expect((await admin.get(`${P(B)}/${h}/url`)).status).toBe(200)
  })

  it('viewers can download but not upload', async () => {
    const A = await mk(admin)
    const h = await upload(admin, A, Buffer.alloc(12, 22))
    await share(admin, A, 'alice@x.com', 'viewer')
    expect((await alice.get(`${P(A)}/${h}/url`)).status).toBe(200)
    expect((await alice.get(P(A))).body).toHaveLength(1)
    expect((await alice.post(`${P(A)}/upload-url`, { hash: h, size: 12, mime: 'audio/wav' })).status).toBe(403)
    expect((await alice.post(`${P(A)}/${h}/complete`)).status).toBe(403)
    await share(admin, A, 'alice@x.com', 'editor') // role update
    expect((await alice.post(`${P(A)}/upload-url`, { hash: h, size: 12, mime: 'audio/wav' })).body).toEqual({ exists: true })
  })

  it('dedupe leak: no access means a real upload, and no second charge', async () => {
    const A = await mk(admin), B = await mk(bob)
    const d = Buffer.alloc(13, 23)
    const h = await upload(admin, A, d)
    const adminUsed = await used(admin)
    const up = await bob.post(`${P(B)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })
    expect(up.body.exists).toBe(false)
    expect(up.body.url).toBeTruthy()
    expect((await bob.get(`${P(B)}/${h}/url`)).status).toBe(404) // not linked until a real upload
    expect((await put(up.body.url, d)).status).toBe(200)
    expect((await bob.post(`${P(B)}/${h}/complete`)).body).toEqual({ ok: true })
    expect((await bob.get(`${P(B)}/${h}/url`)).status).toBe(200)
    expect(await used(bob)).toBe(0)
    expect(await used(admin)).toBe(adminUsed)
  })

  it('proof of possession: skipping the PUT, wrong bytes, and reusing another user\'s proof all fail', async () => {
    const A = await mk(admin), B = await mk(bob), C = await mk(alice)
    const d = Buffer.alloc(15, 25)
    const h = await upload(admin, A, d)
    const adminUsed = await used(admin)
    const proofFile = (url: string) => `${t.config.storageDir}/proofs/${h}.${new URL(t.base + url).searchParams.get('proof')}`

    // no PUT: refused, no link, and the original object does not count as proof
    const skip = await bob.post(`${P(B)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })
    expect(skip.body.url).toContain('proof=')
    const r = await bob.post(`${P(B)}/${h}/complete`)
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('not_uploaded')
    expect((await bob.get(P(B))).body).toEqual([])

    // wrong bytes are rejected by the PUT itself
    const bad = await put(skip.body.url, Buffer.alloc(15, 99))
    expect(bad.status).toBe(400)
    expect((await bob.post(`${P(B)}/${h}/complete`)).status).toBe(400)

    // another user's proof URL can't be reused: alice's proof key differs, so alice has nothing uploaded
    expect((await put(skip.body.url, d)).status).toBe(200)
    const al = await alice.post(`${P(C)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })
    expect(al.body.url).not.toBe(skip.body.url)
    expect((await alice.post(`${P(C)}/${h}/complete`)).status).toBe(400)
    // bob's proof is also bound to his project: the same user can't claim it elsewhere
    const B2 = await mk(bob)
    await bob.post(`${P(B2)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })
    expect((await bob.post(`${P(B2)}/${h}/complete`)).status).toBe(400)

    // legit: bob's own proof links, the proof file disappears, no second charge
    expect(existsSync(proofFile(skip.body.url))).toBe(true)
    expect((await bob.post(`${P(B)}/${h}/complete`)).body).toEqual({ ok: true })
    expect(existsSync(proofFile(skip.body.url))).toBe(false)
    expect((await bob.get(`${P(B)}/${h}/url`)).status).toBe(200)
    expect(await used(bob)).toBe(0)
    expect(await used(admin)).toBe(adminUsed)
    expect(await storage.size(h)).toBe(15) // original untouched
  })

  it('within-access dedupe links without uploading', async () => {
    const A = await mk(admin), B = await mk(admin)
    const d = Buffer.alloc(14, 24)
    const h = await upload(admin, A, d)
    expect((await admin.post(`${P(B)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })).body).toEqual({ exists: true })
    expect((await admin.get(P(B))).body.map((s: any) => s.hash)).toEqual([h])
    expect((await admin.get(`${P(B)}/${h}/url`)).status).toBe(200)
  })
})

describe('delete and refcount', () => {
  it('purges unshared samples, keeps shared ones, refunds, and tombstones block re-upload', async () => {
    const A = await mk(admin), B = await mk(admin)
    await share(admin, A, 'bob@x.com')
    const dx = Buffer.alloc(31, 31), dy = Buffer.alloc(32, 32)
    const X = await upload(admin, A, dx)
    await admin.post(`${P(B)}/upload-url`, { hash: X, size: dx.length, mime: 'audio/wav' }) // links X into B
    const Y = await upload(bob, A, dy)
    expect(await used(bob)).toBe(32)
    const storage = createStorage(t.config, () => undefined)

    expect((await alice.del(`/api/projects/${A}`)).status).toBe(404)
    expect((await bob.del(`/api/projects/${A}`)).status).toBe(403) // editor can't delete
    expect((await admin.del(`/api/projects/${A}`)).body).toEqual({ ok: true })
    expect((await admin.get(`/api/projects/${A}`)).status).toBe(404)
    await until(() => state(Y) === undefined)

    expect(await storage.size(Y)).toBeNull()
    expect(await used(bob)).toBe(0) // refunded
    expect(state(X)).toBe('complete')
    expect(await storage.size(X)).toBe(31)
    expect((await admin.get(`${P(B)}/${X}/url`)).status).toBe(200)
  })

  it('upload-url for a deleting sample returns 409', async () => {
    const A = await mk(admin)
    const d = Buffer.alloc(33, 33)
    const h = await upload(admin, A, d)
    db.prepare("UPDATE samples SET state = 'deleting' WHERE hash = ?").run(h)
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
  const age = (d: Buffer, ms: number) => sdb.prepare('UPDATE samples SET created_at = created_at - ? WHERE hash = ?').run(ms, sha(d))
  const row = (d: Buffer) => sdb.prepare('SELECT * FROM samples WHERE hash = ?').get(sha(d))
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
    expect(await storage.size(sha(d1))).toBeNull()
    expect(await storage.size(sha(d3))).toBe(300) // complete: untouched
    expect(row(d4)).toBeDefined() // fresh: untouched
    expect((await up(d2)).status).toBe(200) // reservation freed: 300 used + 100 + 700 pending
  })

  it('/complete is refused once the window has passed', async () => {
    age(d2, 31 * 60 * 1000)
    const r = await a.post(`${P(P1)}/${sha(d2)}/complete`)
    expect(r.status).toBe(410)
    expect(r.body.error).toBe('upload_expired')
  })

  it('sweeps abandoned local proofs older than an hour', async () => {
    const d = Buffer.alloc(16, 6)
    await upload(a, P1, d, s.base)
    const other = await admit(s.base, a, 'zed@x.com')
    const P3 = await mk(other)
    const up = await other.post(`${P(P3)}/upload-url`, { hash: sha(d), size: 16, mime: 'audio/wav' })
    expect((await put(up.body.url, d, s.base)).status).toBe(200)
    const f = `${s.config.storageDir}/proofs/${sha(d)}.${new URL(s.base + up.body.url).searchParams.get('proof')}`
    expect(existsSync(f)).toBe(true)
    await sweepSamples({ config: s.config, db: sdb }, storage)
    expect(existsSync(f)).toBe(true) // fresh: kept
    const old = new Date(Date.now() - 2 * hour)
    utimesSync(f, old, old)
    await sweepSamples({ config: s.config, db: sdb }, storage)
    expect(existsSync(f)).toBe(false)
    expect(await storage.size(sha(d))).toBe(16) // the sample itself is untouched
  })

  it('a failed object delete keeps the row; the next sweep retries and refunds', async () => {
    const d = Buffer.alloc(40, 5)
    await upload(a, P1, d, s.base)
    const before = (await a.get('/api/me')).body.bytesUsed
    sdb.prepare("UPDATE samples SET state = 'deleting' WHERE hash = ?").run(sha(d))
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
    expect(await storage.size(sha(d))).toBe(40)
    expect(await sweepSamples(ctx, storage)).toBe(1)
    expect(row(d)).toBeUndefined()
    expect(await storage.size(sha(d))).toBeNull()
    expect((await a.get('/api/me')).body.bytesUsed).toBe(before - 40)
  })
})
