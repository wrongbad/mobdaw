import { Hono, type Context, type MiddlewareHandler } from 'hono'
import { sessionUser, type Ctx } from '../auth.ts'
import { apiTokenUser } from '../apiTokens.ts'
import type { AgentUser } from '../agentHub.ts'
import { AgentError, type AgentService } from '../agentService.ts'

export type AgentEnv = { Variables: { agent: AgentUser } }

/**
 * Who is calling: an API token, or (for scripts that have one) a session token; both as `Authorization: Bearer`. The cookie is not
 * accepted here, so a page in the user's browser can't make these calls for them.
 */
export const agentAuth = (ctx: Ctx, challenge = 'Bearer'): MiddlewareHandler<AgentEnv> => async (c, next) => {
  const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
  const api = apiTokenUser(ctx, bearer)
  const user = api ? { id: api.id, username: api.username, key: api.tokenHash } : (() => {
    const s = sessionUser(ctx, bearer)
    return s && { id: s.id, username: s.username, key: `s:${s.id}` }
  })()
  if (!user) return c.json({ error: 'not_signed_in', message: 'send an API token as "Authorization: Bearer <token>" (create one on the account page)' }, 401, { 'www-authenticate': challenge })
  c.set('agent', user)
  await next()
}

/** Run a service call, turning its AgentError into the JSON error response. */
export const failure = (c: Context, e: unknown) => {
  if (e instanceof AgentError) return c.json({ error: e.code, message: e.message, ...e.extra }, e.status)
  throw e
}

/** The agent API, mounted at /agent: JSON for programs (docs/agent-api.md). */
export function agentRoutes(ctx: Ctx, svc: AgentService) {
  const r = new Hono<AgentEnv>()
  r.use('*', agentAuth(ctx))
  const handle = (fn: (c: Context<AgentEnv>, user: AgentUser, id: string) => Promise<Response | unknown> | Response | unknown) => async (c: Context<AgentEnv>) => {
    try {
      const out = await fn(c, c.var.agent, c.req.param('id') ?? '')
      return out instanceof Response ? out : c.json(out as object)
    } catch (e) {
      return failure(c, e)
    }
  }

  r.get('/projects', handle((_c, u) => svc.projects(u)))
  r.get('/catalog', handle((c) => c.text(svc.catalog())))
  r.get('/projects/:id/state', handle(async (c, u, id) => {
    const format = c.req.query('format') ?? 'json'
    if (format !== 'json' && format !== 'text') throw new AgentError(400, 'bad_request', 'format is json or text')
    const out = await svc.state(u, id, format)
    return typeof out === 'string' ? c.text(out) : out
  }))
  r.post('/projects/:id/ops', handle(async (c, u, id) => svc.ops(u, id, await c.req.json().catch(() => ({})))))
  r.get('/projects/:id/chat', handle((c, u, id) => svc.chat(u, id, c.req.query('since'), c.req.query('limit'))))
  r.post('/projects/:id/chat', handle(async (c, u, id) => svc.say(u, id, (await c.req.json().catch(() => ({}))).text)))
  r.get('/projects/:id/history', handle((c, u, id) => svc.history(u, id, c.req.query('since'), c.req.query('limit'))))
  r.post('/projects/:id/history/:seq/revert', handle((c, u, id) => svc.revert(u, id, Number(c.req.param('seq')))))
  r.post('/projects/:id/history/:seq/restore', handle((c, u, id) => svc.restore(u, id, Number(c.req.param('seq')))))
  r.get('/projects/:id/events', handle((c, u, id) => svc.events(u, id, c.req.query('since'), c.req.query('wait'), c.req.raw.signal)))
  r.notFound((c) => c.json({ error: 'not_found' }, 404))
  return r
}
