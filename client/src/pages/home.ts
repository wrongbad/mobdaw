import type { Me } from '@mobdaw/shared'
import { h, mount } from '../dom'
import { nav } from '../ui/nav'
import { localSection } from './local'
import { cloudSection } from './projects'

/** Home: projects on this device and (when signed in) in the cloud, each in a collapsible section. */
export function homePage(me: Me | null) {
  mount(nav(me), h('main', { className: 'wide' }, localSection(me), me ? cloudSection(me) : cloudPitch()))
}

/** What the cloud section offers, shown in place of it when signed out. */
function cloudPitch(): HTMLElement {
  return h('section', { className: 'section' },
    h('h2', {}, 'cloud'),
    h('p', { className: 'dim' }, 'cloud storage and real-time editing with others are part of mobdaw pro.'),
    h('p', { className: 'dim' }, h('a', { href: '#/login' }, 'sign in'), ' or ', h('a', { href: '#/register' }, 'create a free account'), '.'))
}
