// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addChatMessage, addSystemMessage, chatLog } from '@mobdaw/shared'
import { chatPanel } from '../src/ui/chat'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))

const me = { username: 'me', color: '#fff' }
const them = { username: 'ann', color: '#f00' }

function setup(names: string[] = ['ann', 'bob', 'k (api)']) {
  const doc = new Y.Doc()
  const unread: number[] = []
  const mentions: number[] = []
  const chat = chatPanel({ doc, user: me, onUnread: (n) => unread.push(n), onMentions: (n) => mentions.push(n), names: () => names })
  document.body.append(chat.el)
  cleanup.push(() => (chat.destroy(), chat.el.remove()))
  const rows = () => [...chat.el.querySelectorAll('.chat-log > div')] as HTMLElement[]
  return { doc, chat, unread, mentions, rows }
}

describe('chat panel', () => {
  it('appends without rebuilding the rows already there', () => {
    const { doc, rows } = setup()
    addChatMessage(doc, them, 'one')
    const before = rows()
    addChatMessage(doc, them, 'two')
    const after = rows()
    before.forEach((e, i) => expect(after[i]).toBe(e)) // (same elements, not equal copies)
    expect(after.map((e) => e.className)).toEqual(['msg-meta them', 'msg them', 'msg them'])
  })

  it('starts a name line when the speaker changes or after a gap', () => {
    const { doc, rows } = setup()
    addChatMessage(doc, them, 'a')
    addChatMessage(doc, me, 'b')
    chatLog(doc).push([{ id: 'x', username: 'me', color: '', text: 'late', ts: Date.now() + 6 * 60_000 }])
    expect(rows().map((e) => e.className)).toEqual(['msg-meta them', 'msg them', 'msg-meta me', 'msg me', 'msg-meta me', 'msg me'])
    expect(rows()[0].textContent).toContain('ann · ')
  })

  it('shows only the last 500 and fixes the grouping at the new top', () => {
    const { doc, rows } = setup()
    const ts = Date.now()
    chatLog(doc).push(Array.from({ length: 502 }, (_, i) => ({ id: `m${i}`, username: 'ann', color: '', text: `t${i}`, ts })))
    const bubbles = rows().filter((e) => e.classList.contains('msg'))
    expect(bubbles).toHaveLength(500)
    expect(bubbles[0].textContent).toBe('t2')
    expect(rows()[0].className).toContain('msg-meta')
  })

  it('deletes own messages from the context menu only, and the next line regroups', () => {
    const { doc, rows } = setup()
    addChatMessage(doc, them, 'a')
    const id = addChatMessage(doc, me, 'mine')!
    const theirs = rows().find((e) => e.textContent === 'a')!
    theirs.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    expect(document.querySelector('.popover')).toBeNull()
    const mine = rows().find((e) => e.textContent === 'mine')!
    mine.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
    document.querySelector<HTMLButtonElement>('.popover button')!.click()
    expect(chatLog(doc).toArray().some((m) => m.id === id)).toBe(false)
    expect(rows().map((e) => e.textContent)).not.toContain('mine')
  })

  it('counts unread while closed and clears on open', () => {
    const { doc, chat, unread } = setup()
    chat.markSeen()
    addChatMessage(doc, them, 'a')
    addChatMessage(doc, them, 'b')
    expect(unread.at(-1)).toBe(2)
    chat.setOpen(true)
    expect(unread.at(-1)).toBe(0)
    addChatMessage(doc, them, 'c')
    expect(unread.at(-1)).toBe(0)
  })

  it('stops observing once destroyed', () => {
    const { doc, chat, rows } = setup()
    addChatMessage(doc, them, 'early')
    chat.destroy()
    addChatMessage(doc, them, 'late')
    expect(rows()).toHaveLength(0)
    cleanup.pop() // (already destroyed)
    chat.el.remove()
  })

  it('shows a system message as a muted notice, not as a bubble, and it breaks the speaker run', () => {
    const { doc, rows } = setup()
    addChatMessage(doc, them, 'hi')
    addSystemMessage(doc, 'migrated to a shared timeline at 96 bpm 4/4')
    addChatMessage(doc, them, 'ok')
    expect(rows().map((e) => e.className)).toEqual(['msg-meta them', 'msg them', 'msg-sys', 'msg-meta them', 'msg them'])
    expect(rows()[2].textContent).toBe('migrated to a shared timeline at 96 bpm 4/4')
  })

  it('shows a system notice posted twice by clients that migrated at once only once', () => {
    const { doc, rows } = setup()
    const note = { id: 'migrate-v4', username: 'mobdaw', color: '', text: 'migrated', ts: 1, system: true }
    chatLog(doc).push([note, { ...note }])
    expect(rows().map((e) => e.className)).toEqual(['msg-sys'])
  })

  it('renders mentions as spans, highlights yours and accents the message', () => {
    const { doc, rows } = setup()
    addChatMessage(doc, them, 'hi @me and @bob', ['@me', '@bob'])
    const msg = rows().find((e) => e.classList.contains('msg'))!
    expect([...msg.querySelectorAll('.mention')].map((e) => e.textContent)).toEqual(['@me', '@bob'])
    expect(msg.querySelectorAll('.mention-me')).toHaveLength(1)
    expect(msg.classList.contains('mentions-me')).toBe(true)
    expect(msg.textContent).toBe('hi @me and @bob')
  })

  it('parses old messages without stored mentions at render', () => {
    const { doc, rows } = setup()
    chatLog(doc).push([{ id: 'o', username: 'ann', color: '', text: 'yo @bob', ts: Date.now() }])
    expect(rows().find((e) => e.classList.contains('msg'))!.querySelector('.mention')?.textContent).toBe('@bob')
  })

  it('stores the mentions with the message', () => {
    const { doc, chat } = setup()
    chat.el.querySelector('input')!.value = 'hello @ann'
    chat.el.querySelector<HTMLButtonElement>('.chat-in > button:last-child')!.click()
    expect(chatLog(doc).get(0).mentions).toEqual(['ann'])
  })

  it('counts unread mentions of you separately, and clears them on open', () => {
    const { doc, chat, mentions } = setup()
    chat.markSeen()
    addChatMessage(doc, them, 'plain')
    addChatMessage(doc, them, '@me look', ['@me'])
    addChatMessage(doc, me, '@me self', ['@me'])
    expect(mentions.at(-1)).toBe(1)
    chat.setOpen(true)
    expect(mentions.at(-1)).toBe(0)
  })

  it('opens the autocomplete on @, filters, and inserts the handle with arrows + enter', () => {
    const { chat } = setup()
    const input = chat.el.querySelector('input')!
    const pop = chat.el.querySelector<HTMLElement>('.mention-pop')!
    const type = (v: string) => { input.value = v; input.setSelectionRange(v.length, v.length); input.dispatchEvent(new Event('input')) }
    const key = (k: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
    type('hey @')
    expect([...pop.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['@ann', '@bob', '@k(api)'])
    type('hey @k')
    expect([...pop.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['@k(api)'])
    type('hey @')
    key('ArrowDown')
    key('Enter')
    expect(input.value).toBe('hey @bob ')
    expect(pop.hidden).toBe(true)
    type('x @a')
    key('Escape')
    expect(pop.hidden).toBe(true)
  })

  it('picks an option by touch/click', () => {
    const { chat } = setup()
    const input = chat.el.querySelector('input')!
    input.value = '@'
    input.setSelectionRange(1, 1)
    input.dispatchEvent(new Event('input'))
    chat.el.querySelector<HTMLButtonElement>('.mention-opt')!.click()
    expect(input.value).toBe('@ann ')
  })

  it('lets you delete messages from your own (api) identity', () => {
    const { doc, rows } = setup()
    addChatMessage(doc, { username: 'me (api)', color: '#0f0' }, 'from the agent')
    rows().find((e) => e.textContent === 'from the agent')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
    expect(document.querySelector('.popover')).not.toBeNull()
  })
})
