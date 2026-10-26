import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  test: {
    include: ['apps/shared/src/grok-voice/*.test.ts', 'web/src/lib/grok-voice.test.ts'],
    environment: 'node',
    testTimeout: 15_000
  }
})
