import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('config', () => {
  it('needs no secret behind a public URL (a leftover SESSION_SECRET is ignored)', () => {
    expect(loadConfig({ PUBLIC_URL: 'https://wrongbad.com/mobdaw' }).basePath).toBe('/mobdaw')
    expect(loadConfig({ PUBLIC_URL: 'https://wrongbad.com/mobdaw', SESSION_SECRET: 'x' })).not.toHaveProperty('sessionSecret')
    expect(loadConfig({ PUBLIC_URL: 'http://localhost:5173' }).basePath).toBe('')
  })
})
