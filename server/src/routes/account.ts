import { deleteCookie } from 'hono/cookie'
import { Hono } from 'hono'
import { SESSION_COOKIE, getUser, requireSignedIn, type Ctx, type Env } from '../auth.ts'
import { purgeAccount } from '../accounts.ts'
import type { Collab } from '../collab.ts'
import { PASSWORD_MAX, verifyPassword } from '../password.ts'
import type { Storage } from '../storage/index.ts'
import { sweepSamples } from './samples.ts'

export function accountRoutes(ctx: Ctx, storage: Storage, collab: Collab) {
  const r = new Hono<Env>()
  /**
   * Delete your account now, skipping the retention window: the projects you own (for every member) and
   * everything you uploaded are removed. Asks for the password so a stolen session can't do it.
   */
  r.post('/me/delete', requireSignedIn, async (c) => {
    const username = c.var.session!.username
    const user = getUser(ctx.db, username)!
    if (user.account_role === 'dev') return c.json({ error: 'forbidden' }, 403)
    const password = String((await c.req.json().catch(() => ({}))).password ?? '')
    if (!user.password_hash || password.length > PASSWORD_MAX || !(await verifyPassword(password, user.password_hash)))
      return c.json({ error: 'wrong_password' }, 403)
    purgeAccount(ctx, collab, username)
    deleteCookie(c, SESSION_COOKIE, { path: ctx.config.basePath || '/' })
    void sweepSamples(ctx, storage).catch((e) => console.error('sweep failed', e))
    return c.json({ ok: true })
  })

  return r
}
