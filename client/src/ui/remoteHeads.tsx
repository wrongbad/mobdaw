// The other people's playheads: one thin line each, patched in place as they move (never rebuilt per awareness change).
import { Index } from 'solid-js'
import { render } from 'solid-js/web'
import type { Accessor } from 'solid-js'
import type { ProjectStore } from '../project/store'

/** `offset`: px the lines start from (the track headers cover the overlay's left edge, but not the ruler's). `scale`: where a sample lands. */
export function RemoteHeads(p: { store: ProjectStore; offset: number; scale: Accessor<{ pps: number; rate: number }> }) {
  const playing = () => p.store.remote().filter((r) => r.playhead != null)
  return (
    <Index each={playing()}>
      {(r) => <div class="remote-head" style={{ left: `${p.offset + (r().playhead! / p.scale().rate) * p.scale().pps}px`, background: r().user.color }} />}
    </Index>
  )
}

type Props = Parameters<typeof RemoteHeads>[0]
/** Append the lines to `host` (which keeps its other children). */
export const mountRemoteHeads = (host: HTMLElement, p: Props) => render(() => <RemoteHeads {...p} />, host)
