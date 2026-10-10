import { api } from '../api'
import { h, mount } from '../dom'

export const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Wrong username or password.',
  too_many_attempts: 'Too many failed attempts. Try again in a few minutes.',
  bad_username: 'Usernames are 3-32 characters: letters, digits, _ . -',
  bad_password: 'Passwords must be 8-200 characters.',
  username_taken: 'That username is taken.',
  invite_invalid: 'That invite code is not valid.',
  invite_used: 'That invite has already been used.',
  invite_expired: 'That invite has expired.',
}
export const authMessage = (e: unknown) => AUTH_MESSAGES[(e as Error).message] ?? (e as Error).message

/** Renders the login form. `done` is called after a successful login. */
export function loginPage(done: () => void) {
  const err = h('p', { className: 'error' })
  const username = h('input', { placeholder: 'username', required: true, autofocus: true, autocomplete: 'username' })
  const password = h('input', { type: 'password', placeholder: 'password', required: true, autocomplete: 'current-password' })
  mount(h('main', { className: 'center' },
    h('div', { className: 'card' },
      h('h1', {}, 'mobdaw'),
      h('form', {
        onsubmit: (e: Event) => {
          e.preventDefault()
          err.textContent = ''
          api.login({ username: username.value, password: password.value }).then(done, (x) => (err.textContent = authMessage(x)))
        },
      }, username, password, h('button', {}, 'Log in')),
      err,
      h('p', { className: 'dim' }, 'Invite only for now. Have a code? ', h('a', { href: '#/register' }, 'Register')),
      h('p', { className: 'dim' }, h('a', { href: '#/local' }, 'Continue without an account'), ' to work on this device.'))))
}
