import type { Me, ProjectDetail, ProjectSummary } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { describeError } from '../errors'
import { deleteProjectAudio } from '../local/audio'
import { dateOf } from '../format'
import { cloudToLocal } from '../transfer'
import { silliName } from '../projectName'
import { memberRows } from '../ui/members'
import { newProjectTile, projectTile, type TileAction } from '../ui/tile'

/** A cloud project we no longer have: drop the takes this device staged for it (docs/engine.md §9.3). */
const forgetTakes = (id: string) => deleteProjectAudio(id).catch(() => {})

/** The account's cloud projects: owned, shared with you, and the way to create one. */
export function cloudSection(me: Me): HTMLElement {
  const list = h('ul', { className: 'tiles' })
  const err = h('p', { className: 'error' })
  const create = newProjectTile(
    () => api.createProject({ name: silliName() }).then((p) => (location.hash = `#/project/${p.id}`), (e) => (err.textContent = describeError(e))),
    { title: me.planStatus === 'active' ? 'start a new cloud project' : 'your subscription has ended', disabled: me.planStatus !== 'active' })

  // Run an action, then refresh the list; show any error.
  const act = (fn: () => Promise<unknown>) =>
    fn().then(() => ((err.textContent = ''), render()), (e) => (err.textContent = describeError(e)))

  async function render() {
    const [projects, users] = await Promise.all([api.projects(), api.users()])
    const details = await Promise.all(projects.map((p) => (p.role === 'owner' ? api.project(p.id) : null)))
    list.replaceChildren(create, ...projects.map((p, i) => row(p, details[i], users.map((u) => u.username))))
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
        label: 'copy to local', title: 'copy this project and its audio to this device',
        onclick: () => {
          err.textContent = 'copying to local…'
          cloudToLocal(p.id, me, (m) => (err.textContent = m)).then(
            (lp) => (location.hash = `#/local/${lp.id}`), (e) => (err.textContent = describeError(e)))
        },
      },
      { label: 'save a copy', disabled: accountRO, onclick: () => act(() => api.copyProject(p.id)) },
    ]
    const tile = (extra?: Node[]) => projectTile({
      href: `#/project/${p.id}`, name: p.name, details, preview: () => api.projectPreview(p.id), actions, extra,
    })
    if (!d) {
      actions.push({ label: 'leave', danger: true, onclick: () => confirm(`leave "${p.name}"?`) && act(() => api.leaveProject(p.id).then(() => forgetTakes(p.id))) })
      return tile()
    }
    actions.push(
      { label: 'rename', disabled: locked, onclick: () => {
        const n = prompt('rename project', p.name)?.trim()
        if (n && n !== p.name) act(() => api.renameProject(p.id, n))
      } },
      { label: 'Delete', danger: true, onclick: () => {
        if (confirm(`delete "${p.name}"? this deletes it for all members and cannot be undone.`)) act(() => api.deleteProject(p.id).then(() => forgetTakes(p.id)))
      } })

    // Members: change role / remove, and share with someone new.
    const rows = memberRows({ projectId: p.id, members: d.members, usernames, me: me.username, locked, act })
    return tile([h('details', { className: 'members' }, h('summary', {}, `${d.members.filter((m) => m.role !== 'owner').length} shared`), ...rows)])
  }

  const section = h('section', { className: 'home-sec' },
    h('div', { className: 'sec-head' }, h('h2', {}, 'Cloud')),
    err, list)
  render().catch((e) => (err.textContent = describeError(e)))
  return section
}
