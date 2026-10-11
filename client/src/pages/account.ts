import { monthsLeft, type Me } from '@mobdaw/shared'
import { api } from '../api'
import { go } from '../router'
import { h, mount } from '../dom'
import { safeName, saveBlob } from '../download'
import { describeError } from '../errors'
import { bytes, dateOf, daysLeft } from '../format'
import { PROJECT_FILE_EXT, writeProjectFile } from '../projectFile'
import { collectCloud } from '../transfer'
import { nav } from '../ui/nav'

/** Plan and storage, and the way to delete the account. */
export function accountPage(me: Me) {
  const err = h('p', { className: 'error' })
  const password = h('input', { type: 'password', placeholder: 'your password', autocomplete: 'current-password' })

  const months = monthsLeft(me.paidThrough)
  const plan = me.planStatus === 'read_only' && me.retentionEndsAt
    ? h('p', {}, 'your pre-paid time has run out. your account is read-only until ', h('strong', {}, dateOf(me.retentionEndsAt)),
        ` (${daysLeft(me.retentionEndsAt)} days). after that, your cloud audio and projects are permanently deleted. your account stays, and you can use the cloud again whenever you add time.`)
    : me.planStatus === 'lapsed'
    ? h('p', {}, 'your pre-paid time ran out and your cloud audio and projects have been deleted. your account is still here: add time to use the cloud again, starting fresh.')
    : h('div', {},
        h('p', {}, 'mobdaw pro is active.'),
        h('p', {}, 'paid through ', h('strong', {}, dateOf(me.paidThrough)),
          ` (${months} ${months === 1 ? 'month' : 'months'} of pre-paid time).`),
        h('p', { className: 'dim' },
          'when pre-paid time runs out, your cloud audio and projects become read-only for 30 days so you can download your data, and then your cloud audio and projects are deleted. your account is never deleted automatically. ' +
          'payments are not set up yet; time comes from invites and gifts.'))

  const progress = h('p', { className: 'dim' })
  const buttons: HTMLButtonElement[] = []
  /** Run a download job with the buttons disabled and a running status line. */
  const job = (fn: () => Promise<void>) => async () => {
    err.textContent = ''
    buttons.forEach((b) => (b.disabled = true))
    try {
      await fn()
      progress.textContent = 'done.'
    } catch (e) {
      progress.textContent = ''
      err.textContent = describeError(e)
    } finally {
      buttons.forEach((b) => (b.disabled = false))
    }
  }
  const downloadUploads = job(async () => {
    const uploads = await api.uploads()
    for (const [i, u] of uploads.entries()) {
      progress.textContent = `downloading ${i + 1} of ${uploads.length}: ${u.name || u.hash.slice(0, 12)}…`
      const res = await fetch((await api.uploadFileUrl(u.hash)).url)
      if (!res.ok) throw new Error(`http ${res.status}`)
      saveBlob(await res.blob(), safeName(u.name, u.hash.slice(0, 12)))
    }
  })
  const downloadProjects = job(async () => {
    const mine = (await api.projects()).filter((p) => p.role === 'owner')
    for (const p of mine) saveBlob(writeProjectFile(await collectCloud(p.id, me, (m) => (progress.textContent = m))), safeName(p.name) + PROJECT_FILE_EXT)
  })
  buttons.push(
    h('button', { onclick: downloadUploads }, 'download my uploads'),
    h('button', { onclick: downloadProjects }, 'download my projects'),
  )

  const del = h('button', { className: 'danger', onclick: () => {
    if (!password.value) return void (err.textContent = 'enter your password to confirm.')
    if (!confirm('delete your account now? your projects (for every member you shared them with) and all of your uploads are permanently deleted. this cannot be undone.')) return
    api.deleteAccount(password.value).then(() => go('/'), (e) => (err.textContent = describeError(e)))
  } }, 'delete my account')

  mount(nav(me), h('main', {},
    h('h2', {}, 'account'),
    h('p', {}, h('strong', {}, me.username)),
    plan,
    h('p', { className: 'dim' }, `${bytes(me.bytesUsed)} of ${bytes(me.quotaBytes)} storage used.`, ' ', h('a', { href: '#/uploads' }, 'manage uploads')),
    h('h3', {}, 'download your data'),
    h('p', { className: 'dim' }, 'your uploads come back as the original audio files. your projects come back as project files, each with its audio; open one with import on the local page.'),
    h('div', { className: 'row' }, ...buttons),
    progress,
    h('h3', {}, 'delete account'),
    h('p', { className: 'dim' }, 'deletes your account, your cloud audio and your projects immediately. this is the only way an account is ever deleted. download anything you want to keep first.'),
    h('div', { className: 'row' }, password, del),
    err))
}
