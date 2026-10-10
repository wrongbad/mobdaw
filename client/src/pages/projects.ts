import type { Me, ProjectDetail, ProjectSummary } from '@mobdaw/shared'
import { api } from '../api'
import { h, mount } from '../dom'
import { describeError } from '../errors'
import { dateOf } from '../format'
import { cloudToLocal } from '../transfer'
import { nav } from '../ui/nav'

export function projectsPage(me: Me) {
  const list = h('ul', { className: 'list' })
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
    const li = h('li', {}, h('a', { href: `#/project/${p.id}` }, p.name))
    if (p.role !== 'owner') li.append(h('span', { className: 'dim' }, ` by ${p.ownerUsername} (${p.role})`))
    // Read-only: the account's own subscription ended, or the owner's did (the project is frozen until they resubscribe).
    const accountRO = me.planStatus !== 'active'
    const locked = accountRO || p.frozen
    if (p.frozen && p.retentionEndsAt)
      li.append(h('span', { className: 'dim small' }, p.role === 'owner' ? 'read-only' : `read-only: ${p.ownerUsername}'s subscription ended; deleted ${dateOf(p.retentionEndsAt)}`))
    li.append(h('span', { className: 'grow' }))
    const toDevice = h('button', {
      title: 'copy this project and its audio to this device',
      onclick: () => {
        err.textContent = 'Copying to this device…'
        cloudToLocal(p.id, me, (m) => (err.textContent = m)).then(
          (lp) => (location.hash = `#/local/${lp.id}`), (e) => (err.textContent = describeError(e)))
      },
    }, 'Copy to this device')
    const copy = h('button', { disabled: accountRO, onclick: () => act(() => api.copyProject(p.id)) }, 'Save a copy')
    if (!d) {
      li.append(toDevice, copy, h('button', { onclick: () => confirm(`Leave "${p.name}"?`) && act(() => api.leaveProject(p.id)) }, 'Leave'))
      return li
    }
    const rename = h('button', { disabled: locked, onclick: () => {
      const n = prompt('Rename project', p.name)?.trim()
      if (n && n !== p.name) act(() => api.renameProject(p.id, n))
    } }, 'Rename')
    const remove = h('button', { onclick: () => {
      if (confirm(`Delete "${p.name}"? This deletes it for all members and cannot be undone.`)) act(() => api.deleteProject(p.id))
    } }, 'Delete')
    li.append(toDevice, copy, rename, remove)

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
    li.append(h('details', { className: 'members' }, h('summary', {}, `${members.length} shared`), ...members,
      h('div', { className: 'row' }, pick, role)))
    return li
  }

  mount(nav(me), h('main', {},
    h('form', {
      className: 'row',
      onsubmit: (e: Event) => {
        e.preventDefault()
        api.createProject({ name: name.value }).then((p) => (location.hash = `#/project/${p.id}`), (e) => (err.textContent = describeError(e)))
      },
    }, name, h('button', { disabled: me.planStatus !== 'active' }, 'Create')),
    err, list))
  render().catch((e) => (err.textContent = describeError(e)))
}
