import type { Me } from '@mobdaw/shared'
import { h, mount } from '../dom'
import { safeName, saveBlob } from '../download'
import { describeError } from '../errors'
import { dateOf } from '../format'
import { createLocal, listLocal, removeLocal, renameLocal, type LocalProject } from '../local/projects'
import { PROJECT_FILE_EXT, writeProjectFile } from '../projectFile'
import { collectLocal, importProjectFile, localToCloud } from '../transfer'
import { nav } from '../ui/nav'

/**
 * Projects on this device. Works with no account: nothing here is sent to the server. A signed-in account can also
 * move a project into the cloud (where it can be shared and edited together).
 */
export function localProjectsPage(me: Me | null) {
  const list = h('ul', { className: 'list' })
  const err = h('p', { className: 'error' })
  const status = h('p', { className: 'dim' })
  const name = h('input', { placeholder: 'new project', required: true })
  const picker = h('input', { type: 'file', accept: `${PROJECT_FILE_EXT},application/x-mobdaw-project`, hidden: true })

  const busy = async (msg: string, fn: () => Promise<unknown>) => {
    err.textContent = ''
    status.textContent = msg
    try {
      await fn()
    } catch (e) {
      err.textContent = describeError(e)
    } finally {
      status.textContent = ''
    }
    render()
  }

  const canUpload = !!me && me.planStatus === 'active'

  function row(p: LocalProject) {
    return h('li', {},
      h('a', { href: `#/local/${p.id}` }, p.name),
      h('span', { className: 'dim small' }, `edited ${dateOf(p.updatedAt)}`),
      h('span', { className: 'grow' }),
      h('button', { title: 'save this project and its audio as a file', onclick: () => busy(`Exporting ${p.name}…`, async () => {
        saveBlob(writeProjectFile(await collectLocal(p.id)), safeName(p.name) + PROJECT_FILE_EXT)
      }) }, 'Export'),
      me ? h('button', {
        disabled: !canUpload, title: canUpload ? 'move a copy to the cloud, where you can share it' : 'your subscription has ended',
        onclick: () => busy('Uploading…', async () => {
          const id = await localToCloud(p.id, me, (m) => (status.textContent = m))
          location.hash = `#/project/${id}`
        }),
      }, 'Upload to cloud') : null,
      h('button', { onclick: () => {
        const n = prompt('Rename project', p.name)?.trim()
        if (n && n !== p.name) (renameLocal(p.id, n), render())
      } }, 'Rename'),
      h('button', { onclick: () => {
        if (confirm(`Delete "${p.name}" from this device? Its audio is deleted too, and this cannot be undone. Export it first to keep a copy.`)) busy('Deleting…', () => removeLocal(p.id))
      } }, 'Delete'))
  }

  function render() {
    const all = listLocal()
    list.replaceChildren(...(all.length ? all.map(row) : [h('li', { className: 'dim' }, 'No projects on this device yet.')]))
  }

  picker.onchange = () => {
    const file = picker.files?.[0]
    picker.value = ''
    if (file) void busy(`Importing ${file.name}…`, async () => void (location.hash = `#/local/${(await importProjectFile(file)).id}`))
  }

  mount(nav(me), h('main', {},
    h('h2', {}, 'On this device'),
    h('p', { className: 'dim' },
      'These projects are saved in this browser, on this device only. Nothing is sent to a server, and no account is needed. ' +
      'Clearing your browser\'s site data deletes them, so export a project file to keep a backup.'),
    h('form', {
      className: 'row',
      onsubmit: (e: Event) => {
        e.preventDefault()
        location.hash = `#/local/${createLocal(name.value).id}`
      },
    }, name, h('button', {}, 'Create'), h('button', { type: 'button', onclick: () => picker.click() }, 'Import file')),
    picker, status, err, list,
    me ? null : h('p', { className: 'dim' }, 'Want cloud storage and to edit with others in real time? ', h('a', { href: '#/login' }, 'Sign in to mobdaw Pro'), '.')))
  render()
}
