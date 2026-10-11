import type { Me } from '@mobdaw/shared'
import { h } from '../dom'
import { safeName, saveBlob } from '../download'
import { describeError } from '../errors'
import { dateOf } from '../format'
import { createLocal, listLocal, removeLocal, renameLocal, type LocalProject } from '../local/projects'
import { readLocalPreview } from '../local/session'
import { PROJECT_FILE_EXT, writeProjectFile } from '../projectFile'
import { collectLocal, localToCloud } from '../transfer'
import { silliName } from '../projectName'
import { newProjectTile, projectTile } from '../ui/tile'

/**
 * Projects on this device. Works with no account: nothing here is sent to the server. A signed-in account can also
 * move a project into the cloud (where it can be shared and edited together).
 */
export function localSection(me: Me | null): HTMLElement {
  const list = h('ul', { className: 'tiles' })
  const err = h('p', { className: 'error' })
  const status = h('p', { className: 'dim' })

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
    return projectTile({
      href: `#/local/${p.id}`,
      name: p.name,
      details: [`edited ${dateOf(p.updatedAt)}`],
      preview: () => readLocalPreview(p.id),
      actions: [
        { label: 'export', title: 'save this project and its audio as a file', onclick: () => busy(`exporting ${p.name}…`, async () => {
          saveBlob(writeProjectFile(await collectLocal(p.id)), safeName(p.name) + PROJECT_FILE_EXT)
        }) },
        ...(me ? [{
          label: 'upload to cloud', disabled: !canUpload,
          title: canUpload ? 'move a copy to the cloud, where you can share it' : 'your subscription has ended',
          onclick: () => busy('uploading…', async () => {
            const id = await localToCloud(p.id, me, (m) => (status.textContent = m))
            location.hash = `#/project/${id}`
          }),
        }] : []),
        { label: 'rename', onclick: () => {
          const n = prompt('rename project', p.name)?.trim()
          if (n && n !== p.name) (renameLocal(p.id, n), render())
        } },
        { label: 'Delete', danger: true, onclick: () => {
          if (confirm(`delete "${p.name}" from this device? its audio is deleted too, and this cannot be undone. export it first to keep a copy.`)) busy('deleting…', () => removeLocal(p.id))
        } },
      ],
    })
  }

  function render() {
    const all = listLocal()
    list.replaceChildren(
      newProjectTile(() => (location.hash = `#/local/${createLocal(silliName()).id}`), { title: 'start a new local project' }),
      ...all.map(row))
  }

  const section = h('section', { className: 'section' },
    h('h2', {}, 'local'),
    me ? null : h('p', { className: 'dim' }, 'local usage is completely free and no account is required.'),
    status, err, list)
  render()
  return section
}
