import type { Me } from '@mobdaw/shared'
import { api } from '../api'
import { h, mount } from '../dom'
import { nav } from '../ui/nav'

/** Modal showing a fresh invite link with a copy button. */
function inviteDialog(url: string) {
  const link = h('input', { readOnly: true, value: url, onclick: (e: any) => e.target.select() })
  const copy = h('button', {
    onclick: () => navigator.clipboard.writeText(url).then(() => (copy.textContent = 'copied'), () => (link.select(), (copy.textContent = 'press ctrl+c'))),
  }, 'copy to clipboard')
  const dlg = h('dialog', { className: 'invite-dialog', onclose: () => dlg.remove() },
    h('p', {}, 'invite link'), link,
    h('div', { className: 'row' }, copy, h('button', { onclick: () => dlg.close() }, 'close')))
  document.body.append(dlg)
  dlg.showModal()
  link.select()
}

export function adminPage(me: Me) {
  const months = h('input', { type: 'number', min: 0, max: 999, step: 1, value: '1', title: 'free months of pro the new account starts with', style: 'width: 70px; flex: none' })
  const memo = h('input', { placeholder: 'memo', title: 'a note about who this invite is for', style: 'width: 160px; flex: none' })
  const list = h('ul', { className: 'list' })
  const err = h('p', { className: 'error' })
  const fmt = (t: number) => new Date(t).toLocaleString()

  const refresh = () =>
    api.invites().then((all) =>
      list.replaceChildren(...all.map((i) =>
        h('li', {}, h('span', { className: 'dim' }, i.token.slice(0, 8) + '…'), h('span', { className: 'dim' }, i.memo), h('span', { className: 'grow' }),
          h('span', { className: 'dim' },
            `${i.giftMonths} mo · `, i.redeemedBy ? `used by ${i.redeemedBy}` : i.expiresAt && i.expiresAt < Date.now() ? 'expired' : `created ${fmt(i.createdAt)}`)))),
    ).catch((e) => (err.textContent = e.message))

  mount(nav(me), h('main', {},
    h('div', { className: 'row', style: 'align-items: center' },
      h('button', {
        onclick: () => api.createInvite({ giftMonths: Number(months.value), memo: memo.value }).then((r) => { memo.value = ''; inviteDialog(r.url); refresh() }, (e) => (err.textContent = e.message)),
      }, 'new invite'), months, h('span', { className: 'dim' }, 'free months'), memo),
    err, list))
  refresh()
}
