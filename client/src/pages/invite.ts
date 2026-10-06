import type { Me } from '@mobdaw/shared'
import { api, ApiError } from '../api'
import { go } from '../router'
import { h, mount } from '../dom'
import { loginPage } from './login'

const MESSAGES: Record<string, string> = {
  invite_used: 'This invite has already been used.',
  invite_expired: 'This invite has expired.',
  not_found: 'This invite does not exist.',
}

export async function invitePage(token: string, getMe: () => Promise<Me | null>) {
  const redeem = async () => {
    try {
      await api.redeem(token)
      go('/projects')
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'error'
      mount(h('main', { className: 'center' }, h('p', { className: 'error' }, MESSAGES[code] ?? code)))
    }
  }
  if (await getMe()) redeem()
  else loginPage(redeem)
}
