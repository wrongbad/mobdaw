import type { Me } from '@mobdaw/shared'
import { api, ApiError } from '../api'
import { h, mount } from '../dom'
import { go, homeLink } from '../router'
import { collectCloud, importToLocal } from '../transfer'
import { mountTimeline } from '../ui/timeline'
import { openSession, openSnapshotSession } from './session'

/** The editor for a cloud project. `me` is null for a signed-out visitor, who gets a public project as a snapshot. */
export function projectPage(me: Me | null, id: string) {
  let cleanup = () => {}
  let dead = false
  api.project(id).then((p) => {
    if (dead) return
    // Only an owner or editor of a project that is not frozen, with an active account, edits it live. Everyone else (a
    // viewer, a signed-out visitor, a read-only account) gets a snapshot, which they can edit in this page and save a copy of.
    const live = me !== null && p.role !== 'viewer' && !p.frozen && me.planStatus === 'active'
    const session = live ? openSession(id, me) : openSnapshotSession(id, me)
    const tl = mountTimeline(session, p.name,
      live && p.role === 'owner' ? (n) => api.renameProject(id, n) : undefined,
      { projectId: id, me: me?.username ?? '', role: p.role, owner: p.role === 'owner', locked: p.frozen || !me || me.planStatus !== 'active', public: p.public, admin: !!me?.isAdmin, demo: p.demo,
        saveCopy: live ? undefined : async () => {
          const c = await collectCloud(id, { id: me?.id ?? null }, undefined, session.doc)
          go(`/local/${(await importToLocal(c)).id}`)
        } })
    mount(tl.el)
    // The server closes our connection when access changes (removed, role changed, project deleted).
    const lost = () => {
      if (dead) return
      mount(h('main', { className: 'center' }, h('p', {}, 'this project was deleted, or you no longer have access.')))
      setTimeout(() => dead || go('/'), 2000)
    }
    session.provider?.on('authenticationFailed', lost)
    session.provider?.on('close', ({ event }: { event: { reason?: string } }) => {
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
