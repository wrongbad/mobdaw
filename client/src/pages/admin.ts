import type { Me } from '@mobdaw/shared'
import { api } from '../api'
import { h, mount } from '../dom'
import { nav } from '../ui/nav'

export function adminPage(me: Me) {
  const link = h('input', { readOnly: true, className: 'grow', onclick: (e: any) => e.target.select() })
  const list = h('ul', { className: 'list' })
  const err = h('p', { className: 'error' })
  const fmt = (t: number) => new Date(t).toLocaleString()

  const refresh = () =>
    api.invites().then((all) =>
      list.replaceChildren(...all.map((i) =>
        h('li', {}, h('span', { className: 'dim' }, i.token.slice(0, 8) + '…'), h('span', { className: 'grow' }),
          h('span', { className: 'dim' },
            i.redeemedBy ? `used by ${i.redeemedBy}` : i.expiresAt && i.expiresAt < Date.now() ? 'expired' : `created ${fmt(i.createdAt)}`)))),
    ).catch((e) => (err.textContent = e.message))

  mount(nav(me), h('main', {},
    h('div', { className: 'row' },
      h('button', {
        onclick: () => api.createInvite({}).then((r) => { link.value = r.url; link.select(); refresh() }, (e) => (err.textContent = e.message)),
      }, 'New invite'), link),
    err, list))
  refresh()
}
