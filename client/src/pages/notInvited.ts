import type { Me } from '@mobdaw/shared'
import { h, mount } from '../dom'
import { api } from '../api'

export function notInvitedPage(me: Me) {
  mount(h('main', { className: 'center' },
    h('div', { className: 'card' },
      h('h1', {}, 'You need an invite'),
      h('p', { className: 'dim' }, `Signed in as ${me.email}. Ask the owner for an invite link.`),
      h('a', { href: '#/login', onclick: () => api.logout() }, 'log out'))))
}
