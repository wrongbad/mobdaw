import { Database } from '@hocuspocus/extension-database'
import { Server } from '@hocuspocus/server'
import { docName, samplesMap } from '@mobdaw/shared'
import { apiTokenUser } from './apiTokens.ts'
import { memberRole, sessionUser, writeBlock, type Ctx } from './auth.ts'
import { apiName } from '@mobdaw/shared'
import { attachHistory } from './history.ts'
import type { Link } from './uploads.ts'

export type Collab = ReturnType<typeof createCollab>

/** Close open connections to a project's document (one user's, or everyone's); clients re-check access. */
export function kick(collab: Collab, projectId: string, userId?: number) {
  for (const c of collab.hocuspocus.documents.get(docName(projectId))?.getConnections() ?? [])
    if (userId === undefined || c.context.userId === userId) c.close({ code: 1000, reason: KICK_REASON })
}
export const KICK_REASON = 'access_changed'

/** Close the document connections made with one API token (it was revoked). */
export function kickToken(collab: Collab, tokenHash: string) {
  for (const doc of collab.hocuspocus.documents.values())
    for (const c of doc.getConnections()) if (c.context.tokenHash === tokenHash) c.close({ code: 1000, reason: KICK_REASON })
}

/** Close every open document connection a user has, across projects. */
export function kickUser(collab: Collab, userId: number) {
  for (const doc of collab.hocuspocus.documents.values())
    for (const c of doc.getConnections()) if (c.context.userId === userId) c.close({ code: 1000, reason: KICK_REASON })
}

/**
 * Drop connections whose user or project is now read-only (a plan change made outside this process, e.g. by the
 * admin CLI). The client reloads and gets a snapshot instead (see `GET /projects/:id/snapshot`).
 */
export function enforceReadOnly(ctx: Ctx, collab: Collab) {
  for (const [name, doc] of collab.hocuspocus.documents)
    for (const c of doc.getConnections()) {
      if (writeBlock(ctx, name.slice('project:'.length), c.context.userId)) c.close({ code: 1000, reason: KICK_REASON })
      // an API token revoked by another process (the admin CLI)
      else if (c.context.tokenHash && !ctx.db.prepare('SELECT 1 FROM api_tokens WHERE token_hash = ?').get(c.context.tokenHash)) c.close({ code: 1000, reason: KICK_REASON })
    }
}

/**
 * Audio left these projects (its upload was deleted): where no one else's copy of it is still linked, mark the sample
 * `missing` in the document, so clients show it as deleted (docs/engine.md §9.3). Best effort.
 */
export async function markMissing(ctx: Ctx, collab: Collab, links: Link[]) {
  const linked = ctx.db.prepare('SELECT 1 FROM project_samples WHERE project_id = ? AND hash = ?')
  const exists = ctx.db.prepare('SELECT 1 FROM projects WHERE id = ?')
  const byProject = new Map<string, string[]>()
  for (const l of links) if (!linked.get(l.project_id, l.hash) && exists.get(l.project_id)) byProject.set(l.project_id, [...(byProject.get(l.project_id) ?? []), l.hash])
  for (const [id, hashes] of byProject) {
    try {
      const conn = await collab.hocuspocus.openDirectConnection(docName(id))
      try {
        await conn.transact((doc) => {
          const m = samplesMap(doc)
          for (const h of hashes) {
            const s = m.get(h)
            if (s && !s.status) m.set(h, { ...s, status: 'missing' })
          }
        })
      } finally {
        await conn.disconnect()
      }
    } catch (e) {
      console.error(`marking missing audio in ${id} failed`, e)
    }
  }
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
      // The shared change log: every loaded project document is mirrored and its transactions become history entries.
      { afterLoadDocument: async ({ document, documentName }) => attachHistory(ctx, document, documentName) },
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
    // Only collaborators who can write take part live (edits, presence, chat). Everyone else with access (viewers,
    // public visitors, frozen projects and read-only accounts) gets a snapshot over HTTP and edits their own copy.
    async onAuthenticate({ token, documentName }) {
      // An API token takes part as "<user> (api)" (via: 'api'); it is the same membership, only the name and attribution differ.
      const api = apiTokenUser(ctx, token)
      const user = api ?? sessionUser(ctx, token)
      if (!user) throw new Error('not_signed_in')
      const projectId = documentName.startsWith('project:') ? documentName.slice(8) : null
      const role = projectId && memberRole(ctx, projectId, user.id)
      if (role !== 'owner' && role !== 'editor') throw new Error('forbidden')
      if (writeBlock(ctx, projectId!, user.id)) throw new Error('forbidden')
      return api ? { userId: user.id, username: apiName(user.username), role, via: 'api', tokenHash: api.tokenHash } : { userId: user.id, username: user.username, role }
    },
  })
}
