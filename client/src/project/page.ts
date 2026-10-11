import type { Me } from '@mobdaw/shared'
import { api } from '../api'
import { h, mount } from '../dom'
import { go, homeLink } from '../router'
import { mountTimeline } from '../ui/timeline'
import { openSession } from './session'

export function projectPage(me: Me, id: string) {
  let cleanup = () => {}
  let dead = false
  api.project(id).then((p) => {
    if (dead) return
    const session = openSession(id, me)
    // Viewers can't edit; neither can anyone while the account (or the project's owner) is read-only.
    const tl = mountTimeline(session, p.name, p.role === 'viewer' || p.frozen || me.planStatus !== 'active',
      p.role === 'owner' && !p.frozen && me.planStatus === 'active' ? (n) => api.renameProject(id, n) : undefined)
    mount(tl.el)
    // The server closes our connection when access changes (removed, role changed, project deleted).
    const lost = () => {
      if (dead) return
      mount(h('main', { className: 'center' }, h('p', {}, 'this project was deleted, or you no longer have access.')))
      setTimeout(() => dead || go('/'), 2000)
    }
    session.provider!.on('authenticationFailed', lost)
    session.provider!.on('close', ({ event }: { event: { reason?: string } }) => {
      if (event.reason === 'access_changed') api.project(id).then(() => location.reload(), lost)
    })
    cleanup = () => {
      tl.destroy()
      session.destroy()
    }
  }, () => mount(h('main', { className: 'center' }, h('p', { className: 'error' }, 'project not found.'),
    h('a', homeLink, 'back'))))
  return () => {
    dead = true
    cleanup()
  }
}
