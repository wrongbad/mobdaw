import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Me, Role } from '@mobdaw/shared'
import type { Config } from './config.ts'
import type { Db } from './db.ts'

export const SESSION_COOKIE = 'mobdaw_session'
export const SESSION_MS = 30 * 24 * 3600 * 1000

export type Session = { email: string; name: string; exp: number }
export type Env = { Variables: { session: Session | null } }
export type Ctx = { config: Config; db: Db }

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** Constant-time HMAC-SHA256 (base64url) of `data`. */
export const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url')

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function signSession(secret: string, email: string, name: string): string {
  const body = b64u(JSON.stringify({ email, name, exp: Date.now() + SESSION_MS } satisfies Session))
  return `${body}.${hmac(secret, body)}`
}

export function verifySession(secret: string, token: string | undefined | null): Session | null {
  const [body, sig, extra] = (token ?? '').split('.')
  if (!body || !sig || extra !== undefined || !safeEqual(sig, hmac(secret, body))) return null
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as Session
    return typeof s.email === 'string' && s.exp > Date.now() ? s : null
  } catch {
    return null
  }
}

export const isAdminEmail = (ctx: Ctx, email: string) => ctx.config.adminEmails.includes(email)

type UserRow = { email: string; name: string | null; is_admin: number; bytes_used: number }
const getUser = (db: Db, email: string) =>
  db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined

export const isAdmitted = (ctx: Ctx, email: string) => isAdminEmail(ctx, email) || !!getUser(ctx.db, email)
export const isAdmin = (ctx: Ctx, email: string) => isAdminEmail(ctx, email) || !!getUser(ctx.db, email)?.is_admin

/** The user's membership role in a project, or undefined. */
export function memberRole(ctx: Ctx, projectId: string, email: string) {
  return (ctx.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND email = ?').get(projectId, email) as
    | { role: Role }
    | undefined)?.role
}

/** Insert the user (idempotent); admin emails are always flagged is_admin. */
export function upsertUser(ctx: Ctx, email: string, name: string) {
  ctx.db
    .prepare(
      `INSERT INTO users(email, name, is_admin, created_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, is_admin = MAX(is_admin, excluded.is_admin)`,
    )
    .run(email, name, isAdminEmail(ctx, email) ? 1 : 0, Date.now())
}

export function getMe(ctx: Ctx, s: Session): Me {
  const u = getUser(ctx.db, s.email)
  const admitted = isAdmitted(ctx, s.email)
  return {
    email: s.email,
    name: u?.name || s.name,
    admitted,
    isAdmin: isAdmin(ctx, s.email),
    bytesUsed: u?.bytes_used ?? 0,
    quotaBytes: ctx.config.userQuotaBytes,
  }
}

/** Reads the session from the cookie or `Authorization: Bearer`; sets c.var.session (or null). */
export const sessionMiddleware = (ctx: Ctx): MiddlewareHandler<Env> => async (c, next) => {
  const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
  c.set('session', verifySession(ctx.config.sessionSecret, bearer ?? getCookie(c, SESSION_COOKIE)))
  await next()
}

export const requireSignedIn: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.var.session) return c.json({ error: 'not_signed_in' }, 401)
  await next()
}

export const requireAdmitted = (ctx: Ctx): MiddlewareHandler<Env> => async (c, next) => {
  const s = c.var.session
  if (!s) return c.json({ error: 'not_signed_in' }, 401)
  if (!isAdmitted(ctx, s.email)) return c.json({ error: 'not_invited' }, 403)
  await next()
}

export const requireAdmin = (ctx: Ctx): MiddlewareHandler<Env> => async (c, next) => {
  const s = c.var.session
  if (!s) return c.json({ error: 'not_signed_in' }, 401)
  if (!isAdmitted(ctx, s.email)) return c.json({ error: 'not_invited' }, 403)
  if (!isAdmin(ctx, s.email)) return c.json({ error: 'forbidden' }, 403)
  await next()
}

export const sessionOf = (c: Context<Env>) => c.var.session!
