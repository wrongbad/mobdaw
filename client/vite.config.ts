/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig(({ command }) => ({
  plugins: [solid()],
  // Production is served under wrongbad.com/mobdaw/ (Caddy strips the prefix); dev stays at the root.
  // (vite-plugin-solid would default the tests to jsdom; the pure ones stay on node, a DOM test says `// @vitest-environment jsdom`)
  test: { environment: 'node' },
  base: command === 'build' ? '/mobdaw/' : '/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/collab': { target: 'ws://localhost:8787', ws: true },
    },
  },
}))
