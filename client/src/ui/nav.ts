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
  const banner = !me ? null
    : me.planStatus === 'read_only' && me.retentionEndsAt ? retentionBanner(me.retentionEndsAt)
    : me.paidThrough - Date.now() < 14 * 86_400_000 ? endingBanner(me.paidThrough)
    : null
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

/** Shown in the last two weeks of pre-paid time. */
function endingBanner(paidThrough: number) {
  const n = daysLeft(paidThrough)
  return h('p', { className: 'banner' },
    `Your pre-paid time ends on ${dateOf(paidThrough)} (${n} ${n === 1 ? 'day' : 'days'}). After that your account becomes read-only for 30 days, then your data is deleted. `,
    h('a', { href: '#/account' }, 'Account'))
}
