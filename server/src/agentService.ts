// The agent API's operations, as functions of (user, project): the HTTP routes (routes/agent.ts) and the MCP tools (mcp.ts) are
// thin wrappers over these. Every call checks that the user may use the project (owner or editor: viewers don't take part live),
// marks the agent as present, and acts as "<user> (api)".
import {
  addChatMessage, agentText, agentView, apiName, type ViewFilter, chatLog, deviceCatalogText, parseMentions, mentionHandle, samplesMap, userColor,
  type ChatMessage, type HistoryItem, type HistoryResult,
} from '@mobdaw/shared'
import { isDevUser, memberRole, writeBlock, type Ctx } from './auth.ts'
import { applyOps, OpError, OPS_HELP, type OpsResult } from './agentOps.ts'
import type { AgentHub, AgentUser, EventsResult } from './agentHub.ts'
import { linkedOwner } from './routes/samples.ts'
import { lastSeq, listHistory, restoreTo, revertEntry, writeAs, type Collab } from './history.ts'

/** A refused call: `status` is the HTTP status, `code` the machine-readable error (`message` says more). */
export class AgentError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message ?? code)
  }
}

export type AgentProject = { id: string; name: string; role: 'owner' | 'editor' | 'viewer'; /** False for viewers and frozen projects. */ canEdit: boolean }
export type AgentChatMessage = ChatMessage & { mentionsMe: boolean }

const who = (u: AgentUser) => ({ userId: u.id, username: apiName(u.username), via: 'api' })

