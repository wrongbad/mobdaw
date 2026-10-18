import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createStorage } from '../src/storage/index.ts'
import { ADMIN, login, startTest } from './helpers.ts'

describe('local storage url key', () => {
  it('is stored in the DB, so signed urls verify after a restart', async () => {
    const t = await startTest()
    const data = Buffer.from('some audio bytes')
    const hash = createHash('sha256').update(data).digest('hex')
    const admin = await login(t.base, ADMIN)
    const { id } = (await admin.post('/api/projects', { name: 'P' })).body
    const { url } = (await admin.post(`/api/projects/${id}/samples/upload-url`, { hash, size: data.length, mime: 'audio/wav' })).body
    await t.close()

    const t2 = await startTest({}, t.dir) // same DB, new process-equivalent
    try {
      expect((await fetch(t2.base + url, { method: 'PUT', body: data as BodyInit })).status).toBe(200)
      const row = t2.ctx.db.prepare("SELECT value FROM settings WHERE key = 'storage_url_key'").get() as { value: string }
      expect(row.value).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await t2.close()
      rmSync(t.dir, { recursive: true, force: true })
    }
  })
  it('two storages on one DB agree; a different DB does not', async () => {
    const t = await startTest()
    const other = await startTest()
    try {
      const a = createStorage(t.config, t.ctx.db, () => undefined), b = createStorage(t.config, t.ctx.db, () => undefined)
      const hash = 'a'.repeat(64)
      const sig = (u: string) => new URL(u, 'http://x').searchParams.get('sig')
      const u1 = await a.downloadUrl(1, hash)
      const exp = new URL(u1, 'http://x').searchParams.get('exp')
      const forged = u1.replace(/sig=.*/, 'sig=AAAA')
      expect((await fetch(t.base + forged)).status).toBe(403)
      expect((await fetch(t.base + u1)).status).toBe(404) // valid signature, no such object
      const o = createStorage(other.config, other.ctx.db, () => undefined)
      const foreign = await o.downloadUrl(1, hash)
      expect(sig(foreign)).not.toBe(sig(u1))
      expect((await fetch(t.base + foreign)).status).toBe(403)
      expect((await fetch(t.base + (await b.downloadUrl(1, hash)))).status).toBe(404) // b's url verifies too
      expect(exp).toBeTruthy()
    } finally {
      await t.cleanup()
      await other.cleanup()
    }
  })
})
