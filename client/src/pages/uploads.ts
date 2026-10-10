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
  const list = h('ul', { className: 'list' })
  const err = h('p', { className: 'error' })
  const used = h('p', { className: 'dim' })

  const where = (u: UploadInfo) => {
    const names = u.projects.map((p) => `"${p.name}"`)
    if (u.otherProjects) names.push(`${u.otherProjects} other project${u.otherProjects === 1 ? '' : 's'} you can no longer see`)
    return names.length ? names.join(', ') : null
  }

  async function download(u: UploadInfo) {
    err.textContent = ''
    try {
      const { url } = await api.uploadFileUrl(u.hash)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      saveBlob(await res.blob(), safeName(u.name, u.hash.slice(0, 12)))
    } catch (e) {
      err.textContent = describeError(e)
    }
  }

  function remove(u: UploadInfo) {
    const label = u.name || u.hash.slice(0, 12)
    const used = where(u)
    const msg = used
      ? `Delete "${label}"? It will be removed from ${used}, for everyone, and cannot be undone.`
      : `Delete "${label}"? This cannot be undone.`
    if (!confirm(msg)) return
    api.deleteUpload(u.hash).then(() => ((err.textContent = ''), render()), (e) => (err.textContent = describeError(e)))
  }

  /** Bars mirrored about the centre line, one per stored column. */
  function wave(peaks: Uint8Array) {
    const cv = h('canvas', { className: 'wave', width: peaks.length, height: 48 })
    const g = cv.getContext('2d')!
    g.fillStyle = getComputedStyle(cv).color
    peaks.forEach((p, i) => {
      const half = Math.round((p / 255) * 24)
      g.fillRect(i, 24 - half, 1, Math.max(1, half * 2))
    })
    return cv
  }

  /** Fill a row's picture and format line from a stored analysis. */
  function show(slot: HTMLElement, line: HTMLElement, a: NonNullable<UploadInfo['analysis']>) {
    const peaks = a.peaks ? peaksFromBase64(a.peaks) : new Uint8Array(0)
    slot.replaceChildren(...(peaks.length ? [wave(peaks)] : []))
    line.textContent = describeAudio(a.info)
  }

  /** Files uploaded before measuring existed: measure them here, one at a time, and cache the result on the server. */
  async function measure(rows: { u: UploadInfo; slot: HTMLElement; line: HTMLElement }[], token: number) {
    for (const r of rows) {
      if (token !== generation) return
      if (r.u.size > MEASURE_MAX_BYTES) continue
      r.line.textContent = 'measuring…'
      try {
        const { url } = await api.uploadFileUrl(r.u.hash)
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const a = await analyzeAudio(await res.blob())
        const analysis = { info: a.info, peaks: peaksToBase64(a.peaks) }
        await api.saveAnalysis(r.u.hash, analysis)
        show(r.slot, r.line, analysis)
      } catch {
        r.line.textContent = ''
      }
    }
  }

  let generation = 0
  const pending: { u: UploadInfo; slot: HTMLElement; line: HTMLElement }[] = []

  function row(u: UploadInfo) {
    const w = where(u)
    const slot = h('div', { className: 'wave-slot' })
    const line = h('div', { className: 'dim small' })
    if (u.analysis) show(slot, line, u.analysis)
    else pending.push({ u, slot, line })
    return h('li', {},
      slot,
      h('span', { className: 'grow' }, h('div', {}, u.name || u.hash.slice(0, 12)), line,
        h('div', { className: 'dim small' }, `${bytes(u.size)} · ${w ? `used in ${w}` : 'not used in any project'}`)),
      h('button', { onclick: () => download(u) }, 'Download'),
      h('button', { onclick: () => remove(u) }, 'Delete'))
  }

  async function render() {
    const [uploads, current] = await Promise.all([api.uploads(), api.me()])
    used.textContent = `${bytes(current.bytesUsed)} of ${bytes(current.quotaBytes)} used.`
    generation++
    pending.length = 0
    list.replaceChildren(...(uploads.length ? uploads.map(row) : [h('li', { className: 'dim' }, 'You have not uploaded any audio.')]))
    void measure([...pending], generation)
  }

  mount(nav(me), h('main', {}, h('h2', {}, 'Your uploads'), used, err, list))
  render().catch((e) => (err.textContent = describeError(e)))
}
