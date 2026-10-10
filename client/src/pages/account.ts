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
  const readOnly = me.planStatus === 'read_only'
  const password = h('input', { type: 'password', placeholder: 'your password', autocomplete: 'current-password' })

  const months = monthsLeft(me.paidThrough)
  const plan = readOnly && me.retentionEndsAt
    ? h('p', {}, 'Your pre-paid time has run out. Your account is read-only until ', h('strong', {}, dateOf(me.retentionEndsAt)),
        ` (${daysLeft(me.retentionEndsAt)} days). After that, everything you own is permanently deleted.`)
    : h('div', {},
        h('p', {}, 'mobdaw Pro is active.'),
        h('p', {}, 'Paid through ', h('strong', {}, dateOf(me.paidThrough)),
          ` (${months} ${months === 1 ? 'month' : 'months'} of pre-paid time).`),
        h('p', { className: 'dim' },
          'When pre-paid time runs out, your account becomes read-only for 30 days so you can download your data, and is then deleted. ' +
          'Payments are not set up yet; time comes from invites and gifts.'))

  const progress = h('p', { className: 'dim' })
  const buttons: HTMLButtonElement[] = []
  /** Run a download job with the buttons disabled and a running status line. */
  const job = (fn: () => Promise<void>) => async () => {
    err.textContent = ''
    buttons.forEach((b) => (b.disabled = true))
    try {
      await fn()
      progress.textContent = 'Done.'
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
      progress.textContent = `Downloading ${i + 1} of ${uploads.length}: ${u.name || u.hash.slice(0, 12)}…`
      const res = await fetch((await api.uploadFileUrl(u.hash)).url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      saveBlob(await res.blob(), safeName(u.name, u.hash.slice(0, 12)))
    }
  })
  const downloadProjects = job(async () => {
    const mine = (await api.projects()).filter((p) => p.role === 'owner')
    for (const p of mine) saveBlob(writeProjectFile(await collectCloud(p.id, me, (m) => (progress.textContent = m))), safeName(p.name) + PROJECT_FILE_EXT)
  })
  buttons.push(
    h('button', { onclick: downloadUploads }, 'Download my uploads'),
    h('button', { onclick: downloadProjects }, 'Download my projects'),
  )

  const del = h('button', { className: 'danger', onclick: () => {
    if (!password.value) return void (err.textContent = 'Enter your password to confirm.')
    if (!confirm('Delete your account now? Your projects (for every member you shared them with) and all of your uploads are permanently deleted. This cannot be undone.')) return
    api.deleteAccount(password.value).then(() => go('/local'), (e) => (err.textContent = describeError(e)))
  } }, 'Delete my account')

  mount(nav(me), h('main', {},
    h('h2', {}, 'Account'),
    h('p', {}, h('strong', {}, me.username)),
    plan,
    h('p', { className: 'dim' }, `${bytes(me.bytesUsed)} of ${bytes(me.quotaBytes)} storage used.`, ' ', h('a', { href: '#/uploads' }, 'Manage uploads')),
    h('h3', {}, 'Download your data'),
    h('p', { className: 'dim' }, 'Your uploads come back as the original audio files. Your projects come back as project files, each with its audio; open one with Import on the "on this device" page.'),
    h('div', { className: 'row' }, ...buttons),
    progress,
    h('h3', {}, 'Delete account'),
    h('p', { className: 'dim' }, 'Deletes everything immediately, without waiting for the 30-day window. Download anything you want to keep first.'),
    h('div', { className: 'row' }, password, del),
    err))
}
