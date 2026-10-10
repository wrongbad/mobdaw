import type { Me, UploadInfo } from '@mobdaw/shared'
import { api } from '../api'
import { h, mount } from '../dom'
import { saveBlob, safeName } from '../download'
import { describeError } from '../errors'
import { bytes } from '../format'
import { nav } from '../ui/nav'

/** "My uploads": every audio file you own, where it is used, and the way to delete it. */
export function uploadsPage(me: Me) {
  const list = h('ul', { className: 'list' })
  const err = h('p', { className: 'error' })
  const used = h('p', { className: 'dim' })

  const where = (u: UploadInfo) => {
    const names = u.projects.map((p) => `"${p.name}"`)
    if (u.otherProjects) names.push(`${u.otherProjects} other project${u.otherProjects === 1 ? '' : 's'} you can no longer see`)
    return names.length ? names.join(', ') : null
  }

  async function download(u: UploadInfo) {
    err.textContent = ''
    try {
      const { url } = await api.uploadFileUrl(u.hash)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      saveBlob(await res.blob(), safeName(u.name, u.hash.slice(0, 12)))
    } catch (e) {
      err.textContent = describeError(e)
    }
  }

  function remove(u: UploadInfo) {
    const label = u.name || u.hash.slice(0, 12)
    const used = where(u)
    const msg = used
      ? `Delete "${label}"? It will be removed from ${used}, for everyone, and cannot be undone.`
      : `Delete "${label}"? This cannot be undone.`
    if (!confirm(msg)) return
    api.deleteUpload(u.hash).then(() => ((err.textContent = ''), render()), (e) => (err.textContent = describeError(e)))
  }

  function row(u: UploadInfo) {
    const w = where(u)
    return h('li', {},
      h('span', { className: 'grow' }, h('div', {}, u.name || u.hash.slice(0, 12)),
        h('div', { className: 'dim small' }, `${bytes(u.size)} · ${w ? `used in ${w}` : 'not used in any project'}`)),
      h('button', { onclick: () => download(u) }, 'Download'),
      h('button', { onclick: () => remove(u) }, 'Delete'))
  }

  async function render() {
    const [uploads, current] = await Promise.all([api.uploads(), api.me()])
    used.textContent = `${bytes(current.bytesUsed)} of ${bytes(current.quotaBytes)} used. Only you can delete your uploads.`
    list.replaceChildren(...(uploads.length ? uploads.map(row) : [h('li', { className: 'dim' }, 'You have not uploaded any audio.')]))
  }

  mount(nav(me), h('main', {}, h('h2', {}, 'Your uploads'), used, err, list))
  render().catch((e) => (err.textContent = describeError(e)))
}
