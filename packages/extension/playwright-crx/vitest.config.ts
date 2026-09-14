import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@recorder': path.resolve(__dirname, 'vendor/playwright-recorder'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
})
