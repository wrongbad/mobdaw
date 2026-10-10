import type { Me } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { homeLink } from '../router'
import { dateOf, daysLeft } from '../format'

/** Top bar for every page except the editor. `me` is null when working locally without an account. */
export function nav(me: Me | null): HTMLElement {
  const bar = h('nav', {},
    h('a', { ...homeLink, className: 'logo' }, 'mobdaw'),
    h('span', { className: 'grow' }),
    me ? h('details', { className: 'menu' },
      h('summary', { className: 'dim' }, me.username),
      h('div', {},
        h('a', { href: '#/account' }, 'account'),
        h('a', { href: '#/uploads' }, 'uploads'),
        me.isAdmin ? h('a', { href: '#/admin' }, 'invites') : null,
        h('a', { href: '#/login', onclick: () => api.logout() }, 'log out')))
      : h('a', { href: '#/login' }, 'sign in'),
  )
  const banner = !me ? null
    : me.planStatus === 'read_only' && me.retentionEndsAt ? retentionBanner(me.retentionEndsAt)
    : me.planStatus === 'lapsed' ? lapsedBanner()
    : me.planStatus === 'active' && me.paidThrough - Date.now() < 14 * 86_400_000 ? endingBanner(me.paidThrough)
    : null
  return h('div', { className: 'top' }, bar, banner)
}

/** Shown on every page while an account is in its 30-day retention window. */
function retentionBanner(endsAt: number) {
  const n = daysLeft(endsAt)
  return h('p', { className: 'banner' },
    `Your subscription has ended. Your account is read-only, and your cloud audio and projects will be permanently deleted on ${dateOf(endsAt)} ` +
    `(${n} ${n === 1 ? 'day' : 'days'} left). `,
    h('a', { href: '#/account' }, 'Download your data'), '. Add time before then to keep everything. Your account itself is never deleted.')
}

/** After the retention window: the cloud data is gone, the account is not. */
function lapsedBanner() {
  return h('p', { className: 'banner' },
    'Your subscription has ended and your cloud audio and projects have been deleted. Your account is still here: add time to use the cloud again. ',
    'Projects on this device are untouched.')
}

/** Shown in the last two weeks of pre-paid time. */
function endingBanner(paidThrough: number) {
  const n = daysLeft(paidThrough)
  return h('p', { className: 'banner' },
    `Your pre-paid time ends on ${dateOf(paidThrough)} (${n} ${n === 1 ? 'day' : 'days'}). After that your cloud audio and projects become read-only for 30 days, then your cloud audio and projects are deleted. `,
    h('a', { href: '#/account' }, 'Account'))
}
