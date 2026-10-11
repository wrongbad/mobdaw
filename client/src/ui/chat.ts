// Chat sidebar: an SMS-style view of the doc's append-only `chat` array (synced and persisted with the project).
import { addChatMessage, chatLog, deleteChatMessage, type AwarenessState, type ChatMessage } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { h } from '../dom'
import { popover } from './popover'

const SHOWN = 500
const GAP_MS = 5 * 60_000 // a new name/time line after this much silence
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export type ChatDeps = {
  doc: Y.Doc
  user: AwarenessState['user']
  readOnly: boolean
  /** Messages that arrived while the panel was closed. */
  onUnread(n: number): void
}

export function chatPanel({ doc, user, readOnly, onUnread }: ChatDeps) {
  const log = chatLog(doc)
  let open = false
  let seen = 0

  const list = h('div', { className: 'chat-log' })
  const input = h('input', { type: 'text', placeholder: readOnly ? 'view only' : 'message', maxLength: 2000, disabled: readOnly })
  const send = h('button', { title: 'send', disabled: readOnly }, '↑')
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

  function render() {
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    const msgs = log.toArray().slice(-SHOWN)
    let prev: ChatMessage | undefined
    list.replaceChildren(...msgs.flatMap((m) => {
      const me = m.username === user.username
      const side = me ? 'me' : 'them'
      const out: HTMLElement[] = []
      if (!prev || prev.username !== m.username || m.ts - prev.ts > GAP_MS)
        out.push(h('div', { className: `msg-meta ${side}` }, me ? clock(m.ts) : `${m.username} · ${clock(m.ts)}`))
      const b = h('div', { className: `msg ${side}` }, m.text)
      if (!me) b.style.boxShadow = `inset 2px 0 0 ${m.color}`
      else if (!readOnly) b.oncontextmenu = (e) => { // own messages only: the server can't tell who wrote what
        e.preventDefault()
        popover(b, [['delete message', () => deleteChatMessage(doc, m.id)]], [e.clientX, e.clientY])
      }
      out.push(b)
      prev = m
      return out
    }))
    if (atEnd) list.scrollTop = list.scrollHeight
    if (open) seen = log.length
    onUnread(open ? 0 : Math.max(0, log.length - seen))
  }
  log.observe(render)
  render()

  return {
    el,
    get open() { return open },
    setOpen(o: boolean) {
      open = o
      el.hidden = !o
      render()
      if (o) { list.scrollTop = list.scrollHeight; if (!readOnly) input.focus() }
    },
    /** Treat everything already in the log as read (history loaded on sync). */
    markSeen() { seen = log.length; onUnread(0) },
    destroy() { log.unobserve(render) },
  }
}
