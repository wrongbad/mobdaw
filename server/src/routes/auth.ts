import { Hono } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { OAuth2Client } from 'google-auth-library'
import type { ConfigResponse, LoginResponse, UserInfo } from '@mobdaw/shared'
import {
  SESSION_COOKIE, SESSION_MS, getMe, isAdmitted, requireAdmitted, requireSignedIn, signSession, upsertUser,
  type Ctx, type Env,
} from '../auth.ts'

export function authRoutes(ctx: Ctx) {
  const { config, db } = ctx
  const r = new Hono<Env>()
  const google = config.googleClientId ? new OAuth2Client(config.googleClientId) : null

  r.get('/config', (c) =>
    c.json<ConfigResponse>({ authMode: config.authMode, googleClientId: config.googleClientId }),
  )

  r.post('/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}))
    let email: string, name: string
    if (config.authMode === 'dev') {
      email = String(body.email ?? '').trim().toLowerCase()
      name = String(body.name ?? '').trim() || email.split('@')[0]
    } else {
      const p = await google!
        .verifyIdToken({ idToken: String(body.idToken ?? ''), audience: config.googleClientId! })
        .then((t) => t.getPayload())
        .catch(() => null)
      if (!p?.email || !p.email_verified) return c.json({ error: 'invalid_token' }, 401)
      email = p.email.toLowerCase()
      name = p.name || email.split('@')[0]
    }
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return c.json({ error: 'bad_request' }, 400)

    // Admitted users (and admins) get their profile created/refreshed on login.
    if (isAdmitted(ctx, email)) upsertUser(ctx, email, name)
    const token = signSession(config.sessionSecret, email, name)
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.publicUrl.startsWith('https:'),
      path: '/',
      maxAge: SESSION_MS / 1000,
    })
    return c.json<LoginResponse>({ token, me: getMe(ctx, { email, name, exp: 0 }) })
  })

  r.post('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  r.get('/me', requireSignedIn, (c) => c.json(getMe(ctx, c.var.session!)))

  r.get('/users', requireAdmitted(ctx), (c) =>
    c.json<UserInfo[]>(
      (db.prepare('SELECT email, name FROM users ORDER BY email').all() as { email: string; name: string | null }[]).map(
        (u) => ({ email: u.email, name: u.name ?? '' }),
      ),
    ),
  )

  return r
}
