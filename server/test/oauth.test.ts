import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { revokeAllApiTokens } from '../src/apiTokens.ts'
import { destination, redirectAllowed, validRedirect } from '../src/oauth.ts'
import { ADMIN, client, login, pw, startTest, userId } from './helpers.ts'

// Served under a path prefix, as in production, so the URLs in the metadata carry it.
const PUBLIC = 'http://localhost:5173/mobdaw'
const O = '/api/oauth'
const REDIRECT = 'http://127.0.0.1:33418/callback'
let t: Awaited<ReturnType<typeof startTest>>
let cookie = ''
let origin = ''

beforeAll(async () => {
  t = await startTest({ PUBLIC_URL: PUBLIC })
  origin = new URL(PUBLIC).origin
  const res = await fetch(`${t.base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ADMIN, password: pw(ADMIN) }),
  })
  cookie = res.headers.get('set-cookie')!.split(';')[0]
})
afterAll(() => t.cleanup())

/**
 * The production Caddy in front of the server: /mobdaw/api/*, /mobdaw/collab* and /mobdaw/mcp go to it with the prefix stripped,
 * any other /mobdaw/* is the client's index.html, and the rest of the origin is another site.
 */
const caddy = async (input: string | URL | Request, init?: RequestInit) => {
  const u = new URL(input instanceof Request ? input.url : String(input))
  const path = u.pathname
  if (u.origin === origin && /^\/mobdaw\/(api\/|collab|mcp$)/.test(path)) return fetch(t.base + path.slice('/mobdaw'.length) + u.search, init)
  if (u.origin === origin && path.startsWith('/mobdaw/')) return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
  return new Response('not found', { status: 404 })
}

const form = (o: Record<string, string>) => new URLSearchParams(o)
const register = (body: unknown = { client_name: 'Test client', redirect_uris: [REDIRECT] }) =>
  fetch(`${t.base}${O}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
const authParams = (client_id: string, challenge: string, extra: Record<string, string> = {}) =>
  ({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...extra })
/** Approve (or deny) as the signed-in admin; returns the response and the redirect URL. */
const decide = async (params: Record<string, string>, decision = 'allow', headers: Record<string, string> = { cookie, origin }) => {
  const res = await fetch(`${t.base}${O}/authorize`, { method: 'POST', redirect: 'manual', headers, body: form({ ...params, decision }) })
  return { res, location: res.headers.get('location') ? new URL(res.headers.get('location')!) : null }
}
const exchange = (o: Record<string, string>) => fetch(`${t.base}${O}/token`, { method: 'POST', body: form({ grant_type: 'authorization_code', ...o }) })

describe('redirect URIs', () => {
  it('allows https, loopback http and app schemes; refuses the rest', () => {
    for (const u of ['https://a.example/cb', 'http://localhost/cb', 'http://127.0.0.1:1/cb', 'claude://callback']) expect(validRedirect(u)).toBe(true)
    for (const u of ['http://a.example/cb', 'javascript:alert(1)', 'https://a.example/cb#x', 'nope', 5]) expect(validRedirect(u)).toBe(false)
  })
  it('match exactly, except for the port on loopback', () => {
    expect(redirectAllowed([REDIRECT], REDIRECT)).toBe(true)
    expect(redirectAllowed([REDIRECT], 'http://127.0.0.1:9/callback')).toBe(true)
    expect(redirectAllowed([REDIRECT], 'http://127.0.0.1:9/other')).toBe(false)
    expect(redirectAllowed(['https://a.example/cb'], 'https://a.example:444/cb')).toBe(false)
  })
  it('are described by where they really go', () => {
    expect(destination('https://claude.ai@evil.example/cb')).toBe('evil.example')
    expect(destination(REDIRECT)).toBe('an app on this computer')
    expect(destination('cursor://cb')).toContain('"cursor:"')
  })
})

describe('discovery', () => {
  it('challenges /mcp with the metadata location and publishes the metadata', async () => {
    const res = await fetch(`${t.base}/mcp`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${PUBLIC}${O}/.well-known/oauth-protected-resource"`)
    const prm = await (await fetch(`${t.base}${O}/.well-known/oauth-protected-resource`)).json()
    expect(prm).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [`${PUBLIC}${O}`] })
    for (const p of ['oauth-authorization-server', 'openid-configuration']) {
      expect(await (await fetch(`${t.base}${O}/.well-known/${p}`)).json()).toMatchObject({
        issuer: `${PUBLIC}${O}`, code_challenge_methods_supported: ['S256'], registration_endpoint: `${PUBLIC}${O}/register`,
      })
    }
    // the API routes keep the plain challenge
    expect((await fetch(`${t.base}/api/agent/projects`)).headers.get('www-authenticate')).toBe('Bearer')
  })
})

describe('registration', () => {
  it('registers a public client, and refuses bad redirect URIs', async () => {
    const ok = await register()
    expect(ok.status).toBe(201)
    expect(await ok.json()).toMatchObject({ client_name: 'Test client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })
    expect((await register({ redirect_uris: ['http://evil.example/cb'] })).status).toBe(400)
    expect((await register({ redirect_uris: [] })).status).toBe(400)
    expect((await register({})).status).toBe(400)
  })
})

describe('authorization', () => {
  it('shows a sign-in page when signed out and a consent page naming the destination when signed in', async () => {
    const { client_id } = await (await register()).json()
    const url = `${t.base}${O}/authorize?${form(authParams(client_id, pkce().challenge))}`
    expect(await (await fetch(url)).text()).toContain('Sign in')
    const res = await fetch(url, { headers: { cookie } })
    // 'no-referrer' makes browsers send "Origin: null" on the form's POST, which the origin check refuses
    expect(res.headers.get('referrer-policy')).toBe('same-origin')
    const consent = await res.text()
    expect(consent).toContain('admin (api)')
    expect(consent).toContain('an app on this computer')
  })

  it('never redirects to an unregistered redirect URI or unknown client', async () => {
    const { client_id } = await (await register()).json()
    const bad = await fetch(`${t.base}${O}/authorize?${form(authParams(client_id, pkce().challenge, { redirect_uri: 'http://127.0.0.1:1/evil' }))}`, { redirect: 'manual' })
    expect(bad.status).toBe(400)
    const unknown = await fetch(`${t.base}${O}/authorize?${form(authParams('mdwc_nope', pkce().challenge))}`, { redirect: 'manual' })
    expect(unknown.status).toBe(400)
  })

  it('refuses a missing or malformed PKCE challenge (by redirecting the error)', async () => {
    const { client_id } = await (await register()).json()
    for (const extra of [{ code_challenge_method: 'plain' }, { code_challenge: '' }, { code_challenge: 'short' }] as Record<string, string>[]) {
      const res = await fetch(`${t.base}${O}/authorize?${form(authParams(client_id, pkce().challenge, extra))}`, { headers: { cookie }, redirect: 'manual' })
      expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')
    }
    expect((await decide(authParams(client_id, 'short'))).res.status).toBe(400)
  })

  it('refuses a decision without the cookie or from another origin', async () => {
    const { client_id } = await (await register()).json()
    const params = authParams(client_id, pkce().challenge)
    expect((await decide(params, 'allow', { origin })).res.status).toBe(403)
    expect((await decide(params, 'allow', { cookie })).res.status).toBe(403)
    expect((await decide(params, 'allow', { cookie, origin: 'https://evil.example' })).res.status).toBe(403)
  })

  it('reports a denial to the client with its state', async () => {
    const { client_id } = await (await register()).json()
    const { location } = await decide(authParams(client_id, pkce().challenge), 'deny')
    expect(location!.searchParams.get('error')).toBe('access_denied')
    expect(location!.searchParams.get('state')).toBe('xyz')
  })
})

describe('token exchange', () => {
  const approve = async (name = 'Test client') => {
    const { client_id } = await (await register({ client_name: name, redirect_uris: [REDIRECT] })).json()
    const { verifier, challenge } = pkce()
    const { location } = await decide(authParams(client_id, challenge))
    expect(location!.searchParams.get('state')).toBe('xyz')
    return { client_id, verifier, code: location!.searchParams.get('code')! }
  }
  const args = (a: Awaited<ReturnType<typeof approve>>) => ({ code: a.code, client_id: a.client_id, redirect_uri: REDIRECT, code_verifier: a.verifier })

  it('turns an approved code into an API token that works on /mcp, and lists it on the account', async () => {
    const res = await exchange(args(await approve()))
    expect(res.status).toBe(200)
    const { access_token, token_type } = await res.json()
    expect(token_type).toBe('Bearer')
    expect(access_token).toMatch(/^mdw_/)
    const admin = await login(t.base, ADMIN)
    expect((await admin.get('/api/me/api-tokens')).body.map((x: { name: string }) => x.name)).toContain('Test client (OAuth)')
    expect((await client(t.base, access_token).get('/api/agent/projects')).status).toBe(200)
  })

  it('keeps the (OAuth) mark on a long client name', async () => {
    const { access_token } = await (await exchange(args(await approve('x'.repeat(60))))).json()
    const row = t.ctx.db.prepare('SELECT name FROM api_tokens WHERE token_hash = ?').get(createHash('sha256').update(access_token).digest('hex')) as { name: string }
    expect(row.name).toMatch(/\(OAuth\)$/)
    expect(row.name.length).toBeLessThanOrEqual(60)
  })

  it('accepts a code once', async () => {
    const a = args(await approve())
    expect((await exchange(a)).status).toBe(200)
    expect((await exchange(a)).status).toBe(400)
  })

  it('refuses a wrong verifier, client or redirect URI, and burns the code; refuses other grants', async () => {
    for (const bad of [{ code_verifier: 'x'.repeat(43) }, { code_verifier: 'short' }, { client_id: 'mdwc_other' }, { redirect_uri: 'http://127.0.0.1:1/callback' }]) {
      const a = args(await approve())
      const res = await exchange({ ...a, ...bad })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid_grant')
      expect((await exchange(a)).status).toBe(400)
    }
    expect((await (await exchange({ grant_type: 'password' })).json()).error).toBe('unsupported_grant_type')
  })

  it('refuses an expired code', async () => {
    const a = args(await approve())
    t.ctx.db.prepare('UPDATE oauth_codes SET expires_at = ?').run(Date.now() - 1)
    expect((await exchange(a)).status).toBe(400)
  })

  it('drops codes not yet exchanged when the user\'s tokens are revoked (password change)', async () => {
    const a = args(await approve())
    revokeAllApiTokens(t.ctx.db, userId(t.ctx.db, ADMIN))
    expect((await exchange(a)).status).toBe(400)
    const res = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ADMIN, password: pw(ADMIN) }),
    })
    cookie = res.headers.get('set-cookie')!.split(';')[0]
  })
})

