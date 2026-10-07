import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('config', () => {
  it('requires SESSION_SECRET behind a public URL', () => {
    expect(() => loadConfig({ PUBLIC_URL: 'https://wrongbad.com/mobdaw' })).toThrow(/SESSION_SECRET/)
    expect(loadConfig({ PUBLIC_URL: 'https://wrongbad.com/mobdaw', SESSION_SECRET: 'x' }).basePath).toBe('/mobdaw')
    expect(loadConfig({ PUBLIC_URL: 'http://localhost:5173' }).basePath).toBe('')
  })
})
