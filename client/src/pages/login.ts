import { api } from '../api'
import { h, mount } from '../dom'

declare const google: any

function loadGsi(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).google?.accounts) return resolve()
    const s = h('script', { src: 'https://accounts.google.com/gsi/client', async: true })
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Could not load Google sign-in'))
    document.head.append(s)
  })
}

/** Renders the login form. `done` is called after a successful login. */
export async function loginPage(done: () => void) {
  const err = h('p', { className: 'error' })
  const box = h('div', { className: 'card' }, h('h1', {}, 'mobdaw'))
  mount(h('main', { className: 'center' }, box, err))
  const fail = (e: unknown) => (err.textContent = (e as Error).message)
  const cfg = await api.config()

  if (cfg.authMode === 'google') {
    const btn = h('div')
    box.append(btn)
    try {
      await loadGsi()
      google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: (r: { credential: string }) => api.login({ idToken: r.credential }).then(done, fail),
      })
      google.accounts.id.renderButton(btn, { theme: 'filled_black', size: 'large' })
    } catch (e) {
      fail(e)
    }
  } else {
    const email = h('input', { type: 'email', placeholder: 'email', required: true, autofocus: true })
    const name = h('input', { placeholder: 'name (optional)' })
    box.append(
      h('form', {
        onsubmit: (e: Event) => {
          e.preventDefault()
          api.login({ email: email.value, name: name.value }).then(done, fail)
        },
      }, email, name, h('button', {}, 'Sign in')),
      h('p', { className: 'dim' }, 'Dev mode: no password, any email. Set AUTH_MODE=google for real sign-in.'),
    )
  }
}
