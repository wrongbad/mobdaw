import { api } from '../api'
import { h, mount } from '../dom'
import { homeLink } from '../router'

export const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: 'wrong username or password.',
  too_many_attempts: 'too many failed attempts. try again in a few minutes.',
  bad_username: 'usernames are 3-32 characters: letters, digits, _ . -',
  bad_password: 'passwords must be 8-200 characters.',
  username_taken: 'that username is taken.',
  invite_invalid: 'that invite code is not valid.',
  invite_used: 'that invite has already been used.',
  invite_expired: 'that invite has expired.',
}
export const authMessage = (e: unknown) => AUTH_MESSAGES[(e as Error).message] ?? (e as Error).message

/** Renders the login form. `done` is called after a successful login. */
export function loginPage(done: () => void) {
  const err = h('p', { className: 'error' })
  const username = h('input', { placeholder: 'username', required: true, autofocus: true, autocomplete: 'username' })
  const password = h('input', { type: 'password', placeholder: 'password', required: true, autocomplete: 'current-password' })
  mount(h('main', { className: 'center' },
    h('div', { className: 'card' },
      h('h1', { className: 'logo' }, 'mobdaw'),
      h('form', {
        onsubmit: (e: Event) => {
          e.preventDefault()
          err.textContent = ''
          api.login({ username: username.value, password: password.value }).then(done, (x) => (err.textContent = authMessage(x)))
        },
      }, username, password, h('button', {}, 'log in')),
      err,
      h('p', { className: 'dim' }, 'invite only for now. have a code? ', h('a', { href: '#/register' }, 'register')),
      h('p', { className: 'dim' }, h('a', homeLink, 'continue without an account'), ' to work locally.'))))
}
