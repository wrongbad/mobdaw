// Shared mechanics for draggable blocks on the timeline: audio clips, MIDI clips and soundscape
// regions all have a start and a length in samples, move by their body and resize by their edges.

export const EDGE = 8

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export type Grab = 'l' | 'r' | 'move'

/**
 * Which part of a block was pressed: the left or right trim edge (each at most a third of the
 * block, so narrow blocks keep a middle to grab) or the body.
 */
export function grabAt(clientX: number, box: DOMRect): Grab {
  const edge = Math.min(EDGE, box.width / 3)
  if (clientX > box.right - edge) return 'r'
  if (clientX < box.left + edge) return 'l'
  return 'move'
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
