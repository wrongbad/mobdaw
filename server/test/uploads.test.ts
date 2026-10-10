import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db.ts'
import { createStorage, type Storage } from '../src/storage/index.ts'
import { ADMIN, admit, login, startTest, until, type Client } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client, alice: Client, bob: Client
let db: Db
let storage: Storage
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const P = (id: string) => `/api/projects/${id}/samples`
const mk = async (c: Client, name = 'P') => (await c.post('/api/projects', { name })).body.id as string
const share = (owner: Client, id: string, username: string, role?: string) => owner.post(`/api/projects/${id}/members`, { username, role })
const rows = (hash: string) => db.prepare('SELECT owner, state FROM uploads WHERE hash = ? ORDER BY owner').all(hash) as { owner: string; state: string }[]
async function upload(c: Client, project: string, d: Buffer, name?: string) {
  const up = await c.post(`${P(project)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav', name })
  if (!up.body.exists) {
    expect((await fetch(t.base + up.body.url, { method: 'PUT', body: d as BodyInit })).status).toBe(200)
    expect((await c.post(`${P(project)}/${sha(d)}/complete`)).body).toEqual({ ok: true })
  }
  return sha(d)
}

beforeAll(async () => {
  t = await startTest()
  admin = await login(t.base, ADMIN)
  alice = await admit(t.base, admin, 'alice')
  bob = await admit(t.base, admin, 'bob')
  db = openDb(t.config.dbPath)
  storage = createStorage(t.config, () => undefined)
})
afterAll(async () => {
  db.close()
  await t.cleanup()
})

describe('upload ownership', () => {
  it('lists only your own uploads, with names and the projects using them', async () => {
    const A = await mk(alice, 'Song')
    await share(alice, A, 'bob')
    const h = await upload(alice, A, Buffer.alloc(10, 1), 'kick.wav')
    expect((await alice.get('/api/uploads')).body).toMatchObject([{ hash: h, name: 'kick.wav', size: 10, projects: [{ id: A, name: 'Song' }], otherProjects: 0 }])
    expect((await bob.get('/api/uploads')).body).toEqual([]) // bob can use it in the project, but it isn't his
  })

  it("only the owner can delete or download an upload, and deleting removes it from every project, including others'", async () => {
    const A = await mk(alice, 'Shared')
    await share(alice, A, 'bob')
    const h = await upload(alice, A, Buffer.alloc(11, 2))
    expect((await bob.get(`${P(A)}/${h}/url`)).status).toBe(200)
    expect((await bob.del(`/api/uploads/${h}`)).status).toBe(404) // not bob's
    expect((await bob.get(`/api/uploads/${h}/url`)).status).toBe(404)

    const B = await mk(bob) // bob saves a copy: the link points at alice's upload
    expect((await bob.post(`/api/projects/${A}/copy`, { name: 'Bob copy' })).status).toBe(201)
    expect((await alice.del(`/api/uploads/${h}`)).body).toEqual({ ok: true })
    expect((await bob.get(`${P(A)}/${h}/url`)).status).toBe(404)
    const bobCopy = (await bob.get('/api/projects')).body.find((p: any) => p.name === 'Bob copy').id
    expect((await bob.get(`${P(bobCopy)}/${h}/url`)).status).toBe(404)
    expect((await bob.get(P(B))).body).toEqual([])
    await until(() => rows(h).length === 0)
    expect(await storage.size(h)).toBeNull()
  })

  it('identical files from two owners are two uploads: deleting one keeps the other and the bytes', async () => {
    const d = Buffer.alloc(12, 3)
    const A = await mk(alice), B = await mk(bob)
    const h = await upload(alice, A, d)
    await upload(bob, B, d) // proof-of-possession path: bob really uploads it
    expect(rows(h)).toEqual([{ owner: 'alice', state: 'complete' }, { owner: 'bob', state: 'complete' }])

    expect((await alice.del(`/api/uploads/${h}`)).body).toEqual({ ok: true })
    await until(() => rows(h).length === 1)
    expect(rows(h)).toEqual([{ owner: 'bob', state: 'complete' }])
    expect(await storage.size(h)).toBe(12) // bob still needs the bytes
    expect((await bob.get(`${P(B)}/${h}/url`)).status).toBe(200)
    expect((await alice.get(`${P(A)}/${h}/url`)).status).toBe(404)

    expect((await bob.del(`/api/uploads/${h}`)).body).toEqual({ ok: true })
    await until(() => rows(h).length === 0)
    expect(await storage.size(h)).toBeNull() // the last owner's delete removes the bytes
  })

  it('a shared library entry survives while another owner still has their own upload of it', async () => {
    const d = Buffer.alloc(13, 4)
    const A = await mk(alice)
    await share(alice, A, 'bob')
    const h = await upload(alice, A, d)
    expect((await bob.post(`${P(A)}/upload-url`, { hash: h, size: d.length, mime: 'audio/wav' })).body).toEqual({ exists: true }) // bob adds his own
    expect((await alice.get(P(A))).body).toHaveLength(1) // one library entry per file
    await alice.del(`/api/uploads/${h}`)
    expect((await bob.get(`${P(A)}/${h}/url`)).status).toBe(200) // bob's upload of the same file keeps it playable
    await bob.del(`/api/uploads/${h}`)
    expect((await bob.get(`${P(A)}/${h}/url`)).status).toBe(404)
  })

  it('bytes uploaded in parallel by someone else do not count as your proof', async () => {
    const d = Buffer.alloc(14, 5)
    const A = await mk(alice), B = await mk(bob)
    // both ask while nothing is complete, so both get a plain upload URL
    const upA = await alice.post(`${P(A)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav' })
    const upB = await bob.post(`${P(B)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav' })
    expect(upA.body.url).not.toContain('proof=')
    expect(upB.body.url).not.toContain('proof=')
    await fetch(t.base + upA.body.url, { method: 'PUT', body: d as BodyInit })
    expect((await alice.post(`${P(A)}/${sha(d)}/complete`)).body).toEqual({ ok: true })
    // bob never uploaded anything, but the object exists now: he is told to go through a proof upload
    const r = await bob.post(`${P(B)}/${sha(d)}/complete`)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('proof_required')
    const again = await bob.post(`${P(B)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav' })
    expect(again.body.url).toContain('proof=')
    await fetch(t.base + again.body.url, { method: 'PUT', body: d as BodyInit })
    expect((await bob.post(`${P(B)}/${sha(d)}/complete`)).body).toEqual({ ok: true })
  })
})
