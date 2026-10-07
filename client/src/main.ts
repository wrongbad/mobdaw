import '@fontsource/pirata-one'
import './styles.css'
import { api, ApiError } from './api'
import { go, route, start } from './router'
import { h, mount } from './dom'
import { loginPage } from './pages/login'
import { invitePage } from './pages/invite'
import { projectsPage } from './pages/projects'
import { adminPage } from './pages/admin'
import { notInvitedPage } from './pages/notInvited'
import { projectPage } from './project/page'
import { engineTestPage } from './pages/engineTest'
import type { Me } from '@mobdaw/shared'

async function getMe(): Promise<Me | null> {
  try {
    return await api.me()
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null
    throw e
  }
}

/** Run an authenticated route: redirect to login when signed out, show invite notice when not admitted. */
function guarded(fn: (me: Me, params: string[]) => void | (() => void), opts: { admin?: boolean } = {}) {
  return (params: string[]) => {
    let cleanup: void | (() => void)
    let dead = false
    getMe().then((me) => {
      if (dead) return
      if (!me) return go('/login')
      if (!me.admitted) return notInvitedPage(me)
      if (opts.admin && !me.isAdmin) return go('/projects')
      cleanup = fn(me, params)
    }).catch((e) => mount(h('p', { className: 'error' }, String(e.message ?? e))))
    return () => {
      dead = true
      if (typeof cleanup === 'function') cleanup()
    }
  }
}

route(/^\/login$/, () => void loginPage(() => go('/projects')))
route(/^\/invite\/([^/]+)$/, ([token]) => void invitePage(token, getMe))
route(/^\/projects$/, guarded((me) => projectsPage(me)))
route(/^\/admin$/, guarded((me) => adminPage(me), { admin: true }))
route(/^\/project\/([^/]+)$/, guarded((me, [id]) => projectPage(me, id)))
route(/^\/engine-test$/, guarded((me) => engineTestPage(me))) // dev tool, linked from nowhere
start('/projects')
