import type { Me } from '@mobdaw/shared'
import { api, ApiError } from '../api'
import { h, mount } from '../dom'
import { go, homeLink } from '../router'
import { collectCloud, importToLocal } from '../transfer'
import { mountTimeline } from '../ui/timeline'
import { openSession } from './session'

/** The editor for a cloud project. `me` is null for a signed-out visitor, who gets a public project read-only. */
export function projectPage(me: Me | null, id: string) {
  let cleanup = () => {}
  let dead = false
  api.project(id).then((p) => {
    if (dead) return
    // Not a collaborator: signed out, or in only because the project is public.
    const watching = !me || (p.role === 'viewer' && !p.members.some((m) => m.username === me.username))
    const session = openSession(id, me ?? { id: null, username: 'guest' }, watching)
    // Viewers can't edit; neither can anyone while the account (or the project's owner) is read-only.
    const tl = mountTimeline(session, p.name, me !== null && (p.role === 'viewer' || p.frozen || me.planStatus !== 'active'),
      me && p.role === 'owner' && !p.frozen && me.planStatus === 'active' ? (n) => api.renameProject(id, n) : undefined,
      { projectId: id, me: me?.username ?? '', role: p.role,
        saveCopy: session.scratch ? async () => {
          const c = await collectCloud(id, { id: null }, undefined, session.doc)
          go(`/local/${(await importToLocal(c)).id}`)
        } : undefined,
        owner: p.role === 'owner', locked: p.frozen || !me || me.planStatus !== 'active', public: p.public, admin: !!me?.isAdmin, demo: p.demo })
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
  }, (e) => {
    if (dead) return
    if (!me && e instanceof ApiError && (e.status === 401 || e.status === 404)) return go('/login') // not public: sign in
    mount(h('main', { className: 'center' }, h('p', { className: 'error' }, 'project not found.'), h('a', homeLink, 'back')))
  })
  return () => {
    dead = true
    cleanup()
  }
}
