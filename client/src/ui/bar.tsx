// The top bar: logo, transport, loop status, cpu, status line, who is here, zoom, export and chat. Mounted into the timeline's header.
import { Index, Show, createMemo } from 'solid-js'
import { render } from 'solid-js/web'
import type { Accessor } from 'solid-js'
import type { AwarenessState } from '@mobdaw/shared'
import type { ProjectStore } from '../project/store'
import { homeLink } from '../router'
import { iconHtml } from '../theme/icons'

const initials = (n: string) => n.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

export type BarProps = {
  store: ProjectStore
  readOnly: boolean
  /** A project on this device: no chat. */
  local: boolean
  user: AwarenessState['user']
  /** The existing transport widget (`transportControls().el`); the metronome button joins it, right of the time readout. */
  transport: HTMLElement
  status: Accessor<{ text: string; bad: boolean }>
  cpu: Accessor<{ text: string; hot: boolean } | null>
  /** The loop recording line; null while no loop records. */
  loopText: Accessor<string | null>
  unread: Accessor<number>
  chatOpen: Accessor<boolean>
  onStatus(): void
  onClickTrack(): void
  onZoom(factor: number): void
  onExport(): void
  onChat(): void
  /** A visitor's edits live only on this page: shown once there are some, saves them as a project on this device. */
  saveCopy?: { shown: Accessor<boolean>; onSave(): void }
}

export function Bar(p: BarProps) {
  const users = createMemo(() => [p.user, ...p.store.remote().map((r) => r.user)])
  const clicking = () => p.store.tracks().some((t) => t.role === 'click' && !t.muted) // lit: a click track exists and is unmuted
  // The metronome is an ordinary MIDI track (role 'click'): the button makes it, and then mutes / unmutes it.
  const metro = (
    <button class="metro" classList={{ on: clicking() }} disabled={p.readOnly} title="metronome: add a click track, then mute / unmute it" on:click={p.onClickTrack} />
  ) as HTMLElement
  p.transport.append(metro) // sits right of the time readout
  return (
    <>
      <div class="bar-l">
        <a href={homeLink.href} on:click={homeLink.onclick} class="logo" title="all projects">mobdaw</a>
        <Show when={p.readOnly}><span class="dim">view only</span></Show>
        <Show when={p.saveCopy?.shown()}>
          <button class="bar-btn" title="your changes are not saved: keep them as a project on this device" on:click={() => p.saveCopy!.onSave()}>save a copy</button>
        </Show>
      </div>
      {p.transport}
      <div class="bar-r">
        <span class="pedal-st rec" hidden={p.loopText() == null} title="recording a loop: the time to the next boundary of the cycle (a loop starts and ends on it); the first loop runs press to press">{p.loopText()}</span>
        <span class="cpu" classList={{ hot: !!p.cpu()?.hot }} title="audio engine load: share of the real-time budget used by DSP (peak call in the last half second)">{p.cpu()?.text}</span>
        <span class={`status ${p.status().bad ? 'error' : 'dim'}`} on:click={p.onStatus}>{p.status().text}</span>
        <span class="presence">
          <Index each={users()}>{(u) => <span class="dot" title={u().username} style={{ background: u().color }}>{initials(u().username)}</span>}</Index>
        </span>
        <div class="bar-btns">
          <button class="bar-btn zoom" title="zoom out (ctrl + scroll)" on:click={() => p.onZoom(1 / 1.5)} innerHTML={iconHtml('zoomOut', 18)} />
          <button class="bar-btn zoom" title="zoom in (ctrl + scroll)" on:click={() => p.onZoom(1.5)} innerHTML={iconHtml('zoomIn', 18)} />
          <button class="bar-btn" title="render the whole project to a file" on:click={p.onExport}>export</button>
          <Show when={!p.local}>
            <button class="chat-btn" classList={{ on: p.chatOpen() }} title="chat" on:click={p.onChat}>{p.unread() ? `chat (${p.unread()})` : 'chat'}</button>
          </Show>
        </div>
      </div>
    </>
  )
}

/** Fill the bar element (`host`); returns the function that takes it down. */
export const mountBar = (host: HTMLElement, p: BarProps) => render(() => <Bar {...p} />, host)
