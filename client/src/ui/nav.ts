import type { Me } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { homeLink } from '../router'
import { dateOf, daysLeft } from '../format'
import { icon } from '../theme/icons'
import { popover } from './popover'

/** Top bar for every page except the editor. `me` is null when working locally without an account. */
export function nav(me: Me | null): HTMLElement {
  const bar = h('nav', { className: 'site-nav' },
    h('a', { ...homeLink, className: 'logo', 'aria-label': 'mobdaw home' }, 'mobdaw'),
    h('span', { className: 'grow' }),
    accountMenu(me),
  )
  const banner = !me ? null
    : me.planStatus === 'read_only' && me.retentionEndsAt ? retentionBanner(me.retentionEndsAt)
    : me.planStatus === 'lapsed' ? lapsedBanner()
    : me.planStatus === 'active' && me.paidThrough - Date.now() < 14 * 86_400_000 ? endingBanner(me.paidThrough)
    : null
  return h('div', { className: 'top' }, bar, banner)
}

/** Signed in: the account's menu. Signed out: a sign-in link. */
function accountMenu(me: Me | null): HTMLElement {
  if (!me) return h('a', { href: '#/login', className: 'nav-link' }, 'sign in')
  const btn = h('button', { className: 'nav-user', 'aria-haspopup': 'menu' }, icon('users'), me.username, icon('chevron-down'))
  btn.onclick = () => popover(btn, [
    { label: 'account', run: () => (location.hash = '#/account'), icon: 'settings' },
    { label: 'uploads', run: () => (location.hash = '#/uploads'), icon: 'wave' },
    ...(me.isAdmin ? [{ label: 'invites', run: () => (location.hash = '#/admin'), icon: 'users' as const }] : []),
    'sep',
    { label: 'log out', run: () => void api.logout().finally(() => (location.hash = '#/login')) },
  ])
  return btn
}

/** Shown on every page while an account is in its 30-day retention window. */
function retentionBanner(endsAt: number) {
  const n = daysLeft(endsAt)
  return h('p', { className: 'banner' },
    `your subscription has ended. your account is read-only, and your cloud audio and projects will be permanently deleted on ${dateOf(endsAt)} ` +
    `(${n} ${n === 1 ? 'day' : 'days'} left). `,
    h('a', { href: '#/account' }, 'download your data'), '. add time before then to keep everything. your account itself is never deleted.')
}

/** After the retention window: the cloud data is gone, the account is not. */
function lapsedBanner() {
  return h('p', { className: 'banner' },
    'your subscription has ended and your cloud audio and projects have been deleted. your account is still here: add time to use the cloud again. ',
    'local projects are untouched.')
}

/** Shown in the last two weeks of pre-paid time. */
function endingBanner(paidThrough: number) {
  const n = daysLeft(paidThrough)
  return h('p', { className: 'banner' },
    `your pre-paid time ends on ${dateOf(paidThrough)} (${n} ${n === 1 ? 'day' : 'days'}). after that your cloud audio and projects become read-only for 30 days, then your cloud audio and projects are deleted. `,
    h('a', { href: '#/account' }, 'account'))
}
