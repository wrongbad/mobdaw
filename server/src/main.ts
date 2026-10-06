import { getRequestListener } from '@hono/node-server'
import { createApp } from './app.ts'
import type { Ctx } from './auth.ts'
import { createCollab } from './collab.ts'
import { loadConfig, type Config } from './config.ts'
import { openDb } from './db.ts'
import { sweepSamples } from './routes/samples.ts'
import { createStorage } from './storage/index.ts'

/** Start HTTP API + /collab WebSocket on one port. Port 0 picks a random one. */
export async function startServer(config: Config) {
  const db = openDb(config.dbPath)
  const ctx: Ctx = { config, db }
  const storage = createStorage(config, (hash) =>
    (db.prepare('SELECT mime FROM samples WHERE hash = ?').get(hash) as { mime: string } | undefined)?.mime,
  )
  const collab = createCollab(ctx)
  // Hocuspocus owns the http.Server; replace its placeholder handler with the Hono app.
  collab.httpServer.removeAllListeners('request')
  collab.httpServer.on('request', getRequestListener(createApp(ctx, storage, collab).fetch))
  await collab.listen()
  const sweep = () => sweepSamples(ctx, storage).catch((e) => console.error('sweep failed', e))
  const sweeper = setInterval(sweep, 15 * 60 * 1000).unref()
  let closing: Promise<void> | undefined
  const close = () => (closing ??= (async () => {
    clearInterval(sweeper)
    collab.httpServer.closeAllConnections()
    await collab.destroy() // flushes pending document stores
    db.close()
  })())
  return { port: collab.address.port, close }
}

if (import.meta.main) {
  const config = loadConfig()
  const server = await startServer(config)
  console.log(`mobdaw server listening on :${server.port} (auth=${config.authMode}, storage=${config.storageDriver})`)
  const stop = () => server.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
