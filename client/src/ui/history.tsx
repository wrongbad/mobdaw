// History sidebar: the project's shared change log (the doc's `history` array, written by the server), newest at the bottom like
// chat. Each row has a menu to revert that one change or restore the project to how it was right after it.
import { historyLog, type HistoryEntry, type HistoryResult } from '@mobdaw/shared'
import type * as Y from 'yjs'
import { For, Show, createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { h } from '../dom'
import { popover } from './popover'

const SHOWN = 500
const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

export type HistoryDeps = {
  doc: Y.Doc
  revert(seq: number): Promise<HistoryResult>
  restore(seq: number): Promise<HistoryResult>
  /** The outcome of a revert / restore, or its failure (`bad`). */
  say(text: string, bad?: boolean): void
  /** Asks before a restore (defaults to `confirm`). */
  confirm?(text: string): boolean
}

/** What the bar shows after a revert: how much was written back and what had changed since. */
export function resultText(what: 'reverted' | 'restored', r: HistoryResult) {
  const skipped = r.skipped.length ? `${r.skipped.length} field${r.skipped.length === 1 ? '' : 's'} skipped: changed since` : ''
  if (!r.applied) return skipped ? `nothing ${what}: ${skipped}` : `nothing to ${what === 'reverted' ? 'revert' : 'restore'}`
  return skipped ? `${what}, ${skipped}` : what
}

export function historyPanel({ doc, revert, restore, say, confirm: ask = (t) => confirm(t) }: HistoryDeps) {
  const log = historyLog(doc)
  let open = false

  const list = h('div', { className: 'history-log' })
  const el = h('aside', { className: 'history', hidden: true }, list)

  const [entries, setEntries] = createSignal<HistoryEntry[]>([])
  const run = (what: 'reverted' | 'restored', go: () => Promise<HistoryResult>) =>
    go().then((r) => say(resultText(what, r)), (e) => say(`could not be ${what}: ${(e as Error).message}`, true))
  const menu = (anchor: HTMLElement, e: HistoryEntry) =>
    popover(anchor, [
      ['Revert this', () => void run('reverted', () => revert(e.seq))],
      ['Restore to this version', () => {
        const later = log.toArray().filter((x) => x.seq > e.seq).length
        if (ask(`restore the project to right after "${e.text}"? ${later ? `the ${later} later change${later === 1 ? '' : 's'}, by everyone, will be undone.` : ''}`)) void run('restored', () => restore(e.seq))
      }],
    ])
  const Rows = () => (
    <For each={entries()}>{(e) => (
      <div class="hist" classList={{ api: !!e.api }}>
        <span class="hist-dot" style={{ background: e.color }} />
        <div class="hist-main">
          <div class="hist-text">{e.text}</div>
          <div class="hist-meta">{e.username}<Show when={e.api}> (api)</Show> · {clock(e.ts)}</div>
        </div>
        <button class="hist-more" title="revert or restore" on:click={(ev) => menu(ev.currentTarget, e)}>⋯</button>
      </div>
    )}</For>
  )
  const dispose = render(Rows, list)

  function sync() {
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    setEntries(log.toArray().slice(-SHOWN)) // (the entries keep their identity, so <For> only adds and removes rows)
    if (atEnd) list.scrollTop = list.scrollHeight
  }
  log.observe(sync)
  sync()

  return {
    el,
    get open() { return open },
    setOpen(o: boolean) {
      open = o
      el.hidden = !o
      if (o) list.scrollTop = list.scrollHeight
    },
    destroy() { log.unobserve(sync); dispose() },
  }
}
