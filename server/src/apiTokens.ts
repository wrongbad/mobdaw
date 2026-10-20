// API tokens: long-lived Bearer tokens for the agent API (docs/agent-api.md). Stored like sessions, as the SHA-256 of the token.
// They are accepted on /api/agent/*, /mcp and the collab WebSocket only (never on the account routes, so a token can't make tokens),
// and everything done with one is attributed to "<username> (api)". Revoking one is immediate; `onRevoked` lets the agent presence
// and open connections of that token end with it.
import { randomBytes } from 'node:crypto'
import type { ApiTokenInfo } from '@mobdaw/shared'
import { hashToken, type Ctx, type Session } from './auth.ts'
import type { Db } from './db.ts'

export const TOKEN_PREFIX = 'mdw_'
export const NAME_MAX = 60
/** `last_used_at` is written at most this often per token. */
const USED_EVERY_MS = 60_000

export type ApiUser = Session & { /** The SHA-256 of the token: what presence and connections are keyed by. */ tokenHash: string }

/** Make a token for the user. Returns the raw token (shown once; only its hash is stored). */
export function createApiToken(ctx: Ctx, userId: number, name: string, now = Date.now()): ApiTokenInfo & { token: string } {
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const label = name.trim().slice(0, NAME_MAX) || 'API token'
  const { lastInsertRowid } = ctx.db
    .prepare('INSERT INTO api_tokens(token_hash, user_id, name, created_at) VALUES(?,?,?,?)')
    .run(hashToken(token), userId, label, now)
  return { id: Number(lastInsertRowid), name: label, createdAt: now, lastUsedAt: null, token }
}

export const listApiTokens = (ctx: Ctx, userId: number): ApiTokenInfo[] =>
  (ctx.db.prepare('SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id').all(userId) as
    { id: number; name: string; created_at: number; last_used_at: number | null }[])
    .map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }))

/** Revoke one of the user's tokens. Returns its hash (so the caller can end its presence and connections), or null if it isn't theirs. */
export function revokeApiToken(ctx: Ctx, userId: number, id: number): string | null {
  const row = ctx.db.prepare('SELECT token_hash FROM api_tokens WHERE id = ? AND user_id = ?').get(id, userId) as { token_hash: string } | undefined
  if (!row) return null
  ctx.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id)
  return row.token_hash
}

/** Revoke every token of the user (password change, account deletion), and any OAuth code not yet exchanged for one. Returns their hashes. */
export function revokeAllApiTokens(db: Db, userId: number): string[] {
  db.prepare('DELETE FROM oauth_codes WHERE user_id = ?').run(userId)
  const hashes = (db.prepare('SELECT token_hash FROM api_tokens WHERE user_id = ?').all(userId) as { token_hash: string }[]).map((r) => r.token_hash)
  db.prepare('DELETE FROM api_tokens WHERE user_id = ?').run(userId)
  return hashes
}

/** The user an API token belongs to, or null if it is unknown or revoked. */
export function apiTokenUser(ctx: Ctx, token: string | undefined | null, now = Date.now()): ApiUser | null {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null
  const tokenHash = hashToken(token)
  const row = ctx.db
    .prepare('SELECT t.id, t.last_used_at, u.id AS uid, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?')
    .get(tokenHash) as { id: number; last_used_at: number | null; uid: number; username: string } | undefined
  if (!row) return null
  if (row.last_used_at == null || now - row.last_used_at > USED_EVERY_MS) ctx.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, row.id)
  return { id: row.uid, username: row.username, tokenHash }
}
