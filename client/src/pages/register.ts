import { api } from '../api'
import { h, mount } from '../dom'
import { authMessage } from './login'

/** Registration form; `invite` (from the `#/register/<code>` link) prefills the invite code. */
export function registerPage(invite: string, done: () => void) {
  const err = h('p', { className: 'error' })
  const code = h('input', { placeholder: 'invite code', required: true, value: invite, autocomplete: 'off' })
  const username = h('input', { placeholder: 'username', required: true, autofocus: !!invite, autocomplete: 'username' })
  const password = h('input', { type: 'password', placeholder: 'password (8+ characters)', required: true, autocomplete: 'new-password' })
  const again = h('input', { type: 'password', placeholder: 'password again', required: true, autocomplete: 'new-password' })
  mount(h('main', { className: 'center' },
    h('div', { className: 'card' },
      h('h1', {}, 'mobdaw'),
      h('p', { className: 'dim' }, 'Invite only for now. Ask the owner for an invite link.'),
      h('form', {
        onsubmit: (e: Event) => {
          e.preventDefault()
          err.textContent = ''
          if (password.value !== again.value) return void (err.textContent = 'Passwords do not match.')
          api.register({ username: username.value, password: password.value, invite: code.value }).then(done, (x) => (err.textContent = authMessage(x)))
        },
      }, code, username, password, again, h('button', {}, 'Register')),
      err,
      h('p', { className: 'dim' }, 'Already have an account? ', h('a', { href: '#/login' }, 'Log in')),
      h('p', { className: 'dim' }, h('a', { href: '#/local' }, 'Continue without an account'), ' to work on this device.'))))
}
