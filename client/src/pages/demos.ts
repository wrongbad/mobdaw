import type { Me } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { describeError } from '../errors'
import { projectTile } from '../ui/tile'

/** Demo projects: public projects an admin picked. Anyone can open one read-only, signed in or not. */
export function demoSection(me: Me | null): HTMLElement {
  const list = h('ul', { className: 'tiles' })
  const err = h('p', { className: 'error' })
  const empty = h('p', { className: 'dim', hidden: true }, 'no demos yet.')
  const section = h('section', { className: 'home-sec' }, h('div', { className: 'sec-head' }, h('h2', {}, 'Demos')), err, list, empty)
  api.demos().then((projects) => {
    empty.hidden = projects.length > 0
    list.replaceChildren(...projects.map((p) => projectTile({
      href: `#/project/${p.id}`, name: p.name,
      details: [p.ownerUsername === me?.username ? 'yours' : `by ${p.ownerUsername}`],
      preview: () => api.projectPreview(p.id),
      actions: [],
    })))
  }, (e) => (err.textContent = describeError(e)))
  return section
}
