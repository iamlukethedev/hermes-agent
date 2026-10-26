import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Resolve from this file, not the shell's cwd. esbuild is already lockfile-pinned
// through the workspace's Vite dependency; this build adds no npm dependency.
const root = fileURLToPath(new URL('../../', import.meta.url))
await build({
  absWorkingDir: root,
  entryPoints: ['web/grok-voice/main.ts'],
  outfile: 'web/grok-voice/dist/client.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  logLevel: 'info'
})
