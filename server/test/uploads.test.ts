import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb, type Db } from '../src/db.ts'
import { createStorage, type Storage } from '../src/storage/index.ts'
import { ADMIN, admit, login, pw, startTest, until, userId, client, type Client } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client, alice: Client, bob: Client
let db: Db
let storage: Storage
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const P = (id: string) => `/api/projects/${id}/samples`
const mk = async (c: Client, name = 'P') => (await c.post('/api/projects', { name })).body.id as string
const share = (owner: Client, id: string, username: string, role?: string) => owner.post(`/api/projects/${id}/members`, { username, role })
const uid = (username: string) => userId(db, username)
const rows = (hash: string) =>
  db.prepare('SELECT u.username AS owner, s.state FROM uploads s JOIN users u ON u.id = s.owner_id WHERE s.hash = ? ORDER BY u.username').all(hash) as { owner: string; state: string }[]
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
    expect(await storage.size(uid('alice'), h)).toBeNull()
  })

  it('identical files from two owners are two uploads with their own bytes: deleting one keeps the other', async () => {
    const d = Buffer.alloc(12, 3)
    const A = await mk(alice), B = await mk(bob)
    const h = await upload(alice, A, d)
    await upload(bob, B, d) // no access to alice's: bob uploads his own
    expect(rows(h)).toEqual([{ owner: 'alice', state: 'complete' }, { owner: 'bob', state: 'complete' }])

    expect((await alice.del(`/api/uploads/${h}`)).body).toEqual({ ok: true })
    await until(() => rows(h).length === 1)
    expect(rows(h)).toEqual([{ owner: 'bob', state: 'complete' }])
    expect(await storage.size(uid('alice'), h)).toBeNull()
    expect(await storage.size(uid('bob'), h)).toBe(12)
    expect((await bob.get(`${P(B)}/${h}/url`)).status).toBe(200)
    expect((await alice.get(`${P(A)}/${h}/url`)).status).toBe(404)

    expect((await bob.del(`/api/uploads/${h}`)).body).toEqual({ ok: true })
    await until(() => rows(h).length === 0)
    expect(await storage.size(uid('bob'), h)).toBeNull()
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
    expect(await storage.size(uid('bob'), h)).toBe(13) // his own copy of the bytes
    await bob.del(`/api/uploads/${h}`)
    expect((await bob.get(`${P(A)}/${h}/url`)).status).toBe(404)
  })

  it('identical files uploaded in parallel by two users each go to their own object', async () => {
    const d = Buffer.alloc(14, 5)
    const A = await mk(alice), B = await mk(bob)
    const upA = await alice.post(`${P(A)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav' })
    const upB = await bob.post(`${P(B)}/upload-url`, { hash: sha(d), size: d.length, mime: 'audio/wav' })
    expect(upA.body.url).not.toBe(upB.body.url)
    await fetch(t.base + upA.body.url, { method: 'PUT', body: d as BodyInit })
    expect((await alice.post(`${P(A)}/${sha(d)}/complete`)).body).toEqual({ ok: true })
    // bob never uploaded anything: alice's bytes don't count for him
    expect((await bob.post(`${P(B)}/${sha(d)}/complete`)).body.error).toBe('not_uploaded')
    await fetch(t.base + upB.body.url, { method: 'PUT', body: d as BodyInit })
    expect((await bob.post(`${P(B)}/${sha(d)}/complete`)).body).toEqual({ ok: true })
  })

  it('a username can change: session, projects, uploads and stored bytes follow the id', async () => {
    const carol = await admit(t.base, admin, 'carol')
    const A = await mk(carol, 'Mine')
    await share(carol, A, 'bob')
    const h = await upload(carol, A, Buffer.alloc(15, 6))
    const id = uid('carol')
    db.prepare("UPDATE users SET username = 'carol2' WHERE id = ?").run(id)

    expect((await carol.get('/api/me')).body.username).toBe('carol2') // same token
    expect((await carol.get('/api/projects')).body).toMatchObject([{ id: A, ownerUsername: 'carol2', role: 'owner' }])
    expect((await bob.get(`/api/projects/${A}`)).body.members.map((m: any) => m.username)).toEqual(['carol2', 'bob'])
    expect((await carol.get('/api/uploads')).body).toMatchObject([{ hash: h }])
    expect((await bob.get(P(A))).body).toMatchObject([{ hash: h, owner: 'carol2' }])
    const { url } = (await carol.get(`${P(A)}/${h}/url`)).body
    expect((await fetch(t.base + url)).status).toBe(200)
    expect(await storage.size(id, h)).toBe(15)
    expect((await client(t.base).post('/api/auth/login', { username: 'carol', password: pw('carol') })).status).toBe(401)
    expect((await client(t.base).post('/api/auth/login', { username: 'carol2', password: pw('carol') })).status).toBe(200)
  })
})

describe('upload analysis', () => {
  const analysis = { info: { format: 'WAV', encoding: '16-bit PCM', sampleRate: 48000, channels: 2, duration: 1.5 }, peaks: 'AAECAw==' }

  it('is null until the owner saves it, then listed with the upload; others cannot set it', async () => {
    const A = await mk(alice, 'Measured')
    const h = await upload(alice, A, Buffer.alloc(12, 7), 'tone.wav')
    expect((await alice.get('/api/uploads')).body.find((u: any) => u.hash === h).analysis).toBeNull()
    expect((await bob.put(`/api/uploads/${h}/analysis`, analysis)).status).toBe(404)
    expect((await alice.put(`/api/uploads/${h}/analysis`, analysis)).body).toEqual({ ok: true })
    expect((await alice.get('/api/uploads')).body.find((u: any) => u.hash === h).analysis).toEqual(analysis)
  })

  it('rejects a malformed analysis', async () => {
    const A = await mk(alice, 'Bad')
    const h = await upload(alice, A, Buffer.alloc(13, 8))
    for (const body of [{}, { info: analysis.info, peaks: '<script>' }, { info: { ...analysis.info, channels: -1 }, peaks: '' }])
      expect((await alice.put(`/api/uploads/${h}/analysis`, body)).status).toBe(400)
  })
})
