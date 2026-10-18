import type { Me } from '@mobdaw/shared'
import { h, mount } from '../dom'
import { icon } from '../theme/icons'
import { nav } from '../ui/nav'
import { aboutColumn } from './about'
import { localSection } from './local'
import { cloudSection } from './projects'
import { startSection } from './start'
import './home.css'

/** Where the page was scrolled when home was last left (this page load only). */
let savedY = 0

/** Scroll back to `y` once the (possibly still loading) content is tall enough, until the user scrolls or a few seconds pass. */
function restoreScroll(y: number, el: HTMLElement) {
  if (y <= 0) return () => {}
  const stop = () => (ro.disconnect(), clearTimeout(timer), removeEventListener('wheel', stop), removeEventListener('touchstart', stop), removeEventListener('keydown', stop))
  const tryNow = () => scrollTo(0, y) // keeps re-pinning while content grows (scroll anchoring would otherwise drift it)
  const ro = new ResizeObserver(tryNow)
  const timer = setTimeout(stop, 2500)
  for (const t of ['wheel', 'touchstart', 'keydown']) addEventListener(t, stop, { once: true, passive: true })
  ro.observe(el)
  tryNow()
  return stop
}

/**
 * Home: the studio launcher. The wordmark, a row of ways to start (templates and the demo song), then the projects on
 * this device. Below: the account's cloud projects (or a sign-in pitch), and an about column.
 */
export function homePage(me: Me | null): () => void {
  const intro = h('header', { className: 'home-intro' },
    h('h1', { className: 'logo home-mark' }, 'mobdaw'),
    h('p', { className: 'home-lede' },
      h('span', {}, 'A multitrack studio in a browser tab.'),
      h('span', { className: 'dim' }, ' Record, loop, sequence, automate and mix. Nothing to install, and your projects stay on this device.')))
  const main = h('main', { className: 'home-main' }, intro, startSection(), localSection(me))
  main.append(me ? cloudSection(me) : cloudPitch())
  const top = nav(me)
  const about = aboutColumn()
  // The big wordmark below is the brand here; the bar's spot for it shows / hides the about column instead.
  top.querySelector('.logo')!.replaceWith(h('button', { className: 'nav-link', 'aria-controls': 'about', onclick: () => about.toggle() }, icon('help'), 'about'))
  about.el.id = 'about'
  mount(top, h('div', { className: 'home with-about' }, about.el, main))
  // Coming back (Back button or the logo) returns to where the page was left, not the top.
  history.scrollRestoration = 'manual' // the list loads late; the browser's own restore would land short
  const stop = restoreScroll(savedY, main)
  return () => {
    stop()
    savedY = scrollY
    history.scrollRestoration = 'auto'
  }
}

/** What the cloud section offers, shown in place of it when signed out. */
function cloudPitch(): HTMLElement {
  return h('section', { className: 'home-sec' },
    h('div', { className: 'sec-head' }, h('h2', {}, 'Cloud')),
    h('p', { className: 'dim' }, 'Cloud storage and real-time editing with others are part of mobdaw pro. ',
      h('a', { href: '#/login' }, 'Sign in'), ' or ', h('a', { href: '#/register' }, 'create a free account'), '.'))
}
