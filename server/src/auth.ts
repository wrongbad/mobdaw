import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { GRANDFATHERED_MONTHS, addMonths, type Me, type Role } from '@mobdaw/shared'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import { hashPassword } from './password.ts'

export const SESSION_COOKIE = 'mobdaw_session'
export const SESSION_MS = 30 * 24 * 3600 * 1000

/** The signed token holds only the user's id: usernames can change. */
export type SessionToken = { uid: number; exp: number }
/** The signed-in user of a request. Key everything by `id`; `username` is for display. */
export type Session = { id: number; username: string }
export type Env = { Variables: { session: Session | null } }
export type Ctx = { config: Config; db: Db }

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** Constant-time HMAC-SHA256 (base64url) of `data`. */
export const hmac = (secret: string, data: string) => createHmac('sha256', secret).update(data).digest('base64url')

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function signSession(secret: string, userId: number): string {
  const body = b64u(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_MS } satisfies SessionToken))
  return `${body}.${hmac(secret, body)}`
}

export function verifySession(secret: string, token: string | undefined | null): SessionToken | null {
  const [body, sig, extra] = (token ?? '').split('.')
  if (!body || !sig || extra !== undefined || !safeEqual(sig, hmac(secret, body))) return null
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionToken
    return Number.isInteger(s.uid) && s.exp > Date.now() ? s : null
  } catch {
    return null
  }
}

export type UserRow = {
  id: number; username: string; password_hash: string | null; is_admin: number; account_role: 'user' | 'dev'; bytes_used: number
  plan_status: 'active' | 'read_only'; retention_ends_at: number | null; paid_through: number; data_purged_at: number | null
}
export const getUser = (db: Db, id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
export const findUser = (db: Db, username: string) => db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined

/** Accounts with role 'dev' own every project, but only while the localhost-only DEV_NO_AUTH mode is on. */
export const isDevUser = (ctx: Ctx, userId: number) => ctx.config.devNoAuth && getUser(ctx.db, userId)?.account_role === 'dev'

/** The dev account (created on first use, passwordless so it can't log in normally). */
function devAccount(ctx: Ctx): Session {
  const found = ctx.db.prepare("SELECT id, username FROM users WHERE account_role = 'dev' LIMIT 1").get() as Session | undefined
  if (found) return found
  const username = findUser(ctx.db, 'dev') ? 'dev_local' : 'dev'
  const { lastInsertRowid } = ctx.db
    .prepare("INSERT INTO users(username, password_hash, is_admin, account_role, created_at, paid_through) VALUES(?, '', 1, 'dev', ?, ?)")
    .run(username, Date.now(), addMonths(Date.now(), GRANDFATHERED_MONTHS))
  return { id: Number(lastInsertRowid), username }
}
export const isAdmin = (ctx: Ctx, userId: number) => !!getUser(ctx.db, userId)?.is_admin

/** The signed-in user for a session token, or null if invalid, expired or the user was deleted. */
export function sessionUser(ctx: Ctx, token: string | undefined | null): Session | null {
  if (ctx.config.devNoAuth) return devAccount(ctx) // DEV_NO_AUTH: everyone is the dev account
  const s = verifySession(ctx.config.sessionSecret, token)
  const u = s && getUser(ctx.db, s.uid)
  return u ? { id: u.id, username: u.username } : null
}

/** The user's membership role in a project, or undefined. */
export function memberRole(ctx: Ctx, projectId: string, userId: number) {
  if (isDevUser(ctx, userId)) return ctx.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId) ? ('owner' as Role) : undefined
  return (ctx.db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId) as
    | { role: Role }
    | undefined)?.role
}


export type WriteBlock = 'account_read_only' | 'project_frozen'

/**
 * Why `userId` may not change `projectId`, or null if they may. A read-only account can't write anywhere;
 * a project whose owner is read-only is frozen for everyone until the owner resubscribes or its retention window ends and it is deleted.
 */
export function writeBlock(ctx: Ctx, projectId: string, userId: number): WriteBlock | null {
  if (isDevUser(ctx, userId)) return null
  if (getUser(ctx.db, userId)?.plan_status === 'read_only') return 'account_read_only'
  const owner = ctx.db
    .prepare('SELECT u.plan_status FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = ?')
    .get(projectId) as { plan_status: string } | undefined
  return owner?.plan_status === 'read_only' ? 'project_frozen' : null
}

/** Account-level write check (creating projects, copying): read-only accounts can't. */
export const accountBlocked = (ctx: Ctx, userId: number) =>
  !isDevUser(ctx, userId) && getUser(ctx.db, userId)?.plan_status === 'read_only'

/** Insert a user with an already-hashed password (sync, so it can run inside a transaction). Returns the new id. Throws if the username is taken. */
export function insertUser(ctx: Ctx, username: string, passwordHash: string, admin = false, months = 0): number {
  const now = Date.now()
  const { lastInsertRowid } = ctx.db
    .prepare('INSERT INTO users(username, password_hash, is_admin, created_at, paid_through) VALUES(?, ?, ?, ?, ?)')
    .run(username, passwordHash, admin ? 1 : 0, now, addMonths(now, months))
  return Number(lastInsertRowid)
}

/** Create an account directly (admin CLI, bootstrap). `months` of pre-paid time, like the grandfathered accounts by default. Returns the id. */
export async function createUser(ctx: Ctx, username: string, password: string, admin = false, months = GRANDFATHERED_MONTHS) {
  return insertUser(ctx, username, await hashPassword(password), admin, months)
}

export function getMe(ctx: Ctx, userId: number): Me {
  const u = getUser(ctx.db, userId)!
  return {
    id: u.id, username: u.username, isAdmin: !!u.is_admin, bytesUsed: u.bytes_used, quotaBytes: ctx.config.userQuotaBytes,
    // 'lapsed': the retention window is over and the cloud data is gone, but the account lives on.
    planStatus: u.plan_status === 'read_only' && u.data_purged_at ? 'lapsed' : u.plan_status,
    retentionEndsAt: u.plan_status === 'read_only' && !u.data_purged_at ? u.retention_ends_at : null,
    paidThrough: u.paid_through,
  }
}

/** Reads the session from the cookie or `Authorization: Bearer`; sets c.var.session (or null). */
export const sessionMiddleware = (ctx: Ctx): MiddlewareHandler<Env> => async (c, next) => {
  const bearer = c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1]
  const token = bearer ?? getCookie(c, SESSION_COOKIE)
  c.set('session', sessionUser(ctx, token))
  await next()
}

export const requireSignedIn: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.var.session) return c.json({ error: 'not_signed_in' }, 401)
  await next()
}

export const requireAdmin = (ctx: Ctx): MiddlewareHandler<Env> => async (c, next) => {
  const s = c.var.session
  if (!s) return c.json({ error: 'not_signed_in' }, 401)
  if (!isAdmin(ctx, s.id)) return c.json({ error: 'forbidden' }, 403)
  await next()
}

export const sessionOf = (c: Context<Env>) => c.var.session!
