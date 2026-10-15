// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { addChatMessage, chatLog } from '@mobdaw/shared'
import { chatPanel } from '../src/ui/chat'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))

const me = { username: 'me', color: '#fff' }
const them = { username: 'ann', color: '#f00' }

function setup(readOnly = false) {
  const doc = new Y.Doc()
  const unread: number[] = []
  const chat = chatPanel({ doc, user: me, readOnly, onUnread: (n) => unread.push(n) })
  document.body.append(chat.el)
  cleanup.push(() => (chat.destroy(), chat.el.remove()))
  const rows = () => [...chat.el.querySelectorAll('.chat-log > div')] as HTMLElement[]
  return { doc, chat, unread, rows }
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
})
