import type { Me, UploadInfo } from '@mobdaw/shared'
import { api } from '../api'
import { h, mount } from '../dom'
import { saveBlob, safeName } from '../download'
import { describeError } from '../errors'
import { peaksFromBase64, analyzeAudio, peaksToBase64 } from '../audio/probe'
import { bytes, describeAudio } from '../format'
import { nav } from '../ui/nav'

/** Bigger files are not downloaded just to be measured. */
const MEASURE_MAX_BYTES = 500 * 1024 * 1024

/** "My uploads": every audio file you own, where it is used, and the way to delete it. */
export function uploadsPage(me: Me) {
  const list = h('ul', { className: 'uploads' })
  const err = h('p', { className: 'error' })
  const used = h('p', { className: 'dim' })

  /** Where it is used, for the delete confirmation: the first few project names, then a count. */
  const where = (u: UploadInfo) => {
    const shown = u.projects.slice(0, 3).map((p) => `"${p.name}"`)
    const more = u.projects.length - shown.length + u.otherProjects
    if (more > 0) shown.push(`${more} other project${more === 1 ? '' : 's'}`)
    return shown.length ? shown.join(', ') : null
  }

  async function download(u: UploadInfo) {
    err.textContent = ''
    try {
      const { url } = await api.uploadFileUrl(u.hash)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`http ${res.status}`)
      saveBlob(await res.blob(), safeName(u.name, u.hash.slice(0, 12)))
    } catch (e) {
      err.textContent = describeError(e)
    }
  }

  function remove(u: UploadInfo) {
    const label = u.name || u.hash.slice(0, 12)
    const used = where(u)
    const msg = used
      ? `delete "${label}"? it will be removed from ${used}, for everyone, and cannot be undone.`
      : `delete "${label}"? this cannot be undone.`
    if (!confirm(msg)) return
    api.deleteUpload(u.hash).then(() => ((err.textContent = ''), render()), (e) => (err.textContent = describeError(e)))
  }

  const SVG = 'http://www.w3.org/2000/svg'

  /** Bars mirrored about the centre line, one per stored column; scales to the width of the tile. */
  function wave(peaks: Uint8Array) {
    const root = document.createElementNS(SVG, 'svg')
    root.setAttribute('viewBox', `0 0 ${peaks.length} 100`)
    root.setAttribute('preserveAspectRatio', 'none')
    root.setAttribute('class', 'up-wave')
    peaks.forEach((p, i) => {
      const half = Math.max(0.5, (p / 255) * 46)
      const r = document.createElementNS(SVG, 'rect')
      r.setAttribute('x', String(i + 0.1))
      r.setAttribute('y', String(50 - half))
      r.setAttribute('width', '0.8')
      r.setAttribute('height', String(half * 2))
      root.append(r)
    })
    return root
  }

  type Row = { u: UploadInfo; slot: HTMLElement; specs: HTMLElement; audio: string }

  /** The one wide line under the tile: what the file is and how big. */
  function paint(r: Row, status = '') {
    r.specs.textContent = [status || r.audio, bytes(r.u.size)].filter(Boolean).join(' · ')
  }

  /** Fill a row's picture and format from a stored analysis. */
  function show(r: Row, a: NonNullable<UploadInfo['analysis']>) {
    const peaks = a.peaks ? peaksFromBase64(a.peaks) : new Uint8Array(0)
    r.slot.replaceChildren(...(peaks.length ? [wave(peaks)] : []))
    r.audio = describeAudio(a.info)
    paint(r)
  }

  /** Files uploaded before measuring existed: measure them here, one at a time, and cache the result on the server. */
  async function measure(rows: Row[], token: number) {
    for (const r of rows) {
      if (token !== generation) return
      if (r.u.size > MEASURE_MAX_BYTES) continue
      paint(r, 'measuring…')
      try {
        const { url } = await api.uploadFileUrl(r.u.hash)
        const res = await fetch(url)
        if (!res.ok) throw new Error(`http ${res.status}`)
        const a = await analyzeAudio(await res.blob())
        const analysis = { info: a.info, peaks: peaksToBase64(a.peaks) }
        await api.saveAnalysis(r.u.hash, analysis)
        show(r, analysis)
      } catch {
        paint(r)
      }
    }
  }

  let generation = 0
  const pending: Row[] = []

  function row(u: UploadInfo) {
    const r: Row = { u, slot: h('div', { className: 'up-slot' }), specs: h('div', { className: 'dim small' }), audio: '' }
    if (u.analysis) show(r, u.analysis)
    else (paint(r), pending.push(r))
    const menu = h('details', { className: 'menu up-menu' },
      h('summary', { title: 'actions' }, '⋯'),
      h('div', {},
        h('button', { className: 'link', onclick: () => download(u) }, 'download'),
        h('button', { className: 'link danger', onclick: () => remove(u) }, 'Delete')))
    return h('li', { className: 'upload' },
      h('div', { className: 'up-tile' }, r.slot, h('strong', { className: 'up-name' }, u.name || u.hash.slice(0, 12)), menu),
      r.specs)
  }

  async function render() {
    const [uploads, current] = await Promise.all([api.uploads(), api.me()])
    used.textContent = `${bytes(current.bytesUsed)} of ${bytes(current.quotaBytes)} used.`
    generation++
    pending.length = 0
    list.replaceChildren(...(uploads.length ? uploads.map(row) : [h('li', { className: 'dim' }, 'you have not uploaded any audio.')]))
    void measure([...pending], generation)
  }

  mount(nav(me), h('main', {}, h('h2', {}, 'your uploads'), used, err, list))
  render().catch((e) => (err.textContent = describeError(e)))
}
