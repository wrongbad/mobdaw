import { getRequestListener } from '@hono/node-server'
import { createApp } from './app.ts'
import type { Ctx } from './auth.ts'
import { endExpiredSubscriptions, purgeExpiredData } from './accounts.ts'
import { createCollab, enforceReadOnly } from './collab.ts'
import { loadConfig, type Config } from './config.ts'
import { openDb } from './db.ts'
import { sweepSamples } from './routes/samples.ts'
import { createStorage } from './storage/index.ts'

/** Start HTTP API + /collab WebSocket on one port. Port 0 picks a random one. */
export async function startServer(config: Config) {
  const db = openDb(config.dbPath)
  const ctx: Ctx = { config, db }
  const storage = createStorage(config, (owner, hash) =>
    (db.prepare('SELECT mime FROM uploads WHERE owner_id = ? AND hash = ?').get(owner, hash) as { mime: string } | undefined)?.mime,
  )
  // Objects stored under an older layout move to u<owner id>/<hash>. Before serving, so downloads find them.
  await storage.migrateLayout({
    ownersOf: (hash) =>
      (db.prepare("SELECT owner_id FROM uploads WHERE hash = ? AND state != 'pending'").all(hash) as { owner_id: number }[]).map((r) => r.owner_id),
    userId: (username) => (db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined)?.id,
  })
  const collab = createCollab(ctx)
  // Hocuspocus owns the http.Server; replace its placeholder handler with the Hono app.
  collab.httpServer.removeAllListeners('request')
  collab.httpServer.on('request', getRequestListener(createApp(ctx, storage, collab).fetch))
  await collab.listen()
  const sweep = () =>
    Promise.resolve(endExpiredSubscriptions(ctx, collab))
      .then(() => purgeExpiredData(ctx, storage, collab))
      .then(() => sweepSamples(ctx, storage))
      .catch((e) => console.error('sweep failed', e))
  const sweeper = setInterval(sweep, 15 * 60 * 1000).unref()
  // Plan changes made outside this process (the admin CLI) reach open connections within a minute.
  const enforcer = setInterval(() => enforceReadOnly(ctx, collab), 60 * 1000).unref()
  let closing: Promise<void> | undefined
  const close = () => (closing ??= (async () => {
    clearInterval(sweeper)
    clearInterval(enforcer)
    collab.httpServer.closeAllConnections()
    await collab.destroy() // flushes pending document stores
    db.close()
  })())
  return { port: collab.address.port, close, ctx, storage, collab }
}

if (import.meta.main) {
  const config = loadConfig()
  const server = await startServer(config)
  console.log(`mobdaw server listening on :${server.port} (storage=${config.storageDriver})`)
  const stop = () => server.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
