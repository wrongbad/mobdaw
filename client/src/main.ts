import './theme/tokens.css'
import './theme/base.css'
import './styles.css'
import './ui/touchSlider'
import { api, ApiError, getToken } from './api'
import { go, route, start } from './router'
import { h, mount } from './dom'
import { loginPage } from './pages/login'
import { registerPage } from './pages/register'
import { homePage } from './pages/home'
import { accountPage } from './pages/account'
import { adminPage } from './pages/admin'
import { uploadsPage } from './pages/uploads'
import { projectPage } from './project/page'
import { localProjectPage } from './project/localPage'
import { engineTestPage } from './pages/engineTest'
import type { Me } from '@mobdaw/shared'
// iOS Safari's page pinch arrives as proprietary gesture events; cancelling them keeps a pinch from zooming the page.
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault())

async function getMe(): Promise<Me | null> {
  try {
    return await api.me()
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null
    throw e
  }
}

/** Run an authenticated route: redirect to login when signed out. */
function guarded(fn: (me: Me, params: string[]) => void | (() => void), opts: { admin?: boolean } = {}) {
  return (params: string[]) => {
    let cleanup: void | (() => void)
    let dead = false
    getMe().then((me) => {
      if (dead) return
      if (!me) return go('/login')
      if (opts.admin && !me.isAdmin) return go('/')
      cleanup = fn(me, params)
    }).catch((e) => mount(h('p', { className: 'error' }, String(e.message ?? e))))
    return () => {
      dead = true
      if (typeof cleanup === 'function') cleanup()
    }
  }
}

/** The signed-in account if there is one; working on this device needs none. */
function optional(fn: (me: Me | null) => void | (() => void)) {
  return () => {
    let cleanup: void | (() => void)
    let dead = false
    ;(getToken() ? getMe() : Promise.resolve(null)).then((me) => {
      if (!dead) cleanup = fn(me)
    }).catch((e) => mount(h('p', { className: 'error' }, String(e.message ?? e))))
    return () => {
      dead = true
      if (typeof cleanup === 'function') cleanup()
    }
  }
}

route(/^\/login$/, () => void loginPage(() => go('/')))
route(/^\/register(?:\/([^/]+))?$/, ([invite]) => void registerPage(invite ?? '', () => go('/')))
route(/^\/$/, optional((me) => homePage(me)))
route(/^\/(?:projects|local)$/, () => go('/', true)) // old URLs
route(/^\/uploads$/, guarded((me) => uploadsPage(me)))
route(/^\/account$/, guarded((me) => accountPage(me)))
route(/^\/local\/([^/]+)$/, ([id]) => localProjectPage(id))
route(/^\/admin$/, guarded((me) => adminPage(me), { admin: true }))
// (signed-out visitors may open a public project, read-only; projectPage sends them to login if it isn't one)
route(/^\/project\/([^/]+)$/, ([id]) => optional((me) => projectPage(me, id))())
route(/^\/engine-test$/, guarded((me) => engineTestPage(me))) // dev tool, linked from nowhere
start('/')
