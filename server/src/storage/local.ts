import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { copyFile, mkdir, open, readdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Hono } from 'hono'
import { hmac, safeEqual } from '../auth.ts'
import type { Config } from '../config.ts'
import { isHash, objectKey, parseKey, parseLegacyKey, type LegacyOwners, type Storage, type StoredObject } from './index.ts'

const UPLOAD_TTL = 15 * 60 * 1000
const DOWNLOAD_TTL = 15 * 60 * 1000

export class LocalStorage implements Storage {
  routes = new Hono()

  constructor(private config: Config, getMime: (owner: number, hash: string) => string | undefined) {
    mkdirSync(config.storageDir, { recursive: true })

    // Authorized by signature alone (op is part of the signed data, so a GET url can't PUT).
    const check = (op: string, key: string, exp: string | undefined, sig: string | undefined) =>
      !!parseKey(key) && !!exp && !!sig && Number(exp) > Date.now() && safeEqual(sig, this.sign(op, key, exp))

    this.routes.get('/:dir/:hash', async (c) => {
      const key = `${c.req.param('dir')}/${c.req.param('hash')}`
      if (!check('get', key, c.req.query('exp'), c.req.query('sig'))) return c.json({ error: 'forbidden' }, 403)
      const f = await open(this.path(key)).catch(() => null)
      if (!f) return c.json({ error: 'not_found' }, 404)
      const { size } = await f.stat()
      const { owner, hash } = parseKey(key)!
      return new Response(f.createReadStream() as unknown as ReadableStream, {
        headers: {
          'Content-Type': getMime(owner, hash) ?? 'application/octet-stream',
          'Content-Length': String(size),
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      })
    })

    this.routes.put('/:dir/:hash', async (c) => {
      const key = `${c.req.param('dir')}/${c.req.param('hash')}`
      if (!check('put', key, c.req.query('exp'), c.req.query('sig'))) return c.json({ error: 'forbidden' }, 403)
      const body = c.req.raw.body
      if (!body) return c.json({ error: 'bad_request' }, 400)
      const max = config.maxUploadBytes
      if (Number(c.req.header('content-length') ?? 0) > max) return c.json({ error: 'too_large' }, 413)

      const path = this.path(key)
      const tmp = `${path}.${crypto.randomUUID()}.tmp`
      await mkdir(dirname(path), { recursive: true })
      const hasher = createHash('sha256')
      let n = 0
      try {
        await pipeline(
          Readable.fromWeb(body as never),
          async function* (src: AsyncIterable<Buffer>) {
            for await (const chunk of src) {
              n += chunk.length
              if (n > max) throw new RangeError('too_large')
              hasher.update(chunk)
              yield chunk
            }
          },
          createWriteStream(tmp),
        )
        if (hasher.digest('hex') !== c.req.param('hash')) {
          await rm(tmp, { force: true })
          return c.json({ error: 'hash_mismatch' }, 400)
        }
        await rename(tmp, path)
        return c.body(null, 200)
      } catch (e) {
        await rm(tmp, { force: true })
        if (e instanceof RangeError) return c.json({ error: 'too_large' }, 413)
        throw e
      }
    })
  }

  private path(key: string) {
    return join(this.config.storageDir, key)
  }

  private sign(op: string, key: string, exp: string | number) {
    return hmac(this.config.sessionSecret, `${op}:${key}:${exp}`)
  }

  private url(op: 'get' | 'put', key: string, ttl: number) {
    const exp = Date.now() + ttl
    return `${this.config.basePath}/api/storage/${key}?exp=${exp}&sig=${this.sign(op, key, exp)}`
  }

  async uploadUrl(owner: number, hash: string) {
    return { url: this.url('put', objectKey(owner, hash), UPLOAD_TTL), headers: {} }
  }
  async downloadUrl(owner: number, hash: string) {
    return this.url('get', objectKey(owner, hash), DOWNLOAD_TTL)
  }
  async size(owner: number, hash: string) {
    return (await stat(this.path(objectKey(owner, hash))).catch(() => null))?.size ?? null
  }
  async copy(from: number, to: number, hash: string) {
    const dest = this.path(objectKey(to, hash))
    const tmp = `${dest}.${crypto.randomUUID()}.tmp`
    await mkdir(dirname(dest), { recursive: true })
    try {
      await copyFile(this.path(objectKey(from, hash)), tmp)
      await rename(tmp, dest)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
  }
  async list() {
    const out: StoredObject[] = []
    for (const dir of await readdir(this.config.storageDir)) {
      for (const f of await readdir(join(this.config.storageDir, dir)).catch(() => [])) {
        const o = parseKey(`${dir}/${f}`)
        if (o) out.push(o)
      }
    }
    return out
  }
  async delete(owner: number, hash: string) {
    await rm(this.path(objectKey(owner, hash)), { force: true })
  }
  async migrateLayout(legacy: LegacyOwners) {
    const root = this.config.storageDir
    // Oldest layout: STORAGE_DIR/<hash>, plus temporary proof uploads under STORAGE_DIR/proofs/.
    await rm(join(root, 'proofs'), { recursive: true, force: true })
    for (const hash of (await readdir(root)).filter(isHash)) {
      try {
        for (const owner of legacy.ownersOf(hash)) {
          const dest = this.path(objectKey(owner, hash))
          await mkdir(dirname(dest), { recursive: true })
          await copyFile(join(root, hash), `${dest}.tmp`)
          await rename(`${dest}.tmp`, dest)
        }
        await rm(join(root, hash), { force: true })
      } catch (e) {
        console.error(`storage migration: ${hash}`, e)
      }
    }
    // Previous layout: STORAGE_DIR/<hex(username)>/<hash>.
    for (const dir of await readdir(root)) {
      for (const f of await readdir(join(root, dir)).catch(() => [])) {
        const old = parseLegacyKey(`${dir}/${f}`)
        const id = old ? legacy.userId(old.username) : undefined
        if (!old || id === undefined) continue // gone user: left for `audit` to report
        try {
          const dest = this.path(objectKey(id, old.hash))
          await mkdir(dirname(dest), { recursive: true })
          await rename(join(root, dir, f), dest)
        } catch (e) {
          console.error(`storage migration: ${dir}/${f}`, e)
        }
      }
      if (parseLegacyKey(`${dir}/${'0'.repeat(64)}`)) await rmdir(join(root, dir)).catch(() => {}) // only succeeds when empty
    }
  }
}
