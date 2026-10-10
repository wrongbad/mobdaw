import type { ProjectPreview } from '@mobdaw/shared'
import { h } from '../dom'

export type TileAction = { label: string; title?: string; disabled?: boolean; danger?: boolean; onclick: () => void }

const SVG = 'http://www.w3.org/2000/svg'
const svg = (tag: string, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

/** One bar per clip, one row per track, scaled to the project's length. Cheap to draw and says "what kind of piece is this". */
function previewSvg(p: ProjectPreview) {
  const rowH = 5, gap = 3
  const rows = p.rows.length
  const root = svg('svg', { viewBox: `0 0 100 ${Math.max(1, rows * (rowH + gap) - gap)}`, preserveAspectRatio: 'none', class: 'preview' })
  p.rows.forEach((row, i) => {
    for (const [a, b] of row.spans)
      root.append(svg('rect', { x: a * 100, y: i * (rowH + gap), width: Math.max(0.8, (b - a) * 100), height: rowH, class: `clip ${row.kind}` }))
  })
  return root
}

/**
 * A project in the list: a big link (picture, name, details) with its actions in a drop-down.
 * `preview` is loaded lazily and failures just leave the tile blank.
 */
export function projectTile(o: {
  href: string
  name: string
  details: (Node | string)[]
  preview: () => Promise<ProjectPreview>
  actions: TileAction[]
  extra?: Node[]
}): HTMLElement {
  const picture = h('div', { className: 'picture' })
  o.preview().then((p) => {
    if (p.rows.length) picture.replaceChildren(previewSvg(p))
    else picture.append(h('span', { className: 'dim small' }, 'empty'))
  }, () => {})
  const menu = h('details', { className: 'menu tile-menu' },
    h('summary', { title: 'actions' }, '⋯'),
    h('div', {},
      ...o.actions.map((a) =>
        h('button', { className: a.danger ? 'link danger' : 'link', title: a.title, disabled: a.disabled, onclick: a.onclick }, a.label)),
      ...(o.extra ?? [])))
  return h('li', { className: 'tile' },
    h('a', { href: o.href, className: 'tile-link' },
      picture,
      h('strong', {}, o.name),
      h('span', { className: 'dim small' }, ...o.details)),
    menu)
}
