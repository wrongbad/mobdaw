// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { historyLog, type HistoryEntry, type HistoryResult } from '@mobdaw/shared'
import { historyPanel, resultText } from '../src/ui/history'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((f) => f()))

const entry = (seq: number, o: Partial<HistoryEntry> = {}): HistoryEntry => ({ seq, username: 'ann', color: 'rgb(255, 0, 0)', text: `change ${seq}`, ts: 1_700_000_000_000 + seq, ...o })
const ok = (o: Partial<HistoryResult> = {}): HistoryResult => ({ applied: 1, skipped: [], seq: 9, ...o })

function setup(confirmAnswer = true) {
  const doc = new Y.Doc()
  const revert = vi.fn(async (_: number) => ok())
  const restore = vi.fn(async (_: number) => ok())
  const say = vi.fn()
  const confirm = vi.fn((_: string) => confirmAnswer)
  const panel = historyPanel({ doc, revert, restore, say, confirm })
  document.body.append(panel.el)
  cleanup.push(() => (panel.destroy(), panel.el.remove(), document.querySelectorAll('.popover').forEach((p) => p.remove())))
  const rows = () => [...panel.el.querySelectorAll('.hist')] as HTMLElement[]
  const pick = async (row: number, label: string) => {
    rows()[row].querySelector<HTMLButtonElement>('.hist-more')!.click()
    ;[...document.querySelectorAll<HTMLButtonElement>('.popover button')].find((b) => b.textContent === label)!.click()
    await new Promise((r) => setTimeout(r))
  }
  return { doc, panel, revert, restore, say, confirm, rows, pick }
}

describe('history panel', () => {
  it('lists the log with a colour dot, the text, who and when; api entries are marked', () => {
    const { doc, rows } = setup()
    historyLog(doc).push([entry(1), entry(2, { username: 'ann', api: true, text: 'added 16 notes to Bass' })])
    expect(rows()).toHaveLength(2)
    expect(rows()[0].querySelector('.hist-text')!.textContent).toBe('change 1')
    expect(rows()[0].querySelector<HTMLElement>('.hist-dot')!.style.background).toBe('rgb(255, 0, 0)')
    expect(rows()[0].querySelector('.hist-meta')!.textContent).toMatch(/^ann · /)
    expect(rows()[0].classList.contains('api')).toBe(false)
    expect(rows()[1].classList.contains('api')).toBe(true)
    expect(rows()[1].querySelector('.hist-meta')!.textContent).toMatch(/^ann \(api\) · /)
  })

  it('appends without rebuilding the rows already there, and shows only the last 500', () => {
    const { doc, rows } = setup()
    historyLog(doc).push([entry(1)])
    const before = rows()
    historyLog(doc).push([entry(2)])
    expect(rows()[0]).toBe(before[0])
    historyLog(doc).push(Array.from({ length: 600 }, (_, i) => entry(10 + i)))
    expect(rows()).toHaveLength(500)
    expect(rows()[0].querySelector('.hist-text')!.textContent).toBe('change 110')
  })

  it('"Revert this" calls the API for that entry and reports the outcome', async () => {
    const { doc, revert, say, pick } = setup()
    historyLog(doc).push([entry(4), entry(5)])
    await pick(1, 'Revert this')
    expect(revert).toHaveBeenCalledWith(5)
    expect(say).toHaveBeenLastCalledWith('reverted')
    revert.mockResolvedValueOnce(ok({ applied: 0, skipped: [{ coll: 'tracks', id: 't', field: 'name' }, { coll: 'tracks', id: 't', field: 'muted' }] }))
    await pick(0, 'Revert this')
    expect(say).toHaveBeenLastCalledWith('nothing reverted: 2 fields skipped: changed since')
    revert.mockRejectedValueOnce(new Error('not_found'))
    await pick(0, 'Revert this')
    expect(say).toHaveBeenLastCalledWith('could not be reverted: not_found', true)
  })

  it('"Restore to this version" asks first', async () => {
    const no = setup(false)
    historyLog(no.doc).push([entry(1), entry(2)])
    await no.pick(0, 'Restore to this version')
    expect(no.confirm).toHaveBeenCalledOnce()
    expect(no.confirm.mock.calls[0][0]).toContain('1 later change')
    expect(no.restore).not.toHaveBeenCalled()
    const yes = setup(true)
    historyLog(yes.doc).push([entry(1), entry(2)])
    await yes.pick(0, 'Restore to this version')
    expect(yes.restore).toHaveBeenCalledWith(1)
    expect(yes.say).toHaveBeenLastCalledWith('restored')
  })

  it('follows new entries while at the bottom and keeps its place after scrolling up', () => {
    const { doc, panel } = setup()
    const list = panel.el.querySelector<HTMLElement>('.history-log')!
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 1000 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 200 })
    list.scrollTop = 790 // within 40px of the end
    historyLog(doc).push([entry(1)])
    expect(list.scrollTop).toBe(1000)
    list.scrollTop = 100 // scrolled up
    historyLog(doc).push([entry(2)])
    expect(list.scrollTop).toBe(100)
    panel.setOpen(true) // opening goes to the newest
    expect(list.scrollTop).toBe(1000)
  })

  it('stops observing once destroyed', () => {
    const { doc, panel, rows } = setup()
    panel.destroy()
    historyLog(doc).push([entry(1)])
    expect(rows()).toHaveLength(0)
    cleanup.pop()
    panel.el.remove()
  })
})

describe('resultText', () => {
  it('says what happened', () => {
    expect(resultText('restored', ok())).toBe('restored')
    expect(resultText('reverted', ok({ skipped: [{ coll: 'x', id: 'y', field: 'z' }] }))).toBe('reverted, 1 field skipped: changed since')
    expect(resultText('reverted', ok({ applied: 0 }))).toBe('nothing to revert')
  })
})
