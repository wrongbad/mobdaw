import { isLifted, lift } from './lift'

// Shared mechanics for draggable blocks on the timeline: audio clips, MIDI clips and soundscape
// regions all have a start and a length in samples, move by their body and resize by their edges.

export const EDGE = 8

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export type Grab = 'l' | 'r' | 'move' | 'loop' | 'pass'

/**
 * Which part of a block was pressed: the left or right trim edge (each at most a third of the
 * block, so narrow blocks keep a middle to grab) or the body.
 * Clips pass `at` to split the right edge: on a looping clip (`looping`) the whole edge is the `'loop'` handle (the
 * extent), else its upper half is and the lower half stays `'r'` (trim). A looping clip's first seam (`seam`, a
 * clientX) has the `'pass'` handle on its lower half, the upper half being plain `'move'`. The edges win over the seam.
 */
export function grabAt(clientX: number, box: DOMRect): 'l' | 'r' | 'move'
export function grabAt(clientX: number, box: DOMRect, at: { y: number; looping: boolean; seam?: number }): Grab
export function grabAt(clientX: number, box: DOMRect, at?: { y: number; looping: boolean; seam?: number }): Grab {
  const edge = Math.min(EDGE, box.width / 3)
  const upper = !!at && at.y < box.top + box.height / 2
  if (clientX > box.right - edge) return !at ? 'r' : at.looping || upper ? 'loop' : 'r'
  if (clientX < box.left + edge) return 'l'
  if (at?.looping && at.seam !== undefined && !upper && Math.abs(clientX - at.seam) <= edge / 2) return 'pass'
  return 'move'
}

/** A looping clip's phase after its left edge moves `d` samples right (the seams stay put, so the pass turns under it). */
export const rotatePhase = (phase: number, d: number, pass: number) => (((phase + d) % pass) + pass) % pass

/**
 * Where whole passes of a looping clip end on the timeline (samples): the first seam at `start + pass - phase`, then
 * every `pass`, up to `until`. These are what its extent soft-snaps to; `max` bounds the list for tiny passes.
 */
export function passBoundaries(start: number, pass: number, phase: number, until: number, max = 8192) {
  const out: number[] = []
  if (!(pass > 0)) return out
  for (let k = 0; k < max; k++) {
    const t = start + pass - phase + k * pass
    if (t > until) break
    out.push(Math.round(t))
  }
  return out
}

/**
 * A pointer drag tracked on `window` (so it survives the block being re-parented or re-rendered),
 * with `onDrag` throttled to one call per frame and `onEnd` called once on release.
 * `moved` tells whether the pointer travelled more than a few pixels (otherwise it was a click).
 */
export function dragPointer(
  ev: PointerEvent,
  h: { onDrag(m: PointerEvent): void; onEnd?(moved: boolean): void },
) {
  // a finger picks the block up with a long press (see lift.ts); a tap ends as a click, a swipe as a scroll
  if (ev.pointerType === 'touch' && !isLifted(ev)) return lift(ev, () => dragPointer(ev, h), (why) => h.onEnd?.(why === 'moved'))
  let last: PointerEvent | null = null
  let pending = 0
  let moved = false
  const flush = () => {
    pending = 0
    if (last) h.onDrag(last)
  }
  const move = (m: PointerEvent) => {
    last = m
    if (Math.abs(m.clientX - ev.clientX) > 3 || Math.abs(m.clientY - ev.clientY) > 3) moved = true
    if (!pending) pending = requestAnimationFrame(flush)
  }
  const up = () => {
    cancelAnimationFrame(pending)
    flush()
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', up)
    removeEventListener('pointercancel', up)
    h.onEnd?.(moved)
  }
  addEventListener('pointermove', move)
  addEventListener('pointerup', up)
  addEventListener('pointercancel', up)
}

/**
 * Resize a block by a pointer delta `dSmp` (samples). Dragging the left edge (`'l'`) moves the start
 * and shrinks the length by the same amount, by at most `slackLeft` samples to the left (how far the
 * start can still go: audio can't pass its source's beginning, nothing passes 0) and never below
 * `minLength`; the right edge (`'r'`) changes the length, up to `maxLength`.
 * Returns the new start and length, and `d`, how far the start moved.
 */
export function trimBlock(
  grab: 'l' | 'r',
  b: { start: number; length: number },
  dSmp: number,
  o: { minLength: number; slackLeft: number; maxLength?: number },
) {
  if (grab === 'l') {
    const d = Math.round(clamp(dSmp, -o.slackLeft, b.length - o.minLength))
    return { start: b.start + d, length: b.length - d, d }
  }
  return { start: b.start, length: Math.round(clamp(b.length + dSmp, o.minLength, o.maxLength ?? Infinity)), d: 0 }
}

/**
 * Trim the left edge of a MIDI clip by a pointer delta (samples), snapped to 1/16 notes. The start
 * moves, the length shrinks and `d` (ticks, positive = shorter) is what every note's tick must
 * decrease by so the music stays put on the timeline. The start can't pass 0 and the clip keeps at
 * least one step.
 */
export function trimMidiLeft(c: { start: number; bpm: number; ppq: number; lengthTicks: number }, dSmp: number, rate: number) {
  const k = (c.bpm * c.ppq) / (60 * rate) // ticks per sample
  const step = c.ppq / 4
  const d = clamp(Math.round((dSmp * k) / step) * step, Math.ceil((-c.start * k) / step) * step, c.lengthTicks - step)
  return { start: Math.max(0, c.start + Math.round(d / k)), lengthTicks: c.lengthTicks - d, d }
}

/**
 * Where a note at `tick` of a looping pattern (`loop` ticks long, the notes in `[0, loop)`) goes when the clip's left edge
 * moves `d` ticks to the right: back by `d`, turning round the loop's start so it stays inside the pattern.
 */
export const rotateTick = (tick: number, d: number, loop: number) => (((tick - d) % loop) + loop) % loop

/**
 * Snap a block being moved: its start or its end, whichever lies nearest to one of `targets` (all samples), jumps onto
 * that target when within `tol`. Returns the (possibly shifted) start and the target it landed on, or null when none was close.
 */
export function snapMove(start: number, length: number, targets: number[], tol: number) {
  let best: { start: number; at: number; gap: number } | null = null
  for (const t of targets) {
    for (const edge of [0, length]) {
      const gap = Math.abs(start + edge - t)
      if (gap <= tol && (!best || gap < best.gap)) best = { start: t - edge, at: t, gap }
    }
  }
  return best && best.start >= 0 ? { start: best.start, at: best.at } : null
}

/**
 * A drag's snapping with hysteresis: once the block has snapped to a target and then pulled away, that target stays
 * disarmed until the block is more than `rearm` from it, so things can be placed close beside a target by hand.
 * Call the returned function with each new position (same units as `targets`); `tol` is the snap distance.
 */
export function snapTracker(targets: number[], rearm: number) {
  const off = new Set<number>()
  let last: number | null = null
  const gap = (t: number, start: number, length: number) => Math.min(Math.abs(start - t), Math.abs(start + length - t))
  return (start: number, length: number, tol: number) => {
    for (const t of off) if (gap(t, start, length) > rearm) off.delete(t)
    const snap = snapMove(start, length, targets.filter((t) => !off.has(t)), tol)
    if (last !== null && snap?.at !== last && gap(last, start, length) <= rearm) off.add(last)
    last = snap?.at ?? null
    return snap
  }
}
