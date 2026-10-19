import { describe, expect, it } from 'vitest'
import { grabAt, passBoundaries, rotatePhase, rotateTick, snapMove, snapTracker, trimBlock } from '../src/ui/blocks'

const box = (left: number, width: number) => ({ left, right: left + width, width }) as DOMRect

describe('grabAt', () => {
  it('finds the edges and the body, and keeps a middle on narrow blocks', () => {
    expect(grabAt(101, box(100, 200))).toBe('l')
    expect(grabAt(298, box(100, 200))).toBe('r')
    expect(grabAt(200, box(100, 200))).toBe('move')
    expect(grabAt(105, box(100, 12))).toBe('move') // each edge is at most a third: 4 px of 12
    expect(grabAt(101, box(100, 12))).toBe('l')
  })
})

describe('grabAt on clips', () => {
  const b = { left: 100, right: 300, width: 200, top: 0, height: 72 } as DOMRect
  const up = 10, low = 60
  it('splits the right edge of a plain clip: loop above, trim below', () => {
    expect(grabAt(298, b, { y: up, looping: false })).toBe('loop')
    expect(grabAt(298, b, { y: low, looping: false })).toBe('r')
    expect(grabAt(101, b, { y: up, looping: false })).toBe('l')
    expect(grabAt(200, b, { y: low, looping: false, seam: 150 })).toBe('move') // no pass handle without a loop
  })
  it('a looping clip loops over the whole right edge, with the pass handle on the lower half of the first seam', () => {
    expect(grabAt(298, b, { y: low, looping: true })).toBe('loop')
    expect(grabAt(298, b, { y: up, looping: true })).toBe('loop')
    expect(grabAt(150, b, { y: low, looping: true, seam: 152 })).toBe('pass')
    expect(grabAt(150, b, { y: up, looping: true, seam: 152 })).toBe('move')
    expect(grabAt(170, b, { y: low, looping: true, seam: 152 })).toBe('move')
    expect(grabAt(101, b, { y: low, looping: true, seam: 102 })).toBe('l') // the edges win over the seam
  })
  it('without `at` it is the plain edge test', () => {
    expect(grabAt(298, b)).toBe('r')
  })
})

describe('rotatePhase', () => {
  it('turns the pass under a left edge that moved, wrapping both ways', () => {
    expect(rotatePhase(0, 30, 100)).toBe(30)
    expect(rotatePhase(80, 50, 100)).toBe(30)
    expect(rotatePhase(20, -50, 100)).toBe(70)
    expect(rotatePhase(30, 70, 100)).toBe(0)
  })
})

describe('passBoundaries', () => {
  it('lists the seams from the first one, which a phase pulls earlier', () => {
    expect(passBoundaries(1000, 100, 0, 1350)).toEqual([1100, 1200, 1300])
    expect(passBoundaries(1000, 100, 30, 1350)).toEqual([1070, 1170, 1270])
  })
  it('is bounded', () => {
    expect(passBoundaries(0, 1, 0, 1e9, 5)).toHaveLength(5)
    expect(passBoundaries(0, 0, 0, 100)).toEqual([])
  })
})

describe('trimBlock', () => {
  const b = { start: 1000, length: 5000 }
  const o = { minLength: 100, slackLeft: 400 }
  it('left edge: start and length move together, bounded by the slack and the minimum length', () => {
    expect(trimBlock('l', b, 300, o)).toEqual({ start: 1300, length: 4700, d: 300 })
    expect(trimBlock('l', b, -300, o)).toEqual({ start: 700, length: 5300, d: -300 })
    expect(trimBlock('l', b, -9999, o).d).toBe(-400) // can't pass what is left of the source / timeline 0
    expect(trimBlock('l', b, 9999, o).length).toBe(100)
  })
  it('right edge: length only, bounded', () => {
    expect(trimBlock('r', b, 700, o)).toEqual({ start: 1000, length: 5700, d: 0 })
    expect(trimBlock('r', b, -9999, o).length).toBe(100)
    expect(trimBlock('r', b, 9999, { ...o, maxLength: 6000 }).length).toBe(6000)
  })
})

describe('rotateTick', () => {
  it('moves a looping pattern\'s notes back by the left trim, turning round the loop start', () => {
    expect(rotateTick(960, 240, 3840)).toBe(720)
    expect(rotateTick(0, 240, 3840)).toBe(3600) // before the new start: it is the next pass's now
    expect(rotateTick(100, -240, 3840)).toBe(340) // dragged back out to the left
    expect(rotateTick(100, 3840 * 5, 3840)).toBe(100) // whole passes change nothing
  })
})

describe('snapMove', () => {
  it('snaps the start to a nearby target', () => {
    expect(snapMove(103, 50, [0, 100], 5)).toEqual({ start: 100, at: 100 })
  })
  it('snaps the end to a nearby target', () => {
    expect(snapMove(48, 50, [100], 5)).toEqual({ start: 50, at: 100 })
  })
  it('takes the nearest of several candidates', () => {
    expect(snapMove(97, 50, [100, 146], 5)).toEqual({ start: 96, at: 146 })
  })
  it('leaves the block alone when nothing is within tolerance', () => {
    expect(snapMove(60, 10, [0, 100], 5)).toBeNull()
  })
  it('never snaps before 0', () => {
    expect(snapMove(2, 10, [8], 5)).toBeNull()
  })
})

describe('snapTracker', () => {
  it('stays off a target it was pulled free of until moved far enough away', () => {
    const snap = snapTracker([100], 20)
    expect(snap(103, 10, 5)?.start).toBe(100) // snapped
    expect(snap(108, 10, 5)).toBeNull() // pulled free
    expect(snap(103, 10, 5)).toBeNull() // back inside the zone: disarmed, place by hand
    expect(snap(130, 10, 5)).toBeNull() // far away: re-armed
    expect(snap(103, 10, 5)?.start).toBe(100)
  })
  it('does not disarm targets it never snapped to', () => {
    const snap = snapTracker([100], 20)
    expect(snap(60, 10, 5)).toBeNull()
    expect(snap(98, 10, 5)?.start).toBe(100)
  })
})