export function createAgentService(ctx: Ctx, collab: Collab, hub: AgentHub) {
  /** The user's role in the project if they may use the agent API in it. */
  function access(user: AgentUser, projectId: string, write = false) {
    const role = memberRole(ctx, projectId, user.id)
    if (!role) throw new AgentError(404, 'not_found', 'no such project (or you are not a member)')
    if (role === 'viewer') throw new AgentError(403, 'forbidden', 'viewers cannot use the agent API: it takes part live, which needs the owner or editor role')
    if (write) {
      const blocked = writeBlock(ctx, projectId, user.id)
      if (blocked) throw new AgentError(403, blocked, blocked === 'account_read_only' ? 'your account is read-only' : 'the project is frozen (its owner is read-only)')
    }
    return role
  }
  const num = (v: unknown) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)

  return {
    hub,
    /** The projects the user can work in (owner or editor roles; `canEdit` says whether writes work right now). */
    projects(user: AgentUser): AgentProject[] {
      const rows = (isDevUser(ctx, user.id)
        ? ctx.db.prepare("SELECT id, name, 'owner' AS role FROM projects ORDER BY created_at DESC").all()
        : ctx.db.prepare(
            `SELECT p.id, p.name, m.role FROM projects p JOIN project_members m ON m.project_id = p.id
             WHERE m.user_id = ? AND m.role IN ('owner','editor') ORDER BY p.created_at DESC`,
          ).all(user.id)) as { id: string; name: string; role: 'owner' | 'editor' }[]
      return rows.map((r) => ({ ...r, canEdit: !writeBlock(ctx, r.id, user.id) }))
    },

    async state(user: AgentUser, projectId: string, format: 'json' | 'text' = 'json', filter: ViewFilter = {}) {
      access(user, projectId)
      const doc = await hub.touch(projectId, user)
      const rev = lastSeq(ctx, projectId)
      return format === 'text' ? agentText(doc, rev, filter) : agentView(doc, rev, filter)
    },

    /** Validate and apply a batch of ops in one transaction (all or nothing). */
    async ops(user: AgentUser, projectId: string, body: { label?: unknown; ops?: unknown }): Promise<OpsResult> {
      access(user, projectId, true)
      await hub.touch(projectId, user)
      try {
        return await applyOps(ctx, collab, projectId, { id: user.id, username: user.username }, { label: body.label, ops: body.ops })
      } catch (e) {
        if (e instanceof OpError) throw new AgentError(400, 'bad_ops', e.message, { op: e.index >= 0 ? e.index : undefined })
        throw e
      }
    },

    async chat(user: AgentUser, projectId: string, since?: unknown, limit?: unknown): Promise<{ messages: AgentChatMessage[]; ts: number }> {
      access(user, projectId)
      const doc = await hub.touch(projectId, user)
      const me = apiName(user.username)
      const after = num(since) ?? 0
      const all = chatLog(doc).toArray().filter((m) => m.ts > after)
      const messages = all.slice(-Math.min(200, Math.max(1, num(limit) ?? 50))).map((m) => ({
        ...m,
        mentionsMe: m.username !== me && !m.system && ((m.mentions ?? []).includes(me) || parseMentions(m.text, [mentionHandle(me)]).includes(me)),
      }))
      return { messages, ts: chatLog(doc).toArray().at(-1)?.ts ?? after }
    },

    async say(user: AgentUser, projectId: string, text: unknown): Promise<ChatMessage> {
      access(user, projectId, true)
      if (typeof text !== 'string' || !text.trim()) throw new AgentError(400, 'bad_request', '"text" is required')
      await hub.touch(projectId, user)
      const name = apiName(user.username)
      const { value } = await writeAs(collab, projectId, who(user), '', (doc) => {
        const id = addChatMessage(doc, { username: name, color: userColor(name) }, text, hub.handles(projectId))
        return chatLog(doc).toArray().find((m) => m.id === id)
      })
      if (!value) throw new AgentError(400, 'bad_request', 'empty message')
      return value
    },

    async history(user: AgentUser, projectId: string, since?: unknown, limit?: unknown): Promise<HistoryItem[]> {
      access(user, projectId)
      await hub.touch(projectId, user)
      return listHistory(ctx, projectId, num(since) ?? 0, num(limit) ?? 200)
    },

    async revert(user: AgentUser, projectId: string, seq: number): Promise<HistoryResult> {
      return this.undo(revertEntry, user, projectId, seq)
    },
    async restore(user: AgentUser, projectId: string, seq: number): Promise<HistoryResult> {
      return this.undo(restoreTo, user, projectId, seq)
    },
    async undo(run: typeof revertEntry, user: AgentUser, projectId: string, seq: number): Promise<HistoryResult> {
      access(user, projectId, true)
      if (!Number.isInteger(seq)) throw new AgentError(400, 'bad_request', 'seq must be an integer')
      await hub.touch(projectId, user)
      const res = await run(ctx, collab, projectId, seq, who(user))
      if (!res) throw new AgentError(404, 'not_found', 'no such history entry (unknown or pruned)')
      return res
    },

    async events(user: AgentUser, projectId: string, since: unknown, wait: unknown, signal?: AbortSignal): Promise<EventsResult> {
      access(user, projectId)
      return hub.events(projectId, user, num(since), num(wait) ?? 0, signal)
    },

    /** The owner whose stored copy of the project's sample to download. 404: not a sample of this project; 409: not uploaded yet. */
    async sampleOwner(user: AgentUser, projectId: string, hash: string): Promise<number> {
      access(user, projectId)
      const doc = await hub.touch(projectId, user)
      const meta = samplesMap(doc).get(hash)
      const owner = linkedOwner(ctx.db, projectId, hash)
      if (owner == null && !meta) throw new AgentError(404, 'not_found', 'no such sample in this project')
      // (the take is still on the recorder's device, or its upload has not finished)
      if (owner == null || meta?.status === 'incoming') throw new AgentError(409, 'sample_incoming', 'the sample has not been uploaded yet: wait for its "sample" event or retry')
      return owner
    },

    catalog: () => `${OPS_HELP}\n\nDevice types and their params:\n${deviceCatalogText()}`,
  }
}
export type AgentService = ReturnType<typeof createAgentService>
