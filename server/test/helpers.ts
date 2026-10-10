import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HocuspocusProvider } from '@hocuspocus/provider'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { loadConfig, type Config } from '../src/config.ts'
import { createUser, getUser } from '../src/auth.ts'
import { openDb } from '../src/db.ts'
import { startServer } from '../src/main.ts'

export const ADMIN = 'admin'
export const pw = (username: string) => `${username}-password`

export async function startTest(env: Record<string, string> = {}, dir = mkdtempSync(join(tmpdir(), 'mobdaw-'))) {
  const config: Config = loadConfig({
    PORT: '0',
    DB_PATH: join(dir, 'db.sqlite'),
    STORAGE_DIR: join(dir, 'samples'),
    SESSION_SECRET: 'test-secret',
    ...env,
  })
  // Bootstrap the admin the way `admin create-user --admin` would (the first user needs no invite).
  const db = openDb(config.dbPath)
  if (!getUser(db, ADMIN)) await createUser({ config, db }, ADMIN, pw(ADMIN), true)
  db.close()
  const server = await startServer(config)
  const base = `http://127.0.0.1:${server.port}`
  return {
    dir, base, port: server.port, config, ctx: server.ctx, storage: server.storage, collab: server.collab,
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

export async function login(base: string, username: string, password = pw(username)) {
  const r = await client(base).post('/api/auth/login', { username, password })
  if (!r.body?.token) throw new Error(`login failed for ${username}: ${JSON.stringify(r.body)}`)
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

/** Register `username` with an invite from `admin` and return its client. */
export async function admit(base: string, admin: Client, username: string) {
  const invite = (await admin.post('/api/invites')).body.token
  const r = await client(base).post('/api/auth/register', { username, password: pw(username), invite })
  if (!r.body?.token) throw new Error(`register failed for ${username}: ${JSON.stringify(r.body)}`)
  return client(base, r.body.token)
}
