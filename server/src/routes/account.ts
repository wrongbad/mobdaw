import { deleteCookie } from 'hono/cookie'
import { Hono } from 'hono'
import { createApiToken, listApiTokens, revokeApiToken } from '../apiTokens.ts'
import type { AgentHub } from '../agentHub.ts'
import { kickToken } from '../collab.ts'
import { SESSION_COOKIE, getUser, requireSignedIn, type Ctx, type Env } from '../auth.ts'
import { deleteAccount } from '../accounts.ts'
import type { Collab } from '../collab.ts'
import { PASSWORD_MAX, verifyPassword } from '../password.ts'
import type { Storage } from '../storage/index.ts'
import { sweepSamples } from './samples.ts'

export const API_TOKENS_MAX = 20

export function accountRoutes(ctx: Ctx, storage: Storage, collab: Collab, hub: AgentHub) {
  const r = new Hono<Env>()
  // API tokens for the agent API (docs/agent-api.md). Managed with a session only: a token can't make or list tokens.
  r.get('/me/api-tokens', requireSignedIn, (c) => c.json(listApiTokens(ctx, c.var.session!.id)))
  r.post('/me/api-tokens', requireSignedIn, async (c) => {
    const userId = c.var.session!.id
    if (listApiTokens(ctx, userId).length >= API_TOKENS_MAX) return c.json({ error: 'too_many_tokens' }, 409)
    const name = String((await c.req.json().catch(() => ({}))).name ?? '')
    return c.json(createApiToken(ctx, userId, name), 201)
  })
  r.delete('/me/api-tokens/:id', requireSignedIn, async (c) => {
    const hash = revokeApiToken(ctx, c.var.session!.id, Number(c.req.param('id')))
    if (!hash) return c.json({ error: 'not_found' }, 404)
    kickToken(collab, hash) // open collab connections made with it end now,
    await hub.dropToken(hash) // and so does its presence
    return c.json({ ok: true })
  })

  /**
   * Delete your account now: the projects you own (for every member) and everything you uploaded are removed, with the account.
   * This is the only way an account is ever deleted. Asks for the password so a stolen session can't do it.
   */
  r.post('/me/delete', requireSignedIn, async (c) => {
    const userId = c.var.session!.id
    const user = getUser(ctx.db, userId)!
    if (user.account_role === 'dev') return c.json({ error: 'forbidden' }, 403)
    const password = String((await c.req.json().catch(() => ({}))).password ?? '')
    if (!user.password_hash || password.length > PASSWORD_MAX || !(await verifyPassword(password, user.password_hash)))
      return c.json({ error: 'wrong_password' }, 403)
    deleteAccount(ctx, collab, userId)
    deleteCookie(c, SESSION_COOKIE, { path: ctx.config.basePath || '/' })
    void sweepSamples(ctx, storage).catch((e) => console.error('sweep failed', e))
    return c.json({ ok: true })
  })

  return r
}
