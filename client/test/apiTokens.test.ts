// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiTokenInfo } from '@mobdaw/shared'
import { apiTokensSection } from '../src/pages/apiTokens'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))
const flush = () => new Promise((r) => setTimeout(r, 0))

function setup(initial: ApiTokenInfo[] = []) {
  let tokens = [...initial]
  const copied: string[] = []
  const el = apiTokensSection({
    list: async () => tokens,
    create: async (name) => {
      const t = { id: tokens.length + 1, name: name || 'API token', createdAt: Date.now(), lastUsedAt: null }
      tokens = [...tokens, t]
      return { ...t, token: 'mdw_secret' }
    },
    revoke: async (id) => void (tokens = tokens.filter((t) => t.id !== id)),
    mcpUrl: 'https://x.test/mcp',
    copy: async (t) => void copied.push(t),
  })
  document.body.append(el)
  cleanup.push(() => el.remove())
  return { el, copied }
}

describe('api tokens section', () => {
  it('lists tokens, and shows a new one once with the setup line and a copy button', async () => {
    const { el, copied } = setup([{ id: 1, name: 'old', createdAt: 1, lastUsedAt: null }])
    await flush()
    expect(el.querySelectorAll('.token')).toHaveLength(1)
    expect(el.textContent).toContain('never used')
    ;(el.querySelector('input') as HTMLInputElement).value = 'claude'
    ;(el.querySelector('.create') as HTMLButtonElement).click()
    await flush()
    expect(el.querySelectorAll('.token')).toHaveLength(2)
    expect((el.querySelector('.token-value') as HTMLInputElement).value).toBe('mdw_secret')
    expect(el.querySelector('.token-cmd')!.textContent).toBe('claude mcp add --transport http mobdaw https://x.test/mcp --header "Authorization: Bearer mdw_secret"')
    ;(el.querySelector('.copy') as HTMLButtonElement).click()
    await flush()
    expect(copied).toEqual(['mdw_secret'])
    expect(el.querySelector('.tokens')!.textContent).not.toContain('mdw_secret') // (the list never carries the secret)
  })

  it('revokes after a confirmation', async () => {
    vi.stubGlobal('confirm', () => true)
    cleanup.push(() => vi.unstubAllGlobals())
    const { el } = setup([{ id: 1, name: 'old', createdAt: 1, lastUsedAt: 5 }])
    await flush()
    ;(el.querySelector('.revoke') as HTMLButtonElement).click()
    await flush()
    expect(el.querySelectorAll('.token')).toHaveLength(0)
    expect(el.textContent).toContain('no tokens yet')
  })
})
