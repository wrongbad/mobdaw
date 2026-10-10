export type Route = { path: string; params: string[] }
export type Handler = (params: string[]) => void | (() => void)

const routes: [RegExp, Handler][] = []
let cleanup: void | (() => void)

export const route = (re: RegExp, h: Handler) => routes.push([re, h])

/** Navigate to a hash route. The home page '/' is the bare URL, with no hash at all. */
export function go(path: string, replace = false) {
  if (path !== '/') {
    if (replace) location.replace('#' + path)
    else location.hash = '#' + path
    return
  }
  const url = location.pathname + location.search
  if (replace) history.replaceState(null, '', url)
  else history.pushState(null, '', url)
  dispatchEvent(new HashChangeEvent('hashchange')) // pushState doesn't fire it
}

/** Attributes for a link to the home page: the real URL, but handled in-page. */
export const homeLink = {
  href: location.pathname + location.search,
  onclick: (e: Event) => (e.preventDefault(), go('/')),
}

export function start(fallback: string) {
  const run = () => {
    if (typeof cleanup === 'function') cleanup()
    cleanup = undefined
    const path = location.hash.slice(1) || fallback
    for (const [re, h] of routes) {
      const m = re.exec(path)
      if (m) return void (cleanup = h(m.slice(1).map(decodeURIComponent)))
    }
    go(fallback)
  }
  addEventListener('hashchange', run)
  run()
}
