import { Database } from '@hocuspocus/extension-database'
import { Server } from '@hocuspocus/server'
import { docName } from '@mobdaw/shared'
import { memberRole, sessionUser, type Ctx } from './auth.ts'

export type Collab = ReturnType<typeof createCollab>

/** Close open connections to a project's document (one user's, or everyone's); clients re-check access. */
export function kick(collab: Collab, projectId: string, username?: string) {
  for (const c of collab.hocuspocus.documents.get(docName(projectId))?.getConnections() ?? [])
    if (!username || c.context.username === username) c.close({ code: 1000, reason: KICK_REASON })
}
export const KICK_REASON = 'access_changed'

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
      connectionConfig.readOnly = role === 'viewer'
      return { username, role }
    },
  })
}
