import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  // Production is served under wrongbad.com/mobdaw/ (Caddy strips the prefix); dev stays at the root.
  base: command === 'build' ? '/mobdaw/' : '/',
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/collab': { target: 'ws://localhost:8787', ws: true },
    },
  },
}))
