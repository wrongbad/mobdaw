// The MCP endpoint (docs/agent-api.md "MCP"): the agent API's functions as tools over streamable HTTP at POST /mcp, authenticated with
// the same Bearer API token. Stateless: each request gets its own server and transport (there is nothing to resume; the work is in
// the project document and the event cursor), and answers with plain JSON.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { OPS_HELP } from './agentOps.ts'
import type { AgentUser } from './agentHub.ts'
import { AgentError, type AgentService } from './agentService.ts'
import { agentAuth, type AgentEnv } from './routes/agent.ts'
import type { Ctx } from './auth.ts'

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean }
const json = (v: unknown): Result => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] })

const ME = 'You act as "<your user> (api)" in the project, with that user\'s access. Mention a person in chat as @username; mention yourself or another agent as @username(api).'

/** One MCP server for one authenticated request. */
export function mcpServerFor(svc: AgentService, user: AgentUser): McpServer {
  const server = new McpServer({ name: 'mobdaw', version: '1.0.0' }, { instructions: `mobdaw is a collaborative music workstation. ${ME} Typical loop: wait_for_events, read what people asked in chat, get_state, apply_ops with a short label, reply with send_chat.` })
  const run = (fn: () => Promise<unknown>) => async (): Promise<Result> => {
    try {
      return json(await fn())
    } catch (e) {
      if (e instanceof AgentError) return { ...json({ error: e.code, message: e.message, ...e.extra }), isError: true }
      throw e
    }
  }
  const projectId = z.string().describe('project id from list_projects')

  server.registerTool('list_projects', {
    description: 'The projects you can work in (you are owner or editor), with your role and whether writes work right now (canEdit).',
  }, run(async () => svc.projects(user)))

  server.registerTool('get_state', {
    description: `The project as JSON or a compact text outline: timeline (tempo / meter regions), markers, tracks with devices (params by name), clips with start as "bar.beat.tick" and ticks, and notes {p:"C4", t, d, v}. "rev" is the latest history seq. ${ME}`,
    inputSchema: { projectId, format: z.enum(['json', 'text']).optional().describe('text is shorter, for reading; json for exact values (default json)') },
  }, ({ projectId, format }) => run(async () => svc.state(user, projectId, format ?? 'json'))())

  server.registerTool('apply_ops', {
    description: `Edit the project with a batch of ops: validated first, then applied all or nothing as ONE history entry attributed to you ("<user> (api)"). Returns {ids, seq}; an invalid op returns an error naming it and changes nothing.\n\n${OPS_HELP}`,
    inputSchema: {
      projectId,
      label: z.string().optional().describe('what this batch does, at most 40 characters: shown in the History panel'),
      ops: z.array(z.record(z.string(), z.any())).describe('the ops, in order'),
    },
  }, ({ projectId, label, ops }) => run(async () => svc.ops(user, projectId, { label, ops }))())

  server.registerTool('send_chat', {
    description: 'Post a message in the project chat as you ("<user> (api)"). @username mentions a person (they get a badge), @username(api) another agent.',
    inputSchema: { projectId, text: z.string().describe('the message') },
  }, ({ projectId, text }) => run(async () => svc.say(user, projectId, text))())

  server.registerTool('get_chat', {
    description: 'Recent chat messages (newest last), each with mentionsMe. Use since (a ts from an earlier call) to read only new ones.',
    inputSchema: { projectId, since: z.number().optional().describe('only messages with ts after this (ms)'), limit: z.number().optional() },
  }, ({ projectId, since, limit }) => run(async () => svc.chat(user, projectId, since, limit))())

  server.registerTool('wait_for_events', {
    description: 'Long-poll for what happened in the project since your cursor: new chat messages (with mentionsMe, true when someone mentioned @you(api)), other people\'s history entries, people joining and leaving. Returns at once if there are some, else after `wait` seconds (max 25) or when the first arrives. Pass the returned cursor as since next time; omit it the first time. While waiting you show as present in the project. gap: true means events before your cursor were not kept: re-read state and chat.',
    inputSchema: { projectId, since: z.number().optional().describe('cursor from the last call'), wait: z.number().optional().describe('seconds to wait for news, 0..25 (default 0)') },
  }, ({ projectId, since, wait }, extra) => run(async () => svc.events(user, projectId, since, wait ?? 0, extra.signal))())

  server.registerTool('get_history', {
    description: 'The project\'s change log, oldest first: {seq, ts, username, text, via, api}. Entries after `since` (a seq).',
    inputSchema: { projectId, since: z.number().optional(), limit: z.number().optional() },
  }, ({ projectId, since, limit }) => run(async () => svc.history(user, projectId, since, limit))())

  server.registerTool('revert', {
    description: 'Undo one history entry (anyone\'s): writes back what it changed, except fields changed since (reported as skipped). Logged as an entry of its own, so it can be reverted too.',
    inputSchema: { projectId, seq: z.number().int() },
  }, ({ projectId, seq }) => run(async () => svc.revert(user, projectId, seq))())

  server.registerTool('restore', {
    description: 'Put the whole project back to how it was right after history entry `seq`, undoing every later entry from everyone. Use with care; it is an entry of its own and can itself be reverted.',
    inputSchema: { projectId, seq: z.number().int() },
  }, ({ projectId, seq }) => run(async () => svc.restore(user, projectId, seq))())

  return server
}

/** `/mcp`: POST only (stateless; no server-initiated stream). */
export function mcpRoutes(ctx: Ctx, svc: AgentService) {
  const r = new Hono<AgentEnv>()
  // (the challenge points OAuth-capable clients at the metadata in oauth.ts)
  r.use('*', agentAuth(ctx, `Bearer resource_metadata="${ctx.config.publicUrl}/.well-known/oauth-protected-resource"`))
  r.post('/', async (c) => {
    const server = mcpServerFor(svc, c.var.agent)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    try {
      await server.connect(transport)
      return await transport.handleRequest(c.req.raw)
    } finally {
      // (the response is complete when handleRequest returns in JSON mode)
      void transport.close().catch(() => {})
      void server.close().catch(() => {})
    }
  })
  const no = (c: import('hono').Context) => c.json({ jsonrpc: '2.0', error: { code: -32000, message: 'use POST: this MCP server is stateless' }, id: null }, 405, { allow: 'POST' })
  r.get('/', no)
  r.delete('/', no)
  return r
}
