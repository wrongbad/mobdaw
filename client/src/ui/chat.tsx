// Chat sidebar: an SMS-style view of the doc's append-only `chat` array (synced and persisted with the project).
import { SYSTEM_USER, addChatMessage, chatLog, deleteChatMessage, type AwarenessState, type ChatMessage } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { For, Show, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { h } from '../dom'
import { popover } from './popover'

const SHOWN = 500
const GAP_MS = 5 * 60_000 // a new name/time line after this much silence
/** Messages from the app itself (a migration note, ...): shown as a muted notice, not as a person's bubble. */
export const isSystem = (m: Pick<ChatMessage, 'username' | 'system'>) => !!m.system || m.username === SYSTEM_USER
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export type ChatDeps = {
  doc: Y.Doc
  user: AwarenessState['user']
  /** Messages that arrived while the panel was closed. */
  onUnread(n: number): void
}

export function chatPanel({ doc, user, onUnread }: ChatDeps) {
  const log = chatLog(doc)
  let open = false
  let seen = 0

  const list = h('div', { className: 'chat-log' })
  const input = h('input', { type: 'text', placeholder: 'message', maxLength: 2000 })
  const send = h('button', { title: 'send' }, '↑')
  const submit = () => {
    if (addChatMessage(doc, user, input.value)) input.value = ''
    list.scrollTop = list.scrollHeight
  }
  send.onclick = submit
  input.onkeydown = (e) => {
    e.stopPropagation() // not a timeline shortcut
    if (e.key === 'Enter') submit()
    else if (e.key === 'Escape') input.blur()
  }
  const el = h('aside', { className: 'chat', hidden: true }, list, h('div', { className: 'chat-in' }, input, send))

  const [msgs, setMsgs] = createSignal<ChatMessage[]>([])
  const Msgs = () => (
    <For each={msgs()}>{(m, i) => isSystem(m) ? <div class="msg-sys" title={clock(m.ts)}>{m.text}</div> : (() => {
      const me = m.username === user.username
      const side = me ? 'me' : 'them'
      const prev = () => msgs()[i() - 1]
      return <>
        <Show when={!prev() || prev()!.username !== m.username || m.ts - prev()!.ts > GAP_MS}>
          <div class={`msg-meta ${side}`}>{me ? clock(m.ts) : `${m.username} · ${clock(m.ts)}`}</div>
        </Show>
        <div
          class={`msg ${side}`}
          style={me ? undefined : { 'box-shadow': `inset 2px 0 0 ${m.color}` }}
          oncontextmenu={me ? (e) => { // own messages only: the server can't tell who wrote what
            e.preventDefault()
            popover(e.currentTarget, [['delete message', () => deleteChatMessage(doc, m.id)]], [e.clientX, e.clientY])
          } : undefined}
        >{m.text}</div>
      </>
    })()}</For>
  )
  const dispose = render(Msgs, list)

  function sync() {
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    setMsgs(log.toArray().slice(-SHOWN)) // (the entries keep their identity, so <For> only adds and removes rows)
    if (atEnd) list.scrollTop = list.scrollHeight
    if (open) seen = log.length
    onUnread(open ? 0 : Math.max(0, log.length - seen))
  }
  log.observe(sync)
  sync()

  return {
    el,
    get open() { return open },
    setOpen(o: boolean) {
      open = o
      el.hidden = !o
      sync()
      if (o) { list.scrollTop = list.scrollHeight; input.focus() }
    },
    /** Treat everything already in the log as read (history loaded on sync). */
    markSeen() { seen = log.length; onUnread(0) },
    destroy() { log.unobserve(sync); dispose() },
  }
}
