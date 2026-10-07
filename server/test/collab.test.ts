import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addAudioClip, addTrack, getClips, getTracks } from '@mobdaw/shared'
import { ADMIN, admit, connect, login, startTest, until, type Client } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let admin: Client, alice: Client, outsider: Client
let projectId: string

beforeAll(async () => {
  t = await startTest()
  admin = await login(t.base, ADMIN)
  alice = await admit(t.base, admin, 'alice')
  outsider = await admit(t.base, admin, 'outsider')
  projectId = (await admin.post('/api/projects', { name: 'P' })).body.id
  await admin.post(`/api/projects/${projectId}/members`, { username: 'alice' })
})
afterAll(() => t.cleanup())

const failsAuth = (token: string, project = projectId) =>
  new Promise<void>((resolve, reject) => {
    const { provider } = connect(t.port, project, token)
    provider.on('authenticationFailed', () => { provider.destroy(); resolve() })
    provider.on('synced', () => { provider.destroy(); reject(new Error('synced but should be rejected')) })
    setTimeout(() => reject(new Error('timeout')), 5000)
  })

describe('collab', () => {
  it('rejects non-member, bad token, unknown doc', async () => {
    await failsAuth(outsider.token!)
    await failsAuth('garbage')
    await failsAuth(alice.token!, 'nonexistent1')
    await expect(fetch(t.base + '/collab')).resolves.toBeTruthy() // plain HTTP on /collab doesn't crash
  })

  it('members sync and see each other', async () => {
    const a = connect(t.port, projectId, admin.token!)
    const b = connect(t.port, projectId, alice.token!)
    await until(() => a.provider.synced && b.provider.synced)
    const tid = addTrack(a.doc, 'Drums')
    addAudioClip(a.doc, { trackId: tid, sourceHash: 'h'.repeat(64), start: 48000, length: 96000 })
    await until(() => getClips(b.doc).length === 1)
    expect(getTracks(b.doc)[0].name).toBe('Drums')
    addTrack(b.doc, 'Bass')
    await until(() => getTracks(a.doc).length === 2)
    expect(getTracks(a.doc).map((x) => x.name)).toEqual(['Drums', 'Bass'])
    a.provider.destroy(); b.provider.destroy()
  })

  it('persists across restart', async () => {
    const c = connect(t.port, projectId, admin.token!)
    await until(() => c.provider.synced)
    addTrack(c.doc, 'Persisted')
    await until(() => c.provider.unsyncedChanges === 0)
    c.provider.destroy()
    await t.close() // flushes pending stores
    // restart on same DB (new random port; session secret is fixed in test env)
    const t2 = await startTest({}, t.dir)
    try {
      const d = connect(t2.port, projectId, admin.token!)
      await until(() => d.provider.synced)
      expect(getTracks(d.doc).map((x) => x.name)).toContain('Persisted')
      expect(getTracks(d.doc).map((x) => x.name)).toContain('Drums')
      d.provider.destroy()
    } finally {
      await t2.close()
    }
  })
})
