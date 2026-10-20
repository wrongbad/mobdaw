// Chat sidebar: an SMS-style view of the doc's append-only `chat` array (synced and persisted with the project).
import { SYSTEM_USER, addChatMessage, apiName, chatLog, deleteChatMessage, mentionHandle, parseMentions, splitMentions, type AwarenessState, type ChatMessage } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { For, Show, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { h } from '../dom'
import { popover } from './popover'

const SHOWN = 500
const GAP_MS = 5 * 60_000 // a new name/time line after this much silence
/** Messages from the app itself (a migration note, ...): shown as a muted notice, not as a person's bubble. */
export const isSystem = (m: Pick<ChatMessage, 'username' | 'system'>) => !!m.system || m.username === SYSTEM_USER
/** The log without a system message whose id an earlier one already used (clients that migrate at once each post the same notice). */
export const dedupeSystem = (list: ChatMessage[]) => {
  const seen = new Set<string>()
  return list.filter((m) => !isSystem(m) || (!seen.has(m.id) && !!seen.add(m.id)))
}
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export type ChatDeps = {
  doc: Y.Doc
  user: AwarenessState['user']
  /** Messages that arrived while the panel was closed. */
  onUnread(n: number): void
  /** Unread messages that mention you (shown as a separate "@" badge). */
  onMentions?(n: number): void
  /** Display names that can be mentioned right now: project members and who is present (API participants as "name (api)"). */
  names?(): string[]
}

/** The `@query` being typed right before the caret, if any. */
export const mentionQuery = (value: string, caret: number) => {
  const m = /(?:^|[\s(])@([a-z0-9_.()-]*)$/i.exec(value.slice(0, caret))
  return m ? { query: m[1], start: caret - m[1].length - 1 } : null
}

export function chatPanel({ doc, user, onUnread, onMentions, names }: ChatDeps) {
  const log = chatLog(doc)
  let open = false
  let seen = 0
  const myApi = apiName(user.username)
  const candidates = () => [...new Set(names?.() ?? [])].filter((n) => n !== user.username)
  const handles = () => candidates().map(mentionHandle)
  /** Who a message mentions: as stored, or parsed from the text for older messages. */
  const mentionsOf = (m: ChatMessage) => m.mentions ?? parseMentions(m.text, handles())
  const mentionsMe = (m: ChatMessage) => !isSystem(m) && m.username !== user.username && m.username !== myApi && mentionsOf(m).includes(user.username)

  const list = h('div', { className: 'chat-log' })
  const input = h('input', { type: 'text', placeholder: 'message', maxLength: 2000 })
  const send = h('button', { title: 'send' }, '↑')
  const submit = () => {
    if (addChatMessage(doc, user, input.value, handles())) input.value = ''
    closePop()
    list.scrollTop = list.scrollHeight
  }
  send.onclick = submit

  // the autocomplete: typing `@` lists who can be mentioned, filtered as you type
  const pop = h('div', { className: 'mention-pop', hidden: true, role: 'listbox' })
  let options: string[] = []
  let sel = 0
  let tok: { query: string; start: number } | null = null
  const closePop = () => { tok = null; pop.hidden = true; pop.replaceChildren() }
  const choose = (name: string) => {
    if (!tok) return
    const caret = input.selectionStart ?? input.value.length
    const ins = `${mentionHandle(name)} `
    input.value = input.value.slice(0, tok.start) + ins + input.value.slice(caret)
    const at = tok.start + ins.length
    input.setSelectionRange(at, at)
    closePop()
    input.focus()
  }
  const paint = () => pop.replaceChildren(...options.map((n, i) => {
    const b = h('button', { className: `mention-opt${i === sel ? ' on' : ''}`, type: 'button', role: 'option' }, mentionHandle(n))
    b.onpointerdown = (e) => e.preventDefault() // keep the input focused (the keyboard stays up on a phone)
    b.onclick = () => choose(n)
    return b
  }))
  const refresh = () => {
    tok = mentionQuery(input.value, input.selectionStart ?? input.value.length)
    const q = tok?.query.toLowerCase() ?? ''
    options = tok ? candidates().filter((n) => mentionHandle(n).slice(1).toLowerCase().startsWith(q) && mentionHandle(n).slice(1).toLowerCase() !== q) : []
    if (!options.length) return closePop()
    sel = Math.min(sel, options.length - 1)
    pop.hidden = false
    paint()
  }
  input.oninput = () => { sel = 0; refresh() }
  input.onclick = refresh
  input.onkeydown = (e) => {
    e.stopPropagation() // not a timeline shortcut
    if (!pop.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
        return paint()
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return choose(options[sel]) }
      if (e.key === 'Escape') { e.preventDefault(); return closePop() }
    }
    if (e.key === 'Enter') submit()
    else if (e.key === 'Escape') input.blur()
  }
  input.onkeyup = (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') refresh() }
  input.onblur = () => setTimeout(closePop, 0)
  const el = h('aside', { className: 'chat', hidden: true }, list, h('div', { className: 'chat-in' }, pop, input, send))

  const [msgs, setMsgs] = createSignal<ChatMessage[]>([])
  const segs = (m: ChatMessage) => splitMentions(m.text, [...handles(), ...(m.mentions ?? []).map(mentionHandle)])
  const Msgs = () => (
    <For each={msgs()}>{(m, i) => isSystem(m) ? <div class="msg-sys" title={clock(m.ts)}>{m.text}</div> : (() => {
      const me = m.username === user.username
      const mine = me || m.username === myApi // (your own API identity: you may delete what it said)
      const side = me ? 'me' : 'them'
      const prev = () => msgs()[i() - 1]
      return <>
        <Show when={!prev() || prev()!.username !== m.username || m.ts - prev()!.ts > GAP_MS}>
          <div class={`msg-meta ${side}`}>{me ? clock(m.ts) : `${m.username} · ${clock(m.ts)}`}</div>
        </Show>
        <div
          class={`msg ${side}`}
          classList={{ 'mentions-me': mentionsMe(m) }}
          style={me ? undefined : { 'box-shadow': `inset 2px 0 0 ${m.color}` }}
          oncontextmenu={mine ? (e) => { // own messages (and those of your own API identity) only: the server can't tell who wrote what
            e.preventDefault()
            popover(e.currentTarget, [['delete message', () => deleteChatMessage(doc, m.id)]], [e.clientX, e.clientY])
          } : undefined}
        ><For each={segs(m)}>{(g) => g.mention ? <span class="mention" classList={{ 'mention-me': g.mention === user.username }}>{g.text}</span> : g.text}</For></div>
      </>
    })()}</For>
  )
  const dispose = render(Msgs, list)

  function sync() {
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    setMsgs(dedupeSystem(log.toArray().slice(-SHOWN))) // (the entries keep their identity, so <For> only adds and removes rows)
    if (atEnd) list.scrollTop = list.scrollHeight
    if (open) seen = log.length
    onUnread(open ? 0 : Math.max(0, log.length - seen))
    onMentions?.(open ? 0 : log.toArray().slice(seen).filter(mentionsMe).length)
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
    markSeen() { seen = log.length; onUnread(0); onMentions?.(0) },
    destroy() { log.unobserve(sync); dispose(); closePop() },
  }
}
