// OAuth 2.1 for MCP clients (docs/agent-api.md): discovery metadata, dynamic client registration, authorization code + PKCE (S256).
// Clients are public (no secret). The consent page runs on the browser's normal cookie session; what an exchange yields is an
// ordinary API token (apiTokens.ts), named after the client, so revoking it on the account page works as it does for any token.
import { createHash, randomBytes } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { getCookie } from 'hono/cookie'
import { SESSION_COOKIE, hashToken, safeEqual, sessionUser, type Ctx } from './auth.ts'
import { createApiToken } from './apiTokens.ts'

const CODE_MS = 5 * 60_000
const CLIENTS_MAX = 2000
const NAME_MAX = 60
const REDIRECTS_MAX = 5
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const UNSAFE_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:'])

type ClientRow = { client_id: string; name: string; redirect_uris: string }

/** A redirect URI a client may register: https, http on loopback, or an app's own scheme; never with a fragment. */
export function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 500) return false
  let u: URL
  try { u = new URL(uri) } catch { return false }
  if (u.hash || UNSAFE_SCHEMES.has(u.protocol)) return false
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname)
  return true
}

/** Exact match, except that a loopback http URI may differ in port (RFC 8252: the client picks a free one). */
export function redirectAllowed(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) return true
  let u: URL
  try { u = new URL(uri) } catch { return false }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) return false
  return registered.some((r) => {
    try {
      const x = new URL(r)
      return x.protocol === 'http:' && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search
    } catch { return false }
  })
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`)
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

const PAGE_CSS = `body{font:16px system-ui,sans-serif;max-width:26rem;margin:12vh auto;padding:0 1rem;color:#222}
input,button{font:inherit;padding:.5rem .7rem;margin:.25rem 0;width:100%;box-sizing:border-box}
.row{display:flex;gap:.5rem}.row button{flex:1}.err{color:#b00}small{color:#666}`
const page = (c: Context, title: string, body: string, status: 200 | 400 | 403 = 200) =>
  c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title><style>${PAGE_CSS}</style>${body}`, status, {
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
  })

type AuthParams = { client_id: string; redirect_uri: string; code_challenge: string; state: string }
const PARAM_KEYS = ['client_id', 'redirect_uri', 'code_challenge', 'state'] as const

export function oauthRoutes(ctx: Ctx) {
  const { config, db } = ctx
  const r = new Hono()
  const issuer = config.publicUrl
  const oauthError = (c: Context, error: string, status: 400 | 401 = 400) => c.json({ error }, status, { 'cache-control': 'no-store' })
  const getClient = (id: string) => db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(id) as ClientRow | undefined

  // Discovery. Served under the app's base path; the 401 from /mcp names the protected-resource URL exactly, and clients that
  // look for the authorization server's metadata by appending to the issuer find the OIDC-style path.
  const open = cors({ origin: '*' })
  r.use('/.well-known/*', open)
  r.use('/oauth/register', open)
  r.use('/oauth/token', open)
  r.get('/.well-known/oauth-protected-resource', (c) =>
    c.json({ resource: `${issuer}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ['header'] }))
  const metadata = (c: Context) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    })
  r.get('/.well-known/oauth-authorization-server', metadata)
  r.get('/.well-known/openid-configuration', metadata)

  r.post('/oauth/register', async (c) => {
    const body = await c.req.json().catch(() => null)
    const uris = body?.redirect_uris
    if (!Array.isArray(uris) || !uris.length || uris.length > REDIRECTS_MAX || !uris.every(validRedirect)) {
      return c.json({ error: 'invalid_redirect_uri' }, 400)
    }
    const name = String(body.client_name ?? '').trim().slice(0, NAME_MAX) || 'MCP client'
    const client_id = 'mdwc_' + randomBytes(16).toString('base64url')
    db.prepare('INSERT INTO oauth_clients(client_id, name, redirect_uris, created_at) VALUES(?,?,?,?)').run(client_id, name, JSON.stringify(uris), Date.now())
    // Anyone may register, so keep the table bounded: the oldest registrations go first.
    db.prepare('DELETE FROM oauth_clients WHERE rowid IN (SELECT rowid FROM oauth_clients ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)').run(CLIENTS_MAX)
    return c.json({
      client_id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], response_types: ['code'],
    }, 201)
  })

  /** The request's parameters, checked. A bad client or redirect is shown to the user, never redirected to. */
  const checkAuthorize = (q: Record<string, string>): { error: string } | { client: ClientRow; p: AuthParams; redirect: URL } => {
    const client = getClient(q.client_id ?? '')
    if (!client) return { error: 'Unknown client.' }
    if (!redirectAllowed(JSON.parse(client.redirect_uris), q.redirect_uri ?? '')) return { error: 'This redirect address is not registered for the client.' }
    const p = Object.fromEntries(PARAM_KEYS.map((k) => [k, q[k] ?? ''])) as AuthParams
    return { client, p, redirect: new URL(p.redirect_uri) }
  }
  const back = (redirect: URL, state: string, params: Record<string, string>) => {
    for (const [k, v] of Object.entries(params)) redirect.searchParams.set(k, v)
    if (state) redirect.searchParams.set('state', state)
    return redirect.toString()
  }
  const hidden = (p: AuthParams) => PARAM_KEYS.map((k) => `<input type="hidden" name="${k}" value="${esc(p[k])}">`).join('')

  r.get('/oauth/authorize', (c) => {
    const q = c.req.query()
    const checked = checkAuthorize(q)
    if ('error' in checked) return page(c, 'mobdaw', `<h1>mobdaw</h1><p class="err">${esc(checked.error)}</p>`, 400)
    const { client, p, redirect } = checked
    if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !p.code_challenge) {
      return c.redirect(back(redirect, p.state, { error: 'invalid_request' }))
    }
    const user = sessionUser(ctx, getCookie(c, SESSION_COOKIE))
    if (!user) {
      return page(c, 'Sign in to mobdaw', `<h1>Sign in to mobdaw</h1><p><b>${esc(client.name)}</b> wants to access your projects.</p>
<form id="f"><input name="username" placeholder="username" autocomplete="username" required><input name="password" type="password" placeholder="password" autocomplete="current-password" required>
<button>Sign in</button><p class="err" id="e"></p></form>
<script>f.onsubmit=async(ev)=>{ev.preventDefault();const r=await fetch(${JSON.stringify(config.basePath + '/api/auth/login')},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:f.username.value,password:f.password.value})});
if(r.ok)location.reload();else e.textContent=r.status===429?'Too many attempts, try again later.':'Wrong username or password.'}</script>`)
    }
    return page(c, 'Allow access to mobdaw', `<h1>Allow access?</h1><p><b>${esc(client.name)}</b> wants to read and edit your mobdaw projects as <b>${esc(user.username)} (api)</b>.</p>
<form method="post">${hidden(p)}<div class="row"><button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button></div></form>
<small>You can revoke the access on your account page under API tokens.</small>`)
  })

  r.post('/oauth/authorize', async (c) => {
    // The cookie is SameSite=Lax, which already keeps a cross-site form from carrying it; this checks the origin as well.
    if (c.req.header('origin') !== new URL(config.publicUrl).origin) return page(c, 'mobdaw', '<p class="err">Request refused.</p>', 403)
    const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]))
    const checked = checkAuthorize(form)
    if ('error' in checked) return page(c, 'mobdaw', `<h1>mobdaw</h1><p class="err">${esc(checked.error)}</p>`, 400)
    const { client, p, redirect } = checked
    const user = sessionUser(ctx, getCookie(c, SESSION_COOKIE))
    if (!user) return page(c, 'mobdaw', '<p class="err">Your session ended. Go back and sign in again.</p>', 403)
    if (form.decision !== 'allow') return c.redirect(back(redirect, p.state, { error: 'access_denied' }), 303)
    const code = randomBytes(32).toString('base64url')
    const now = Date.now()
    db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now)
    db.prepare('INSERT INTO oauth_codes(code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at) VALUES(?,?,?,?,?,?)')
      .run(hashToken(code), client.client_id, user.id, p.redirect_uri, p.code_challenge, now + CODE_MS)
    return c.redirect(back(redirect, p.state, { code }), 303)
  })

  r.post('/oauth/token', async (c) => {
    const form = Object.fromEntries(Object.entries(await c.req.parseBody()).map(([k, v]) => [k, String(v)]))
    if (form.grant_type !== 'authorization_code') return oauthError(c, 'unsupported_grant_type')
    // Single use: the code is gone whether or not the rest checks out.
    const hash = hashToken(form.code ?? '')
    const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash) as
      { client_id: string; user_id: number; redirect_uri: string; code_challenge: string; expires_at: number } | undefined
    db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(hash)
    const client = row && getClient(row.client_id)
    if (!row || !client || row.expires_at <= Date.now()) return oauthError(c, 'invalid_grant')
    if (form.client_id !== row.client_id || form.redirect_uri !== row.redirect_uri) return oauthError(c, 'invalid_grant')
    if (!form.code_verifier || form.code_verifier.length > 200 || !safeEqual(s256(form.code_verifier), row.code_challenge)) return oauthError(c, 'invalid_grant')
    const made = createApiToken(ctx, row.user_id, `${client.name} (OAuth)`)
    return c.json({ access_token: made.token, token_type: 'Bearer' }, 200, { 'cache-control': 'no-store' })
  })

  return r
}
