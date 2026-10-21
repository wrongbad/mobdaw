// The top bar: logo, transport, loop status, cpu, status line, who is here, zoom, export and chat. Mounted into the timeline's header.
import { Index, Show, createMemo } from 'solid-js'
import { render } from 'solid-js/web'
import type { Accessor } from 'solid-js'
import type { AwarenessState } from '@mobdaw/shared'
import type { ProjectStore } from '../project/store'
import { homeLink } from '../router'
import { iconHtml } from '../theme/icons'

const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
/** An agent's dot: "k (api)" shows `[k]`, so it reads as an API participant, not a person. */
const dotText = (u: AwarenessState) => (u.api ? `[${initials(u.user.username.replace(/ \(api\)$/, '')).slice(0, 1)}]` : initials(u.user.username))

export type BarProps = {
  store: ProjectStore
  /** Synced with collaborators: only then are there chat and presence (and your own dot among them). */
  live: boolean
  /** A snapshot of a cloud project: edits stay on this page. */
  snapshot: boolean
  user: AwarenessState['user']
  /** The existing transport widget (`transportControls().el`); the metronome button joins it, right of the time readout. */
  transport: HTMLElement
  status: Accessor<{ text: string; bad: boolean }>
  cpu: Accessor<{ text: string; hot: boolean } | null>
  /** The loop recording line; null while no loop records. */
  loopText: Accessor<string | null>
  unread: Accessor<number>
  /** Unread chat messages that mention you. */
  mentions?: Accessor<number>
  chatOpen: Accessor<boolean>
  /** The history panel (live cloud sessions only; absent: no button). */
  history?: { open: Accessor<boolean>; onToggle(): void }
  /** The score mode (sheet music instead of the tracks): `on` while shown. */
  score?: { on: Accessor<boolean>; onToggle(): void }
  /** A line of notice next to the logo (e.g. the project is read-only because a newer version wrote it); null: none. */
  notice?: Accessor<string | null>
  onStatus(): void
  onClickTrack(): void
  onZoom(factor: number): void
  onExport(): void
  onChat(): void
  /** A visitor's edits live only on this page: shown once there are some, saves them as a project on this device. */
  saveCopy?: { shown: Accessor<boolean>; onSave(): void }
}

export function Bar(p: BarProps) {
  const users = createMemo((): AwarenessState[] => [{ user: p.user }, ...p.store.remote()])
  const clicking = () => p.store.tracks().some((t) => t.role === 'click' && !t.muted) // lit: a click track exists and is unmuted
  // The metronome is an ordinary MIDI track (role 'click'): the button makes it, and then mutes / unmutes it.
  const metro = (
    <button class="metro" classList={{ on: clicking() }} title="metronome: add a click track, then mute / unmute it" on:click={p.onClickTrack} />
  ) as HTMLElement
  p.transport.append(metro) // sits right of the time readout
  return (
    <>
      <div class="bar-l">
        <a href={homeLink.href} on:click={homeLink.onclick} class="logo" title="all projects">mobdaw</a>
        <Show when={p.snapshot}>
          <span class="dim" title="you are looking at a snapshot of this project. Your changes stay on this page, are not shared and are lost when you leave, unless you save a copy to this device.">changes stay on this page</span>
        </Show>
        <Show when={p.notice?.()}>{(n) => <span class="warn" title={n()}>{n()}</span>}</Show>
        <Show when={p.saveCopy?.shown()}>
          <button class="bar-btn" title="your changes are not saved: keep them as a project on this device" on:click={() => p.saveCopy!.onSave()}>save a copy</button>
        </Show>
      </div>
      {p.transport}
      <div class="bar-r">
        <span class="pedal-st rec" hidden={p.loopText() == null} title="recording a loop: the time to the next boundary of the cycle (a loop starts and ends on it); the first loop runs press to press">{p.loopText()}</span>
        <span class="cpu" classList={{ hot: !!p.cpu()?.hot }} title="audio engine load: share of the real-time budget used by DSP (peak call in the last half second)">{p.cpu()?.text}</span>
        <span class={`status ${p.status().bad ? 'error' : 'dim'}`} on:click={p.onStatus}>{p.status().text}</span>
        <Show when={p.live}>
          <span class="presence">
            <Index each={users()}>{(u) => <span class="dot" classList={{ api: !!u().api }} title={u().api ? `${u().user.username} — via API` : u().user.username} style={{ background: u().user.color }}>{dotText(u())}</span>}</Index>
          </span>
        </Show>
        <div class="bar-btns">
          <button class="bar-btn zoom" title="zoom out (ctrl + scroll)" on:click={() => p.onZoom(1 / 1.5)} innerHTML={iconHtml('zoomOut', 18)} />
          <button class="bar-btn zoom" title="zoom in (ctrl + scroll)" on:click={() => p.onZoom(1.5)} innerHTML={iconHtml('zoomIn', 18)} />
          <Show when={p.score}>{(sc) => <button class="chat-btn icon-btn" classList={{ on: sc().on() }} title="score: show the MIDI tracks as sheet music" aria-label="score" on:click={sc().onToggle} innerHTML={iconHtml('score', 18)} />}</Show>
          <button class="bar-btn icon-btn" title="export: render the whole project to a file" aria-label="export" on:click={p.onExport} innerHTML={iconHtml('export', 18)} />
          <Show when={p.live}>
            <Show when={p.history}>{(hist) => <button class="chat-btn icon-btn" classList={{ on: hist().open() }} title="history: every change to the project, with revert and restore" aria-label="history" on:click={hist().onToggle} innerHTML={iconHtml('history', 18)} />}</Show>
            <button class="chat-btn icon-btn" classList={{ on: p.chatOpen() }} title={p.unread() ? `chat (${p.unread()} unread)` : 'chat'} aria-label="chat" on:click={p.onChat}><span innerHTML={iconHtml('chat', 18)} /><Show when={p.unread()}><span class="unread-badge">{p.unread()}</span></Show><Show when={p.mentions?.()}><span class="at-badge" title="unread messages that mention you">@</span></Show></button>
          </Show>
        </div>
      </div>
    </>
  )
}

/** Fill the bar element (`host`); returns the function that takes it down. */
export const mountBar = (host: HTMLElement, p: BarProps) => render(() => <Bar {...p} />, host)
