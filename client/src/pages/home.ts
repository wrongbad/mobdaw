import type { Me } from '@mobdaw/shared'
import { h, mount } from '../dom'
import { nav } from '../ui/nav'
import { localSection } from './local'
import { cloudSection } from './projects'

/** Home: projects on this device and (when signed in) in the cloud, each in a collapsible section. */
export function homePage(me: Me | null) {
  mount(nav(me), h('main', { className: 'wide' }, localSection(me), me ? cloudSection(me) : null))
}
