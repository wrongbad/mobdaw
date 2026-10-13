// "Start something": the new-project templates and the demo song, each drawn as the arrangement it builds.
import * as Y from 'yjs'
import { getClips } from '@mobdaw/shared'
import { h } from '../dom'
import { describeError } from '../errors'
import { createLocal, removeLocal } from '../local/projects'
import { writeLocalState } from '../local/session'
import { silliName } from '../projectName'
import { icon } from '../theme/icons'
import { docPicture, picture, type PictureRow } from '../ui/tile'
import type { Template } from '../content/templates'

/** Make a local project from a template and open it. */
export async function createFromTemplate(t: Template, name = silliName()) {
  const doc = new Y.Doc()
  t.build(doc)
  const p = createLocal(name)
  try {
    await writeLocalState(p.id, Y.encodeStateAsUpdate(doc))
  } catch (e) {
    await removeLocal(p.id)
    throw e
  } finally {
    doc.destroy()
  }
  location.hash = `#/local/${p.id}`
}

/** Names as the home page shows them (the template ids stay). */
const SHOWN: Record<string, string> = { empty: 'Blank' }

/** `bpm` is the first MIDI clip's tempo (tempo lives on MIDI clips; a project has none of its own). */
type Built = { rows: PictureRow[]; bpm: number | null; tracks: number }

/** Build a template into a scratch doc just to draw it (and read its tempo, if it has MIDI). */
function sketch(t: Template): Built {
  const doc = new Y.Doc()
  try {
    t.build(doc)
    const rows = docPicture(doc)
    const midi = getClips(doc).find((c) => c.kind === 'midi')
    return { rows, bpm: midi && midi.kind === 'midi' ? Math.round(midi.bpm) : null, tracks: rows.length }
  } catch {
    return { rows: [], bpm: null, tracks: 0 }
  } finally {
    doc.destroy()
  }
}

export function startSection(): HTMLElement {
  const err = h('p', { className: 'error', role: 'alert' })
  const grid = h('div', { className: 'start-grid' })
  const section = h('section', { className: 'home-sec start', 'aria-labelledby': 'start-h' },
    h('div', { className: 'sec-head' }, h('h2', { id: 'start-h' }, 'Start something')),
    grid, err)

  let busy = false
  const card = (t: Template, demoName?: string) => {
    const b = sketch(t)
    const isDemo = t.id === 'demo'
    const facts = h('span', { className: 'start-facts' },
      b.bpm ? h('span', {}, `${b.bpm} bpm`) : null, h('span', {}, b.tracks === 1 ? '1 track' : `${b.tracks} tracks`))
    const el = h('button', { className: `start-card${isDemo ? ' demo' : ''}`, type: 'button' },
      picture(b.rows, isDemo ? 'lg' : ''),
      h('span', { className: 'start-text' },
        h('span', { className: 'start-name' }, isDemo ? (demoName ?? t.name) : SHOWN[t.id] ?? t.name, isDemo ? h('span', { className: 'start-tag' }, 'demo song') : null),
        h('span', { className: 'start-blurb' }, t.blurb),
        facts),
      h('span', { className: 'start-go' }, icon(isDemo ? 'play' : 'plus'), isDemo ? 'open the demo' : 'new project'))
    el.onclick = async () => {
      if (busy) return
      busy = true
      err.textContent = ''
      el.classList.add('busy')
      el.querySelector('.start-go')!.lastChild!.textContent = 'setting up…'
      try {
        await createFromTemplate(t, isDemo ? (demoName ?? t.name) : undefined)
      } catch (e) {
        err.textContent = describeError(e)
        el.classList.remove('busy')
        busy = false
      }
    }
    return el
  }

  // The templates come from the content module; load it on its own so a problem there never blanks the home page.
  Promise.all([import('../content/templates'), import('../content/demo').catch(() => null)]).then(([{ TEMPLATES }, demo]) => {
    const demoT = TEMPLATES.find((t) => t.id === 'demo')
    const rest = TEMPLATES.filter((t) => t !== demoT)
    grid.replaceChildren(...(demoT ? [card(demoT, demo?.DEMO_NAME)] : []), ...rest.map((t) => card(t)))
  }, (e) => (err.textContent = `templates could not be loaded: ${describeError(e)}`))
  return section
}
