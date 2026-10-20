import { describe, expect, it } from 'vitest'
import { apiName, handleName, mentionHandle, parseMentions, splitMentions } from '@mobdaw/shared'

const H = ['@ann', '@k', '@k(api)', '@ann.smith']

describe('mentions', () => {
  it('finds known handles, once each', () => {
    expect(parseMentions('hey @ann and @k, @ann again', H)).toEqual(['ann', 'k'])
  })
  it('maps api handles to display names', () => {
    expect(parseMentions('@k(api) please', H)).toEqual(['k (api)'])
    expect(parseMentions('@k(api) and @k', H)).toEqual(['k (api)', 'k'])
  })
  it('ignores unknown handles, emails and longer words', () => {
    expect(parseMentions('@bob hi', H)).toEqual([])
    expect(parseMentions('mail me: me@ann.com', H)).toEqual([])
    expect(parseMentions('@annabel', H)).toEqual([])
  })
  it('ends at punctuation, and at a sentence-final dot', () => {
    expect(parseMentions('(@ann) ok? @k! thanks @ann.', H)).toEqual(['ann', 'k'])
    expect(parseMentions('@ann.smith.', H)).toEqual(['ann.smith'])
    expect(parseMentions('@ann.smith', ['@ann'])).toEqual([])
  })
  it('is case-insensitive', () => {
    expect(parseMentions('@ANN', H)).toEqual(['ann'])
  })
  it('splits into segments that rejoin to the text', () => {
    const segs = splitMentions('hi @ann, and @k(api)!', H)
    expect(segs.map((s) => s.text).join('')).toBe('hi @ann, and @k(api)!')
    expect(segs.filter((s) => s.mention).map((s) => s.mention)).toEqual(['ann', 'k (api)'])
  })
  it('helpers', () => {
    expect(apiName('k')).toBe('k (api)')
    expect(mentionHandle('k (api)')).toBe('@k(api)')
    expect(mentionHandle('k')).toBe('@k')
    expect(handleName('@k(api)')).toBe('k (api)')
  })
})
