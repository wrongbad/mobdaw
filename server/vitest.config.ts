import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 15000, env: { NODE_NO_WARNINGS: '1' } } })
