import type { ApiTokenInfo, CreateApiTokenResponse } from '@mobdaw/shared'
import { h } from '../dom'
import { describeError } from '../errors'
import { dateOf } from '../format'

export type ApiTokenDeps = {
  list(): Promise<ApiTokenInfo[]>
  create(name: string): Promise<CreateApiTokenResponse>
  revoke(id: number): Promise<unknown>
  /** The server's address for the setup line (`<origin>/mcp`). */
  mcpUrl: string
  copy?(text: string): Promise<void>
}

/** The account page's "API tokens" section: list, create (the token is shown once, with a copy button) and revoke. */
export function apiTokensSection({ list, create, revoke, mcpUrl, copy = (t) => navigator.clipboard.writeText(t) }: ApiTokenDeps) {
  const err = h('p', { className: 'error' })
  const rows = h('div', { className: 'tokens' })
  const fresh = h('div', { className: 'token-new', hidden: true })
  const name = h('input', { type: 'text', placeholder: 'name (e.g. claude code)', maxLength: 60 })

  const draw = (tokens: ApiTokenInfo[]) =>
    rows.replaceChildren(...(tokens.length ? tokens.map((t) =>
      h('div', { className: 'row token' },
        h('span', {}, h('strong', {}, t.name), ' ', h('span', { className: 'dim' }, `created ${dateOf(t.createdAt)}, ${t.lastUsedAt ? `last used ${dateOf(t.lastUsedAt)}` : 'never used'}`)),
        h('button', { className: 'danger revoke', title: 'stop this token working, now', onclick: () => {
          if (!confirm(`revoke "${t.name}"? anything using it stops working immediately.`)) return
          revoke(t.id).then(refresh, (e) => (err.textContent = describeError(e)))
        } }, 'revoke'))) : [h('p', { className: 'dim' }, 'no tokens yet.')]))

  const refresh = () => list().then(draw, (e) => (err.textContent = describeError(e)))

  const make = () => {
    err.textContent = ''
    create(name.value).then((r) => {
      name.value = ''
      const line = `claude mcp add --transport http mobdaw ${mcpUrl} --header "Authorization: Bearer ${r.token}"`
      const value = h('input', { type: 'text', readOnly: true, className: 'token-value', value: r.token })
      const btn = h('button', { className: 'copy', onclick: () => copy(r.token).then(() => (btn.textContent = 'copied'), () => (btn.textContent = 'select and copy')) }, 'copy')
      fresh.hidden = false
      fresh.replaceChildren(
        h('p', {}, h('strong', {}, 'copy the token now'), ': it is not shown again.'),
        h('div', { className: 'row' }, value, btn),
        h('p', { className: 'dim' }, 'to connect claude code:'), h('code', { className: 'token-cmd' }, line))
      return refresh()
    }, (e) => (err.textContent = describeError(e)))
  }

  void refresh()
  return h('section', { className: 'api-tokens' },
    h('h3', {}, 'api tokens'),
    h('p', { className: 'dim' }, 'a token lets a program, such as claude code, work in your projects as "you (api)": it shows up in the project, can read and edit, and chat, with your access, and everything it changes is marked in the history. revoke a token to stop it at once.'),
    rows,
    h('div', { className: 'row' }, name, h('button', { className: 'create', onclick: make }, 'create token')),
    fresh,
    err)
}
