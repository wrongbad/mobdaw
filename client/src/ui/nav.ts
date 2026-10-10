import type { Me } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { dateOf, daysLeft } from '../format'

/** Top bar for every page except the editor. `me` is null when working locally without an account. */
export function nav(me: Me | null): HTMLElement {
  const bar = h('nav', {},
    h('a', { href: me ? '#/projects' : '#/local' }, 'mobdaw'),
    h('a', { href: '#/local' }, 'on this device'),
    me ? h('a', { href: '#/projects' }, 'cloud') : null,
    me ? h('a', { href: '#/uploads' }, 'uploads') : null,
    me ? h('a', { href: '#/account' }, 'account') : null,
    me?.isAdmin ? h('a', { href: '#/admin' }, 'invites') : null,
    h('span', { className: 'grow' }),
    me ? h('span', { className: 'dim' }, me.username) : null,
    me ? h('a', { href: '#/login', onclick: () => api.logout() }, 'log out') : h('a', { href: '#/login' }, 'sign in to Pro'),
  )
  const banner = me?.planStatus === 'read_only' && me.retentionEndsAt ? retentionBanner(me.retentionEndsAt) : null
  return h('div', { className: 'top' }, bar, banner)
}

/** Shown on every page while an account is in its 30-day retention window. */
function retentionBanner(endsAt: number) {
  const n = daysLeft(endsAt)
  return h('p', { className: 'banner' },
    `Your subscription has ended. Your account is read-only, and everything you own will be permanently deleted on ${dateOf(endsAt)} ` +
    `(${n} ${n === 1 ? 'day' : 'days'} left). `,
    h('a', { href: '#/account' }, 'Download your data'), '. Resubscribe before then to keep everything.')
}
