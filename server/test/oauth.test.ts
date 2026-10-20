import { createHash, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { redirectAllowed, validRedirect } from '../src/oauth.ts'
import { ADMIN, client, login, pw, startTest } from './helpers.ts'

let t: Awaited<ReturnType<typeof startTest>>
let cookie = ''
let origin = ''
const REDIRECT = 'http://127.0.0.1:33418/callback'

beforeAll(async () => {
  t = await startTest()
  origin = new URL(t.config.publicUrl).origin
  const res = await fetch(`${t.base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ADMIN, password: pw(ADMIN) }),
  })
  cookie = res.headers.get('set-cookie')!.split(';')[0]
})
afterAll(() => t.cleanup())

const form = (o: Record<string, string>) => new URLSearchParams(o)
const register = (body: unknown = { client_name: 'Test client', redirect_uris: [REDIRECT] }) =>
  fetch(`${t.base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}
const authParams = (client_id: string, challenge: string, extra: Record<string, string> = {}) =>
  ({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...extra })
/** Approve (or deny) as the signed-in admin; returns the response and the redirect URL. */
const decide = async (params: Record<string, string>, decision = 'allow', headers: Record<string, string> = { cookie, origin }) => {
  const res = await fetch(`${t.base}/oauth/authorize`, { method: 'POST', redirect: 'manual', headers, body: form({ ...params, decision }) })
  return { res, location: res.headers.get('location') ? new URL(res.headers.get('location')!) : null }
}
const exchange = (o: Record<string, string>) => fetch(`${t.base}/oauth/token`, { method: 'POST', body: form({ grant_type: 'authorization_code', ...o }) })

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
})

describe('discovery', () => {
  it('challenges /mcp with the metadata location and publishes the metadata', async () => {
    const res = await fetch(`${t.base}/mcp`, { method: 'POST' })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${t.config.publicUrl}/.well-known/oauth-protected-resource"`)
    const prm = await (await fetch(`${t.base}/.well-known/oauth-protected-resource`)).json()
    expect(prm).toMatchObject({ resource: `${t.config.publicUrl}/mcp`, authorization_servers: [t.config.publicUrl] })
    for (const p of ['oauth-authorization-server', 'openid-configuration']) {
      expect(await (await fetch(`${t.base}/.well-known/${p}`)).json()).toMatchObject({
        code_challenge_methods_supported: ['S256'], registration_endpoint: `${t.config.publicUrl}/oauth/register`,
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
  it('shows a sign-in page when signed out and a consent page when signed in', async () => {
    const { client_id } = await (await register()).json()
    const url = `${t.base}/oauth/authorize?${form(authParams(client_id, pkce().challenge))}`
    expect(await (await fetch(url)).text()).toContain('Sign in')
    expect(await (await fetch(url, { headers: { cookie } })).text()).toContain('admin (api)')
  })

  it('never redirects to an unregistered redirect URI or unknown client', async () => {
    const { client_id } = await (await register()).json()
    const bad = await fetch(`${t.base}/oauth/authorize?${form(authParams(client_id, 'c', { redirect_uri: 'http://127.0.0.1:1/evil' }))}`, { redirect: 'manual' })
    expect(bad.status).toBe(400)
    const unknown = await fetch(`${t.base}/oauth/authorize?${form(authParams('mdwc_nope', 'c'))}`, { redirect: 'manual' })
    expect(unknown.status).toBe(400)
  })

  it('refuses a missing PKCE challenge (by redirecting the error) and a decision without the cookie or the origin', async () => {
    const { client_id } = await (await register()).json()
    const noPkce = await fetch(`${t.base}/oauth/authorize?${form(authParams(client_id, '', { code_challenge_method: 'plain' }))}`, { headers: { cookie }, redirect: 'manual' })
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')
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
  const approve = async () => {
    const { client_id } = await (await register()).json()
    const { verifier, challenge } = pkce()
    const { location } = await decide(authParams(client_id, challenge))
    expect(location!.searchParams.get('state')).toBe('xyz')
    return { client_id, verifier, code: location!.searchParams.get('code')! }
  }

  it('turns an approved code into an API token that works on /mcp, and lists it on the account', async () => {
    const { client_id, verifier, code } = await approve()
    const res = await exchange({ code, client_id, redirect_uri: REDIRECT, code_verifier: verifier })
    expect(res.status).toBe(200)
    const { access_token, token_type } = await res.json()
    expect(token_type).toBe('Bearer')
    expect(access_token).toMatch(/^mdw_/)
    const admin = await login(t.base, ADMIN)
    expect((await admin.get('/api/me/api-tokens')).body.map((x: { name: string }) => x.name)).toContain('Test client (OAuth)')
    expect((await client(t.base, access_token).get('/api/agent/projects')).status).toBe(200)
    const mcp = new McpClient({ name: 'test', version: '1' })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${t.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access_token}` } } }))
    expect((await mcp.listTools()).tools.map((x) => x.name)).toContain('list_projects')
    await mcp.close()
  })

  it('accepts a code once', async () => {
    const { client_id, verifier, code } = await approve()
    const args = { code, client_id, redirect_uri: REDIRECT, code_verifier: verifier }
    expect((await exchange(args)).status).toBe(200)
    expect((await exchange(args)).status).toBe(400)
  })

  it('refuses a wrong verifier, client or redirect URI, and burns the code; refuses other grants', async () => {
    for (const bad of [{ code_verifier: 'x'.repeat(43) }, { client_id: 'mdwc_other' }, { redirect_uri: 'http://127.0.0.1:1/callback' }]) {
      const a = await approve()
      const args = { code: a.code, client_id: a.client_id, redirect_uri: REDIRECT, code_verifier: a.verifier }
      const res = await exchange({ ...args, ...bad })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('invalid_grant')
      expect((await exchange(args)).status).toBe(400)
    }
    expect((await (await exchange({ grant_type: 'password' })).json()).error).toBe('unsupported_grant_type')
  })

  it('refuses an expired code', async () => {
    const a = await approve()
    t.ctx.db.prepare('UPDATE oauth_codes SET expires_at = ?').run(Date.now() - 1)
    expect((await exchange({ code: a.code, client_id: a.client_id, redirect_uri: REDIRECT, code_verifier: a.verifier })).status).toBe(400)
  })
})
