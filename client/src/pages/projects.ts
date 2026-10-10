import type { Me, ProjectDetail, ProjectSummary } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { describeError } from '../errors'
import { deleteProjectAudio } from '../local/audio'
import { dateOf } from '../format'
import { cloudToLocal } from '../transfer'
import { projectTile, type TileAction } from '../ui/tile'

/** A cloud project we no longer have: drop the takes this device staged for it (docs/engine.md §9.3). */
const forgetTakes = (id: string) => deleteProjectAudio(id).catch(() => {})

/** The account's cloud projects: owned, shared with you, and the way to create one. */
export function cloudSection(me: Me): HTMLElement {
  const list = h('ul', { className: 'tiles' })
  const err = h('p', { className: 'error' })
  const name = h('input', { placeholder: 'new project', required: true, disabled: me.planStatus !== 'active' })

  // Run an action, then refresh the list; show any error.
  const act = (fn: () => Promise<unknown>) =>
    fn().then(() => ((err.textContent = ''), render()), (e) => (err.textContent = describeError(e)))

  async function render() {
    const [projects, users] = await Promise.all([api.projects(), api.users()])
    const details = await Promise.all(projects.map((p) => (p.role === 'owner' ? api.project(p.id) : null)))
    list.replaceChildren(...projects.map((p, i) => row(p, details[i], users.map((u) => u.username))))
  }

  function row(p: ProjectSummary, d: ProjectDetail | null, usernames: string[]) {
    // Read-only: the account's own subscription ended, or the owner's did (the project is frozen until they resubscribe).
    const accountRO = me.planStatus !== 'active'
    const locked = accountRO || p.frozen
    const details: string[] = []
    if (p.role !== 'owner') details.push(`by ${p.ownerUsername} (${p.role})`)
    if (p.frozen && p.retentionEndsAt)
      details.push(p.role === 'owner' ? 'read-only' : `read-only: ${p.ownerUsername}'s subscription ended; deleted ${dateOf(p.retentionEndsAt)}`)
    const actions: TileAction[] = [
      {
        label: 'Copy to this device', title: 'copy this project and its audio to this device',
        onclick: () => {
          err.textContent = 'Copying to this device…'
          cloudToLocal(p.id, me, (m) => (err.textContent = m)).then(
            (lp) => (location.hash = `#/local/${lp.id}`), (e) => (err.textContent = describeError(e)))
        },
      },
      { label: 'Save a copy', disabled: accountRO, onclick: () => act(() => api.copyProject(p.id)) },
    ]
    const tile = (extra?: Node[]) => projectTile({
      href: `#/project/${p.id}`, name: p.name, details, preview: () => api.projectPreview(p.id), actions, extra,
    })
    if (!d) {
      actions.push({ label: 'Leave', danger: true, onclick: () => confirm(`Leave "${p.name}"?`) && act(() => api.leaveProject(p.id).then(() => forgetTakes(p.id))) })
      return tile()
    }
    actions.push(
      { label: 'Rename', disabled: locked, onclick: () => {
        const n = prompt('Rename project', p.name)?.trim()
        if (n && n !== p.name) act(() => api.renameProject(p.id, n))
      } },
      { label: 'Delete', danger: true, onclick: () => {
        if (confirm(`Delete "${p.name}"? This deletes it for all members and cannot be undone.`)) act(() => api.deleteProject(p.id).then(() => forgetTakes(p.id)))
      } })

    // Members: change role / remove, and share with someone new.
    const roleSelect = (value: string, onchange: (role: 'editor' | 'viewer') => void) => {
      const s = h('select', {}, h('option', { value: 'editor' }, 'editor'), h('option', { value: 'viewer' }, 'viewer'))
      s.value = value
      s.onchange = () => onchange(s.value as 'editor' | 'viewer')
      return s
    }
    const members = d.members.filter((m) => m.role !== 'owner').map((m) =>
      h('div', { className: 'row' }, h('span', { className: 'grow' }, m.username),
        roleSelect(m.role, (role) => act(() => api.addMember(p.id, { username: m.username, role }))),
        h('button', { title: 'remove', onclick: () => act(() => api.removeMember(p.id, m.username)) }, '×')))
    const pick = h('select', { disabled: locked }, h('option', { value: '' }, 'share with…'),
      ...usernames.filter((e) => e !== me.username && !d.members.some((m) => m.username === e)).map((e) => h('option', { value: e }, e)))
    const role = roleSelect('editor', () => {})
    pick.onchange = () => pick.value && act(() => api.addMember(p.id, { username: pick.value, role: role.value as 'editor' | 'viewer' }))
    return tile([h('details', { className: 'members' }, h('summary', {}, `${members.length} shared`), ...members,
      h('div', { className: 'row' }, pick, role))])
  }

  const section = h('details', { className: 'section', open: true },
    h('summary', {}, h('h2', {}, 'Cloud')),
    h('form', {
      className: 'row',
      onsubmit: (e: Event) => {
        e.preventDefault()
        api.createProject({ name: name.value }).then((p) => (location.hash = `#/project/${p.id}`), (e) => (err.textContent = describeError(e)))
      },
    }, name, h('button', { disabled: me.planStatus !== 'active' }, 'Create')),
    err, list)
  render().catch((e) => (err.textContent = describeError(e)))
  return section
}
