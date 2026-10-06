import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('config', () => {
  it('refuses dev auth behind a public URL', () => {
    expect(() => loadConfig({ AUTH_MODE: 'dev', PUBLIC_URL: 'https://mobdaw.example.com' })).toThrow(/only allowed/)
    expect(loadConfig({ AUTH_MODE: 'dev', PUBLIC_URL: 'http://localhost:5173' }).authMode).toBe('dev')
  })
})
