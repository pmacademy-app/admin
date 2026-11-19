import { defineConfig } from 'vitest/config'
import path from 'path'

// Copied from the web repo's vitest config. `node` stays the default; component tests opt in
// per file with a `@vitest-environment jsdom` docblock.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['lib/__tests__/**/*.test.ts', 'components/__tests__/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**/*'],
    pool: 'forks',
    maxWorkers: 2,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './'),
    },
  },
})
