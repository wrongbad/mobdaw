import { randomBytes } from 'node:crypto'
import { Hono } from 'hono'
import type { CreateInviteResponse, InviteInfo } from '@mobdaw/shared'
import { requireAdmin, type Ctx, type Env } from '../auth.ts'

type InviteRow = {
  token: string; created_by: string; created_at: number; expires_at: number | null
  redeemed_by: string | null; redeemed_at: number | null
}

export function createInvite(ctx: Ctx, createdBy: string, expiresInDays?: number): CreateInviteResponse {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const exp = expiresInDays ? now + expiresInDays * 86400_000 : null
  ctx.db.prepare('INSERT INTO invites(token, created_by, created_at, expires_at) VALUES(?,?,?,?)').run(token, createdBy, now, exp)
  return { token, url: `${ctx.config.publicUrl}/#/register/${token}` }
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
    return c.json(createInvite(ctx, c.var.session!.username, expiresInDays && Number(expiresInDays)))
  })

  r.get('/invites', requireAdmin(ctx), (c) => c.json(listInvites(ctx)))

  return r
}
