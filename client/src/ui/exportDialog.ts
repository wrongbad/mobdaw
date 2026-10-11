import { saveBlob, safeName } from '../download'
import { encodeWavPlanar, type WavDepth } from '../audio/wav'
import { RenderAborted, type Rendered, type RenderOptions } from '../audio/render'
import { h } from '../dom'

const FORMATS: [label: string, depth: WavDepth][] = [['WAV · 16-bit', 16], ['WAV · 24-bit', 24], ['WAV · 32-bit float', 32]]

/** A modal for rendering the project to a file: pick a name and format, watch the progress, and the download starts when it is done. */
export function exportDialog(opts: { name: string; render(o: RenderOptions): Promise<Rendered> }) {
  const file = h('input', { value: safeName(opts.name), spellcheck: false })
  const format = h('select', {}, ...FORMATS.map(([label, depth], i) => h('option', { value: String(depth), selected: i === 0 }, label)))
  const tail = h('input', { type: 'number', min: 0, max: 60, step: 1, value: '2', title: 'silence added after the last clip, for reverb and delay tails' })
  const bar = h('progress', { max: 1, value: 0, hidden: true })
  const msg = h('p', { className: 'dim' })
  const go = h('button', { onclick: () => void start() }, 'export')
  const cancel = h('button', { onclick: () => dlg.close() }, 'cancel')
  const field = (label: string, el: HTMLElement) => h('label', { className: 'field' }, h('span', { className: 'dim' }, label), el)
  const dlg = h('dialog', { className: 'invite-dialog export-dialog', onclose: () => (abort?.abort(), dlg.remove()) },
    h('p', {}, `export "${opts.name}"`),
    field('file name', file), field('format', format), field('tail (seconds)', tail),
    bar, msg,
    h('div', { className: 'row' }, go, cancel))
  let abort: AbortController | null = null

  async function start() {
    const name = safeName(file.value.trim().replace(/\.wav$/i, ''), 'untitled')
    const depth = Number(format.value) as WavDepth
    const ctl = (abort = new AbortController())
    for (const el of [file, format, tail, go]) el.disabled = true
    bar.hidden = false
    bar.value = 0
    msg.className = 'dim'
    msg.textContent = 'rendering…'
    try {
      const r = await opts.render({ tail: Math.max(0, Math.min(60, Number(tail.value) || 0)), signal: ctl.signal, onProgress: (f) => (bar.value = f) })
      msg.textContent = 'encoding…'
      await new Promise((res) => setTimeout(res)) // let the message paint
      saveBlob(encodeWavPlanar(r.channels, r.rate, depth), `${name}.wav`)
      if (!r.skipped) return dlg.close()
      msg.textContent = `saved; ${r.skipped} audio file${r.skipped > 1 ? 's' : ''} could not be loaded and ${r.skipped > 1 ? 'are' : 'is'} silent in it.`
    } catch (e) {
      if (e instanceof RenderAborted) return
      msg.className = 'error'
      msg.textContent = (e as Error).message
    }
    abort = null
    bar.hidden = true
    for (const el of [file, format, tail, go]) el.disabled = false
    cancel.textContent = 'close'
  }

  document.body.append(dlg)
  dlg.showModal()
  file.select()
}
