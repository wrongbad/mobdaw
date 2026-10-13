import type { ProjectDetail, Role } from '@mobdaw/shared'
import { api } from '../api'
import { getInputOffset, getPreferredInput, setInputOffset, setPreferredInput } from '../audio/recording'
import { holdCapture } from '../audio/context'
import { h } from '../dom'
import { describeError } from '../errors'
import { memberRows } from './members'
import { pedalSettings } from './pedalSettings'
import { popoverPanel } from './popover'

export type ProjectMenuOpts = {
  name: string
  /** Absent when the name can't be changed (viewers, frozen projects). */
  rename?: (name: string) => Promise<unknown> | void
  onRenamed(name: string): void
  /** Absent for projects on this device. */
  cloud?: { projectId: string; me: string; role: Role; owner: boolean; locked: boolean; public: boolean; admin: boolean; demo: boolean; onPublic(v: boolean): void; onDemo(v: boolean): void }
  /** The project's sample rate; `locked` says why it can't change (it is only possible while the project has no tracks). */
  sampleRate: { value: number; locked: 'tracks' | 'readonly' | null; set(rate: number): void }
  /** The microphone choice changed: re-open the input if it is in use. */
  onInputChanged(): void
  /** Absent when the pedal can't be used (viewers). The MIDI input or a binding changed. */
  onPedalChanged?(): void
}

/** The rates a project can use (docs/engine.md §2). */
export const SAMPLE_RATES = [44100, 48000, 88200, 96000]

const section = (title: string, ...rest: (Node | null)[]) =>
  h('section', { className: 'settings-sec' }, h('h3', {}, title), ...rest)
const field = (label: string, el: HTMLElement, inline = false) => h('label', { className: inline ? 'field inline' : 'field' }, h('span', { className: 'dim' }, label), el)

