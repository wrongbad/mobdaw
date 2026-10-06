import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { loadConfig, type Config } from '../src/config.ts'
import { startServer } from '../src/main.ts'

export const ADMIN = 'admin@x.com'

export async function startTest(env: Record<string, string> = {}, dir = mkdtempSync(join(tmpdir(), 'mobdaw-'))) {
  const config: Config = loadConfig({
    PORT: '0',
    ADMIN_EMAILS: ADMIN,
    DB_PATH: join(dir, 'db.sqlite'),
    STORAGE_DIR: join(dir, 'samples'),
    SESSION_SECRET: 'test-secret',
    ...env,
  })
  const server = await startServer(config)
  const base = `http://127.0.0.1:${server.port}`
  return {
    dir, base, port: server.port, config,
    close: () => server.close(),
    cleanup: async () => { await server.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

export type Client = ReturnType<typeof client>

/** Tiny fetch wrapper that sends a Bearer token. */
export function client(base: string, token?: string) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token && { authorization: `Bearer ${token}` }), ...(body !== undefined && { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    return { status: res.status, body: json as any }
  }
  return {
    token,
    get: (p: string) => call('GET', p),
    post: (p: string, b: unknown = {}) => call('POST', p, b),
    patch: (p: string, b: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  }
}

export async function login(base: string, email: string, name?: string) {
  const r = await client(base).post('/api/auth/login', { email, name })
  return client(base, r.body.token)
}

export function connect(port: number, project: string, token: string) {
  const doc = new Y.Doc()
  // WebSocketPolyfill is forwarded to the socket but missing from the provider's config type.
  const config = { url: `ws://127.0.0.1:${port}/collab`, name: `project:${project}`, document: doc, token, WebSocketPolyfill: WebSocket }
  const provider = new HocuspocusProvider(config)
  return { doc, provider }
}

export const until = async (fn: () => boolean, ms = 5000) => {
  const t = Date.now()
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Admit `email` via an invite from `admin` and return its client. */
export async function admit(base: string, admin: Client, email: string) {
  const c = await login(base, email)
  await c.post(`/api/invites/${(await admin.post('/api/invites')).body.token}/redeem`)
  return c
}
