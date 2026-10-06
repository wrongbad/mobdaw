import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { CreateInviteResponse, InviteInfo } from '@mobdaw/shared'
import { getMe, isAdmitted, requireAdmin, requireSignedIn, upsertUser, type Ctx, type Env } from '../auth.ts'
import { tx } from '../db.ts'

type InviteRow = {
  token: string; created_by: string; created_at: number; expires_at: number | null
  redeemed_by: string | null; redeemed_at: number | null
}

export function createInvite(ctx: Ctx, createdBy: string, expiresInDays?: number): CreateInviteResponse {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const exp = expiresInDays ? now + expiresInDays * 86400_000 : null
  ctx.db.prepare('INSERT INTO invites(token, created_by, created_at, expires_at) VALUES(?,?,?,?)').run(token, createdBy, now, exp)
  return { token, url: `${ctx.config.publicUrl}/#/invite/${token}` }
}

export const listInvites = (ctx: Ctx): InviteInfo[] =>
  (ctx.db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as InviteRow[]).map((i) => ({
    token: i.token, createdBy: i.created_by, createdAt: i.created_at, expiresAt: i.expires_at,
    redeemedBy: i.redeemed_by, redeemedAt: i.redeemed_at,
  }))

export function inviteRoutes(ctx: Ctx) {
  const r = new Hono<Env>()

  r.post('/invites', requireAdmin(ctx), async (c) => {
    const { expiresInDays } = await c.req.json().catch(() => ({}))
    if (expiresInDays != null && !(Number(expiresInDays) > 0)) return c.json({ error: 'bad_request' }, 400)
    return c.json(createInvite(ctx, c.var.session!.email, expiresInDays && Number(expiresInDays)))
  })

  r.get('/invites', requireAdmin(ctx), (c) => c.json(listInvites(ctx)))

  r.post('/invites/:token/redeem', requireSignedIn, (c) => {
    const s = c.var.session!
    if (isAdmitted(ctx, s.email)) return c.json(getMe(ctx, s)) // not consumed
    const result = tx(ctx.db, () => {
      const inv = ctx.db.prepare('SELECT * FROM invites WHERE token = ?').get(c.req.param('token')) as InviteRow | undefined
      if (!inv) return 404
      if (inv.redeemed_by) return 'invite_used'
      if (inv.expires_at && inv.expires_at < Date.now()) return 'invite_expired'
      ctx.db.prepare('UPDATE invites SET redeemed_by = ?, redeemed_at = ? WHERE token = ?').run(s.email, Date.now(), inv.token)
      upsertUser(ctx, s.email, s.name)
      return 200
    })
    if (result === 404) return c.json({ error: 'not_found' }, 404)
    if (result !== 200) return c.json({ error: result }, 410)
    return c.json(getMe(ctx, s))
  })

  return r
}