/** The project's settings, in a panel under the name in the bar: name, sharing, collaborators and audio input. */
export function projectMenu(anchor: HTMLElement, o: ProjectMenuOpts) {
  const msg = h('p', { className: 'error' })
  const fail = (e: unknown) => (msg.textContent = describeError(e))

  const name = h('input', { value: o.name, disabled: !o.rename, spellcheck: false })
  name.onkeydown = (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') name.blur()
    if (e.key === 'Escape') (name.value = o.name), name.blur()
  }
  name.onchange = () => {
    const n = name.value.trim()
    if (!n || n === o.name || !o.rename) return void (name.value = o.name)
    Promise.resolve(o.rename(n)).then(() => ((o.name = n), (msg.textContent = ''), o.onRenamed(n)), (e) => ((name.value = o.name), fail(e)))
  }

  let sharing: Node | null = null
  const c = o.cloud
  if (c) {
    const pub = h('input', { type: 'checkbox', checked: c.public, disabled: !c.owner || c.locked })
    const link = h('button', { hidden: !c.public, title: 'copy the address of this project', onclick: () => void navigator.clipboard?.writeText(location.href) }, 'copy link')
    const demo = h('input', { type: 'checkbox', checked: c.demo, disabled: !c.public || c.locked })
    const demoRow = h('label', { className: 'check', hidden: !c.admin || !c.owner, title: 'list this project in the demo section of everyone\'s home page' }, demo, h('span', {}, 'demo: show on the home page'))
    pub.onchange = () => {
      const v = pub.checked
      api.setProjectPublic(c.projectId, v).then(() => {
        c.public = v
        if (!v) (c.demo = false), (demo.checked = false), c.onDemo(false) // the server drops the demo flag with it
        demo.disabled = !v || c.locked
        link.hidden = !v
        msg.textContent = ''
        c.onPublic(v)
      }, (e) => ((pub.checked = !v), fail(e)))
    }
    demo.onchange = () => {
      const v = demo.checked
      api.setProjectDemo(c.projectId, v).then(() => ((c.demo = v), (msg.textContent = ''), c.onDemo(v)), (e) => ((demo.checked = !v), fail(e)))
    }
    const who = !c.me ? 'you are viewing without an account' : { owner: 'you are the owner', editor: 'you are a collaborator', viewer: 'you are a viewer' }[c.role]
    const people = h('div', { className: 'members', hidden: true })
    const toggle = h('button', { onclick: () => {
      people.hidden = !people.hidden
      toggle.textContent = people.hidden ? 'collaborators…' : 'collaborators ▴'
      if (!people.hidden) void loadMembers(people, c, fail)
    } }, 'collaborators…')
    sharing = section('sharing',
      h('p', { className: 'dim who' }, who),
      h('label', { className: 'check', title: 'anyone signed in who has the link can open it, read-only' }, pub, h('span', {}, 'public: anyone with the link can view')),
      demoRow,
      h('div', { className: 'row' }, link, toggle), people)
  }

  // Microphone: the choice is remembered in this browser. Names only show once the page has been given microphone access.
  const mic = h('select', {})
  const offset = h('input', { type: 'number', step: 1, title: 'extra input delay for this microphone, in ms: positive if takes land late, negative if early' })
  const offsetField = field('input delay (ms)', offset)
  const grant = h('button', { hidden: true, onclick: () => void ask() }, 'allow microphone access')
  const note = h('p', { className: 'dim', hidden: true })
  let denied = false
  async function listMics() {
    denied = (await navigator.permissions?.query?.({ name: 'microphone' as PermissionName }).catch(() => null))?.state === 'denied'
    const devs = ((await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? []).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    const want = getPreferredInput()
    // Browsers hide device labels until the page has microphone access, so no labels means no access yet.
    const access = devs.some((d) => d.label)
    mic.disabled = !access
    if (!access) {
      mic.replaceChildren(h('option', { value: '' }, 'no microphone available'))
      note.textContent = denied ? 'microphone access is blocked: allow it in the browser settings for this site, then reload.' : 'allow access to choose a microphone.'
      note.className = denied ? 'error' : 'dim'
    } else {
      mic.replaceChildren(h('option', { value: '' }, 'system default'),
        ...devs.map((d, i) => h('option', { value: d.deviceId }, d.label || `microphone ${i + 1}`)))
      if (want && !devs.some((d) => d.deviceId === want)) mic.append(h('option', { value: want }, 'unavailable (using the default)'))
      mic.value = want
    }
    note.hidden = access
    grant.hidden = access || denied
    syncOffset()
  }
  async function ask() {
    const release = holdCapture()
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
    } catch (e) {
      fail(e)
    }
    release()
    void listMics()
  }
  const syncOffset = () => {
    offsetField.hidden = !mic.value || mic.disabled
    if (mic.value) offset.value = String(getInputOffset(mic.value))
  }
  mic.onchange = () => {
    setPreferredInput(mic.value)
    syncOffset()
    o.onInputChanged()
  }
  offset.onchange = () => mic.value && Number.isFinite(Number(offset.value)) && setInputOffset(mic.value, Number(offset.value))
  const sr = o.sampleRate
  const rate = h('select', { disabled: !!sr.locked, title: sr.locked === 'tracks'
    ? 'the sample rate can only be changed in an empty project (one without any tracks or automation)'
    : sr.locked === 'readonly' ? 'you cannot change this project' : 'the project is recorded, played and exported at this rate; it cannot be changed once there are tracks' },
  ...SAMPLE_RATES.map((r) => h('option', { value: String(r) }, `${+(r / 1000).toFixed(1)} kHz`)))
  rate.value = String(sr.value)
  rate.onchange = () => sr.set(Number(rate.value))
  const audio = section('audio', field('sample rate', rate), field('microphone', mic), note, grant, offsetField)
  void listMics()

  const pedal = o.onPedalChanged && section('foot pedal', pedalSettings(o.onPedalChanged))
  const panel = h('div', { className: 'settings' }, section('project', field('name', name, true)), sharing, audio, pedal, msg)
  popoverPanel(anchor, panel)
}

/** The collaborators of a cloud project, as on the home screen: change roles, remove, share with someone else. */
function loadMembers(body: HTMLElement, c: NonNullable<ProjectMenuOpts['cloud']>, fail: (e: unknown) => void) {
  const show = (d: ProjectDetail, usernames: string[]) => {
    const others = d.members.filter((m) => m.role !== 'owner')
    const act = (fn: () => Promise<unknown>) => fn().then(() => load(), fail)
    body.replaceChildren(
      h('div', { className: 'row' }, h('span', { className: 'grow' }, d.ownerUsername), h('span', { className: 'dim' }, 'owner')),
      ...(c.owner
        ? memberRows({ projectId: c.projectId, members: d.members, usernames, me: c.me, locked: c.locked, act })
        : others.map((m) => h('div', { className: 'row' }, h('span', { className: 'grow' }, m.username), h('span', { className: 'dim' }, m.role)))))
  }
  const load = () =>
    Promise.all([api.project(c.projectId), c.owner ? api.users() : Promise.resolve([])]).then(
      ([d, users]) => show(d, users.map((u) => u.username)), fail)
  return load()
}
