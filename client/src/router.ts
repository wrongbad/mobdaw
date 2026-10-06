export type Route = { path: string; params: string[] }
export type Handler = (params: string[]) => void | (() => void)

const routes: [RegExp, Handler][] = []
let cleanup: void | (() => void)

export const route = (re: RegExp, h: Handler) => routes.push([re, h])
export const go = (path: string) => (location.hash = '#' + path)

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
