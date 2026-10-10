import { h, mount } from '../dom'
import { getLocal } from '../local/projects'
import { openLocalSession } from '../local/session'
import { mountTimeline } from '../ui/timeline'

/** The editor for a project on this device. */
export function localProjectPage(id: string) {
  const project = getLocal(id)
  if (!project) {
    mount(h('main', { className: 'center' }, h('p', { className: 'error' }, 'That project is not on this device.'), h('a', { href: '#/local' }, 'back')))
    return
  }
  const session = openLocalSession(id)
  const tl = mountTimeline(session, project.name)
  mount(tl.el)
  return () => {
    tl.destroy()
    session.destroy()
  }
}
