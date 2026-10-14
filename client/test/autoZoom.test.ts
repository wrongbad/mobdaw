import { describe, expect, it } from 'vitest'
import { EDIT_FILL, MIN_EDIT_BEAT_PX, editZoomPps } from '../src/ui/autoZoom'
import { MAX_PPS } from '../src/ui/zoomFit'

describe('editZoomPps', () => {
  it('leaves a comfortable zoom alone', () => {
    expect(editZoomPps(80, 4, 0.5, 1000)).toBeNull() // 40px beats
    expect(editZoomPps(MIN_EDIT_BEAT_PX / 0.5, 4, 0.5, 1000)).toBeNull()
  })
  it('zooms a narrow clip to fill most of the view', () => {
    expect(editZoomPps(10, 8, 0.5, 1000)).toBeCloseTo((1000 * EDIT_FILL) / 8) // 8 s clip: 106 px/s, 53px beats
  })
  it('never makes beats narrower than the minimum, even for a long clip', () => {
    expect(editZoomPps(5, 600, 0.5, 1000)).toBeCloseTo(MIN_EDIT_BEAT_PX / 0.5)
  })
  it('clamps to the zoom limit and never zooms out', () => {
    expect(editZoomPps(10, 0.001, 0.5, 1000)).toBe(MAX_PPS)
    expect(editZoomPps(30, 100, 2, 1000)).toBeNull() // 60px beats already
  })
  it('ignores bad input', () => {
    expect(editZoomPps(10, 0, 0.5, 1000)).toBeNull()
    expect(editZoomPps(10, 4, 0.5, 0)).toBeNull()
  })
})
