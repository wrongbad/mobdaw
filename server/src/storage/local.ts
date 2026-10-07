import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Hono } from 'hono'
import { hmac, safeEqual } from '../auth.ts'
import type { Config } from '../config.ts'
import { isHash, type Storage } from './index.ts'

const UPLOAD_TTL = 15 * 60 * 1000
const DOWNLOAD_TTL = 15 * 60 * 1000

export class LocalStorage implements Storage {
  routes = new Hono()

  constructor(private config: Config, getMime: (hash: string) => string | undefined) {
    mkdirSync(config.storageDir, { recursive: true })
    const path = (hash: string, proof?: string) => this.path(hash, proof)

    // Authorized by signature alone (op is part of the signed data, so a GET url can't PUT).
    const check = (op: string, hash: string, exp: string | undefined, sig: string | undefined, proof?: string) =>
      isHash(hash) && !!exp && !!sig && Number(exp) > Date.now() && safeEqual(sig, this.sign(op, hash, exp, proof))

    this.routes.get('/:hash', async (c) => {
      const hash = c.req.param('hash')
      if (!check('get', hash, c.req.query('exp'), c.req.query('sig'))) return c.json({ error: 'forbidden' }, 403)
      const f = await open(path(hash)).catch(() => null)
      if (!f) return c.json({ error: 'not_found' }, 404)
      const { size } = await f.stat()
      return new Response(f.createReadStream() as unknown as ReadableStream, {
        headers: {
          'Content-Type': getMime(hash) ?? 'application/octet-stream',
          'Content-Length': String(size),
          'Cache-Control': 'private, max-age=31536000, immutable',
        },
      })
    })

    this.routes.put('/:hash', async (c) => {
      const hash = c.req.param('hash')
      const proof = c.req.query('proof')
      if (!check('put', hash, c.req.query('exp'), c.req.query('sig'), proof)) return c.json({ error: 'forbidden' }, 403)
      const body = c.req.raw.body
      if (!body) return c.json({ error: 'bad_request' }, 400)
      const max = config.maxUploadBytes
      if (Number(c.req.header('content-length') ?? 0) > max) return c.json({ error: 'too_large' }, 413)

      const tmp = `${path(hash, proof)}.${crypto.randomUUID()}.tmp`
      if (proof) await mkdir(join(config.storageDir, 'proofs'), { recursive: true })
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
        if (hasher.digest('hex') !== hash) {
          await rm(tmp, { force: true })
          return c.json({ error: 'hash_mismatch' }, 400)
        }
        await rename(tmp, path(hash, proof))
        return c.body(null, 200)
      } catch (e) {
        await rm(tmp, { force: true })
        if (e instanceof RangeError) return c.json({ error: 'too_large' }, 413)
        throw e
      }
    })
  }

  private path(hash: string, proof?: string) {
    return proof ? join(this.config.storageDir, 'proofs', `${hash}.${proof}`) : join(this.config.storageDir, hash)
  }

  private sign(op: string, hash: string, exp: string | number, proof = '') {
    return hmac(this.config.sessionSecret, `${op}:${hash}:${exp}:${proof}`)
  }

  private url(op: 'get' | 'put', hash: string, ttl: number, proof?: string) {
    const exp = Date.now() + ttl
    return `${this.config.basePath}/api/storage/${hash}?exp=${exp}&sig=${this.sign(op, hash, exp, proof)}${proof ? `&proof=${proof}` : ''}`
  }

  async uploadUrl(hash: string, _size: number, _mime: string, proof?: string) {
    return { url: this.url('put', hash, UPLOAD_TTL, proof), headers: {} }
  }
  async downloadUrl(hash: string) {
    return this.url('get', hash, DOWNLOAD_TTL)
  }
  async size(hash: string, proof?: string) {
    return (await stat(this.path(hash, proof)).catch(() => null))?.size ?? null
  }
  async list() {
    return (await readdir(this.config.storageDir)).filter(isHash)
  }
  async delete(hash: string, proof?: string) {
    await rm(this.path(hash, proof), { force: true })
  }
  async expireProofs(ms: number) {
    const dir = join(this.config.storageDir, 'proofs')
    for (const f of await readdir(dir).catch(() => [])) {
      const st = await stat(join(dir, f)).catch(() => null)
      if (st && st.mtimeMs < Date.now() - ms) await rm(join(dir, f), { force: true })
    }
  }
}