describe('an MCP SDK client through the production proxy', () => {
  it('discovers, registers, gets consent, exchanges, and calls tools', async () => {
    let info: any, tokens: any, verifier = '', authUrl: URL | undefined
    const provider: OAuthClientProvider = {
      get redirectUrl() { return REDIRECT },
      get clientMetadata() { return { client_name: 'SDK client', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' } },
      clientInformation: () => info,
      saveClientInformation: (i) => { info = i },
      tokens: () => tokens,
      saveTokens: (x) => { tokens = x },
      redirectToAuthorization: (u) => { authUrl = u },
      saveCodeVerifier: (v) => { verifier = v },
      codeVerifier: () => verifier,
    }
    const transport = () => new StreamableHTTPClientTransport(new URL(`${PUBLIC}/mcp`), { authProvider: provider, fetch: caddy })
    const first = transport()
    await expect(new McpClient({ name: 'sdk', version: '1' }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError)
    expect(authUrl!.href.startsWith(`${PUBLIC}${O}/authorize?`)).toBe(true)

    // the user, in their browser (signed in), approves
    const params = Object.fromEntries(authUrl!.searchParams)
    expect(await (await caddy(authUrl!, { headers: { cookie } })).text()).toContain('SDK client')
    const approved = await caddy(`${PUBLIC}${O}/authorize`, { method: 'POST', redirect: 'manual', headers: { cookie, origin }, body: form({ ...params, decision: 'allow' }) })
    const back = new URL(approved.headers.get('location')!)
    expect(back.searchParams.get('state')).toBe(params.state ?? null)
    await first.finishAuth(back.searchParams.get('code')!)
    expect(tokens.access_token).toMatch(/^mdw_/)

    const mcp = new McpClient({ name: 'sdk', version: '1' })
    await mcp.connect(transport())
    expect((await mcp.listTools()).tools.map((x) => x.name)).toContain('list_projects')
    await mcp.close()
  })
})
