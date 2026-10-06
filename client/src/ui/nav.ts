import type { Me } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'

export function nav(me: Me): HTMLElement {
  return h('nav', {},
    h('a', { href: '#/projects' }, 'mobdaw'),
    me.isAdmin ? h('a', { href: '#/admin' }, 'invites') : null,
    h('span', { className: 'grow' }),
    h('span', { className: 'dim' }, me.name || me.email),
    h('a', { href: '#/login', onclick: () => api.logout() }, 'log out'),
  )
}
