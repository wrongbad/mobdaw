import { expect, test } from 'vitest'
import { loadHidden, locate } from '../src/score/view'

const bars = [0, 1, 2, 3, 4].map((i) => ({ bar: i + 1, startTick: i * 100, endTick: i * 100 + 100 }))
const lines = [{ first: 0, last: 2 }, { first: 3, last: 4 }]

test('locate: tick -> bar, line, measure within the line', () => {
  expect(locate({ bars, lines }, 0)).toEqual({ bar: 0, line: 0, measure: 0 })
  expect(locate({ bars, lines }, 299)).toEqual({ bar: 2, line: 0, measure: 2 })
  expect(locate({ bars, lines }, 300)).toEqual({ bar: 3, line: 1, measure: 0 })
  expect(locate({ bars, lines }, 450)).toEqual({ bar: 4, line: 1, measure: 1 })
  expect(locate({ bars, lines }, -5)).toEqual({ bar: 0, line: 0, measure: 0 })
  expect(locate({ bars, lines }, 500)).toBeNull()
  expect(locate({ bars: [], lines: [] }, 0)).toBeNull()
})

test('the hidden-track choice survives bad storage', () => {
  expect(loadHidden('nope').size).toBe(0)
})
