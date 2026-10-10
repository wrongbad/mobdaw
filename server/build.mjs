// Precompile the server so production boots without tsx transpiling the whole tree on every start.
// Dependencies stay external (npm ci installs them on the server); the workspace-only @mobdaw/shared is bundled.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const { dependencies } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))
const external = Object.keys(dependencies).filter((d) => d !== '@mobdaw/shared')

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: [...external, ...external.map((d) => `${d}/*`)],
  sourcemap: 'linked',
  logLevel: 'warning',
})
