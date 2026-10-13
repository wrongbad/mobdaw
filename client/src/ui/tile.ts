import { getTracks, projectPreview, trackColor, TRACK_COLORS, type ProjectPreview } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import { icon, type IconName } from '../theme/icons'
import { popover } from './popover'

export type TileAction = { label: string; title?: string; disabled?: boolean; danger?: boolean; icon?: IconName; onclick: () => void }

/** One row of a project picture: a track's colour and its clips as fractions of the project's length. */
export type PictureRow = { color: string; spans: [start: number, end: number][] }

/** A project's picture rows from its document, in the tracks' own colours. */
export function docPicture(doc: Y.Doc): PictureRow[] {
  const tracks = getTracks(doc)
  return projectPreview(doc).rows.map((r, i) => ({ color: tracks[i] ? trackColor(tracks[i], i) : TRACK_COLORS[i % 8], spans: r.spans }))
}

/** Picture rows from a server preview (no colours there: tracks take the palette in order). */
export const previewRows = (p: ProjectPreview): PictureRow[] => p.rows.map((r, i) => ({ color: TRACK_COLORS[i % TRACK_COLORS.length], spans: r.spans }))

/**
 * The little arrangement of a project: a lane per track, a block per clip, in the track colour. Says "what kind of
 * piece is this" at a glance, and matches what the studio shows.
 */
export function picture(rows: PictureRow[], cls = ''): HTMLElement {
  const el = h('div', { className: `pic${cls ? ' ' + cls : ''}` })
  el.style.setProperty('--rows', String(Math.max(rows.length, 3)))
  if (!rows.length) el.classList.add('empty')
  for (const r of rows) {
    const lane = h('div', { className: 'pic-lane' })
    lane.style.setProperty('--c', r.color)
    for (const [a, b] of r.spans) {
      const c = h('i', {})
      c.style.left = `${a * 100}%`
      c.style.width = `max(2px, ${(b - a) * 100}%)`
      lane.append(c)
    }
    el.append(lane)
  }
  return el
}

/** The tile that starts a new project, shown first in a list (cloud projects). */
export function newProjectTile(onclick: () => void, o: { title: string; disabled?: boolean }): HTMLElement {
  return h('li', { className: 'tile tile-new' },
    h('button', { title: o.title, disabled: o.disabled, onclick }, icon('plus', 20), h('span', {}, 'new project')))
}

/**
 * A project in a list: a big link (picture, name, details) with its actions behind a ⋯ button.
 * `preview` is loaded lazily and failures just leave the picture blank.
 */
export function projectTile(o: {
  href: string
  name: string
  details: (Node | string)[]
  preview: () => Promise<ProjectPreview | PictureRow[]>
  actions: TileAction[]
  extra?: Node[]
}): HTMLElement {
  const pic = h('div', { className: 'pic loading' })
  o.preview().then((p) => {
    const rows = Array.isArray(p) ? p : previewRows(p)
    pic.replaceWith(picture(rows))
  }, () => pic.classList.remove('loading'))
  const name = h('strong', { className: 'tile-name' }, o.name)
  const more = h('button', { className: 'icon-btn tile-more', title: 'project actions', 'aria-label': `actions for ${o.name}`, 'aria-haspopup': 'menu' }, icon('more'))
  more.onclick = (e) => {
    e.preventDefault()
    popover(more, o.actions.flatMap((a, i) => [
      ...(a.danger && i > 0 ? ['sep' as const] : []),
      { label: a.label, run: a.onclick, icon: a.icon, danger: a.danger, disabled: a.disabled, title: a.title },
    ]))
  }
  return h('li', { className: 'tile' },
    h('a', { href: o.href, className: 'tile-link' },
      pic,
      h('span', { className: 'tile-meta' }, name, h('span', { className: 'tile-sub' }, ...o.details))),
    o.actions.length ? more : null,
    o.extra?.length ? h('div', { className: 'tile-extra' }, ...o.extra) : null)
}

/** Edit a tile's name in place: Enter or leaving the field saves, Escape cancels. */
export function renameInPlace(tile: HTMLElement, current: string, commit: (name: string) => void) {
  const nameEl = tile.querySelector<HTMLElement>('.tile-name')
  if (!nameEl) return
  const input = h('input', { className: 'tile-rename', value: current, spellcheck: false, 'aria-label': 'project name' })
  let done = false
  const finish = (save: boolean) => {
    if (done) return
    done = true
    const n = input.value.trim()
    input.replaceWith(nameEl)
    if (save && n && n !== current) (nameEl.textContent = n), commit(n)
  }
  input.onkeydown = (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') finish(true)
    if (e.key === 'Escape') finish(false)
  }
  input.onblur = () => finish(true)
  // a click in the field must not follow the tile's link
  input.onclick = (e) => e.preventDefault()
  nameEl.replaceWith(input)
  input.focus()
  input.select()
}
