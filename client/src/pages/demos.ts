import * as Y from 'yjs'
import { projectPreview, type Me } from '@mobdaw/shared'
import { api } from '../api'
import { h } from '../dom'
import { describeError } from '../errors'
import { buildDemo, DEMO_BPM, DEMO_NAME, demoContents } from '../content/demo'
import { importToLocal } from '../transfer'
import { projectTile } from '../ui/tile'

/** Demo projects: public projects an admin picked. Anyone can open one read-only, signed in or not. */
export function demoSection(me: Me | null): HTMLElement {
  const list = h('ul', { className: 'tiles' })
  const err = h('p', { className: 'error' })
    // The built-in demo is always first: it needs neither the server nor an account.
  const builtIn = projectTile({
    href: '#/', name: DEMO_NAME, details: [`built in, ${DEMO_BPM} bpm`, ' · opens as your own copy'],
    preview: async () => { const d = new Y.Doc(); buildDemo(d); return projectPreview(d) },
    actions: [],
  })
  const link = builtIn.querySelector('a')!
  link.title = 'make your own copy of the built-in demo song and open it'
  link.onclick = async (ev) => {
    ev.preventDefault()
    err.textContent = ''
    try { location.hash = `#/local/${(await importToLocal(demoContents())).id}` } catch (e) { err.textContent = describeError(e) }
  }
  list.append(builtIn)
  const section = h('section', { className: 'section' }, h('h2', {}, 'demo'), err, list)
  api.demos().then((projects) => {
    list.replaceChildren(builtIn, ...projects.map((p) => projectTile({
      href: `#/project/${p.id}`, name: p.name,
      details: [p.ownerUsername === me?.username ? 'yours' : `by ${p.ownerUsername}`],
      preview: () => api.projectPreview(p.id),
      actions: [],
    })))
  }, (e) => (err.textContent = describeError(e)))
  return section
}
