import { describe, expect, it } from 'vitest'
import { safeName } from '../src/download'
import { describeError } from '../src/errors'
import { bytes, daysLeft } from '../src/format'

describe('format', () => {
  it('bytes', () => {
    expect(bytes(0)).toBe('0 b')
    expect(bytes(1536)).toBe('1.5 kb')
    expect(bytes(40 * 1024 ** 3)).toBe('40.0 gb')
  })
  it('daysLeft rounds up and never goes negative', () => {
    expect(daysLeft(Date.now() + 29.2 * 86_400_000)).toBe(30)
    expect(daysLeft(Date.now() - 5000)).toBe(0)
  })
  it('safeName strips path and reserved characters', () => {
    expect(safeName('a/b\\c:d*e?.wav')).toBe('a_b_c_d_e_.wav')
    expect(safeName('   ', 'fallback')).toBe('fallback')
  })
  it('describeError maps known API codes and passes others through', () => {
    expect(describeError(new Error('quota_exceeded'))).toMatch(/storage is full/i)
    expect(describeError(new Error('something odd'))).toBe('something odd')
  })
})
