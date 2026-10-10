import { Database } from '@hocuspocus/extension-database'
import { Server } from '@hocuspocus/server'
import { docName } from '@mobdaw/shared'
import { memberRole, sessionUser, writeBlock, type Ctx } from './auth.ts'

export type Collab = ReturnType<typeof createCollab>

/** Close open connections to a project's document (one user's, or everyone's); clients re-check access. */
export function kick(collab: Collab, projectId: string, username?: string) {
  for (const c of collab.hocuspocus.documents.get(docName(projectId))?.getConnections() ?? [])
    if (!username || c.context.username === username) c.close({ code: 1000, reason: KICK_REASON })
}
export const KICK_REASON = 'access_changed'

/** Close every open document connection a user has, across projects. */
export function kickUser(collab: Collab, username: string) {
  for (const doc of collab.hocuspocus.documents.values())
    for (const c of doc.getConnections()) if (c.context.username === username) c.close({ code: 1000, reason: KICK_REASON })
}

/**
 * Drop connections that can still write although their user or project is now read-only (a plan change made
 * outside this process, e.g. by the admin CLI). The client reconnects and gets a read-only connection.
 */
export function enforceReadOnly(ctx: Ctx, collab: Collab) {
  for (const [name, doc] of collab.hocuspocus.documents)
    for (const c of doc.getConnections())
      if (!c.readOnly && writeBlock(ctx, name.slice('project:'.length), c.context.username)) c.close({ code: 1000, reason: KICK_REASON })
}

/** Hocuspocus server; the caller swaps in its own HTTP request handler (see main.ts). */
export function createCollab(ctx: Ctx) {
  const { db, config } = ctx
  return new Server({
    port: config.port, // listen() is called without a port: it ignores 0
    quiet: true,
    stopOnSignals: false,
    extensions: [
      {
        // Only /collab upgrades are WebSocket connections; drop everything else.
        async onUpgrade({ request, socket }) {
          if (new URL(request.url ?? '/', 'http://x').pathname !== '/collab') {
            socket.destroy()
            throw null // swallowed by Hocuspocus: stops further handling
          }
        },
      },
      new Database({
        async fetch({ documentName }) {
          const row = db.prepare('SELECT data FROM documents WHERE name = ?').get(documentName) as { data: Uint8Array } | undefined
          return row ? new Uint8Array(row.data) : null
        },
        async store({ documentName, state }) {
          // A deleted project's doc may still be flushing: don't resurrect its row.
          if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(documentName.slice(8))) return
          db.prepare(
            `INSERT INTO documents(name, data, updated_at) VALUES(?,?,?)
             ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
          ).run(documentName, state, Date.now())
        },
      }),
    ],
    async onAuthenticate({ token, documentName, connectionConfig }) {
      const username = sessionUser(ctx, token)
      const projectId = documentName.startsWith('project:') ? documentName.slice(8) : null
      if (!username) throw new Error('not_signed_in')
      const role = projectId && memberRole(ctx, projectId, username)
      if (!role) throw new Error('forbidden')
      connectionConfig.readOnly = role === 'viewer' || !!writeBlock(ctx, projectId!, username)
      return { username, role }
    },
  })
}
