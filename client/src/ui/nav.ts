import type { Me } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { homeLink } from '../router'
import { dateOf, daysLeft } from '../format'
import { describeError } from '../errors'
import { PROJECT_FILE_EXT } from '../projectFile'
import { importProjectFile } from '../transfer'

/** Top bar for every page except the editor. `me` is null when working locally without an account. */
export function nav(me: Me | null): HTMLElement {
  const bar = h('nav', {},
    h('a', { ...homeLink, className: 'logo' }, 'mobdaw'),
    h('span', { className: 'grow' }),
    importButton(),
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

/** Opens a project file and lands in the imported local project. */
function importButton(): HTMLElement {
  const picker = h('input', { type: 'file', accept: `${PROJECT_FILE_EXT},application/x-mobdaw-project`, hidden: true })
  const link = h('a', {
    href: '#', title: 'import a project file',
    onclick: (e: Event) => (e.preventDefault(), picker.click()),
  }, 'import')
  picker.onchange = async () => {
    const file = picker.files?.[0]
    picker.value = ''
    if (!file) return
    link.textContent = 'importing…'
    try {
      location.hash = `#/local/${(await importProjectFile(file)).id}`
    } catch (e) {
      alert(describeError(e))
    } finally {
      link.textContent = 'import'
    }
  }
  return h('span', {}, link, picker)
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
