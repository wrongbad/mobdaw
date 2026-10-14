// The loop commands' section of the project settings: which MIDI input, and the key and foot switch of each command.
import { CMDS, CMD_LABELS, type Cmd } from '../audio/loopPedal'
import { DEFAULT_KEYS, describeTrigger, getBindings, getKeys, getMidiInput, keyAllowed, learn, listMidiInputs, midiSupported, onMidiDevices, setBinding, setKey, setMidiInput } from '../midi'
import { h } from '../dom'

const LEARN_MS = 15000
const showKey = (k: string) => (k === '' ? 'none' : k === ' ' ? 'space' : k)

/** `onChanged` runs whenever the input or a binding changes (the commands re-read their bindings). */
export function loopSettings(onChanged: () => void): HTMLElement {
  const msg = h('p', { className: 'error' })
  const input = h('select', {})
  const find = h('button', { onclick: () => void list() }, 'find MIDI inputs…')
  const rows = h('div', {})
  let cancel = () => {}
  const hasMidi = midiSupported()

  async function list() {
    try {
      const ins = await listMidiInputs()
      const want = getMidiInput()
      input.replaceChildren(h('option', { value: '' }, 'none'), ...ins.map((i) => h('option', { value: i.id }, i.name)))
      if (want && !ins.some((i) => i.id === want)) input.append(h('option', { value: want }, 'unavailable'))
      input.value = want
      input.hidden = false
      find.hidden = true
      msg.textContent = ''
    } catch (e) {
      msg.textContent = (e as Error).message
    }
  }
  input.hidden = true
  input.onchange = () => (setMidiInput(input.value), onChanged())
  if (hasMidi) {
    const off = onMidiDevices(() => (input.isConnected ? void list() : off()))
    if (getMidiInput()) void list() // (access was granted before: no prompt)
  }

  function learnKey(c: Cmd, state: HTMLElement) {
    cancel()
    state.textContent = 'press a key…'
    const done = (e: KeyboardEvent | null) => {
      removeEventListener('keydown', onKey, true)
      clearTimeout(timer)
      cancel = () => {}
      if (e && keyAllowed(e.key)) (setKey(c, e.key.length === 1 ? e.key.toLowerCase() : e.key), onChanged())
      else if (e) msg.textContent = `${showKey(e.key)} is used by the studio`
      draw()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return
      e.preventDefault()
      e.stopPropagation()
      done(e.key === 'Escape' ? null : e)
    }
    const timer = setTimeout(() => done(null), LEARN_MS)
    cancel = () => done(null)
    addEventListener('keydown', onKey, true)
  }

  function learnMidi(c: Cmd, state: HTMLElement) {
    cancel()
    if (!getMidiInput()) return void (msg.textContent = 'choose a MIDI input first')
    const l = learn(getMidiInput())
    const timer = setTimeout(l.cancel, LEARN_MS)
    cancel = l.cancel
    state.textContent = 'press the switch…'
    l.done.then((tr) => (setBinding(c, tr), onChanged()), () => {}).finally(() => (clearTimeout(timer), draw()))
  }

  function draw() {
    msg.textContent = ''
    const b = getBindings(), k = getKeys()
    rows.replaceChildren(...CMDS.map((c) => {
      const t = b[c]
      const kstate = h('span', { className: 'dim' }, `key ${showKey(k[c])}`)
      const mstate = h('span', { className: 'dim grow' }, t ? describeTrigger(t) : 'no switch')
      const keyBtn = h('button', { title: `the key for ${CMD_LABELS[c]} (default ${DEFAULT_KEYS[c]})`, onclick: () => learnKey(c, kstate) }, 'key')
      const learnBtn = hasMidi ? h('button', { title: 'press a foot switch to bind it', onclick: () => learnMidi(c, mstate) }, t ? 'relearn' : 'learn') : null
      const clear = t ? h('button', { title: 'forget this switch', onclick: () => (setBinding(c, null), onChanged(), draw()) }, '×') : null
      return h('div', { className: 'pedal-row' }, h('span', {}, CMD_LABELS[c]), h('div', { className: 'row' }, kstate, keyBtn, hasMidi ? mstate : null, learnBtn, clear))
    }))
  }
  draw()
  return h('div', {}, hasMidi ? h('label', { className: 'field' }, h('span', { className: 'dim' }, 'MIDI input'), input) : h('p', { className: 'dim' }, 'this browser has no Web MIDI (try Chrome or Firefox): the keys still work.'),
    hasMidi ? find : null, rows,
    h('p', { className: 'dim' }, 'always listening: the record key starts a loop on the current track and the next press ends it. mute is volume automation, so replaying the song replays it.'), msg)
}
