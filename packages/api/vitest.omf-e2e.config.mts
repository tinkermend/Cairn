import { resolve } from 'node:path'
import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

// Cross-application fixtures live outside either application dependency boundary.
export default defineConfig({
  resolve: { dedupe: ['@nestjs/common', '@nestjs/core', '@nestjs/testing', '@cairn/db', '@cairn/shared', '@cairn/secret', 'supertest'] },
  test: {
    root: import.meta.dirname,
    include: [resolve(import.meta.dirname, '../../tests/operational-map/*.e2e.spec.ts')],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    globalSetup: ['./vitest.global-setup.mts'],
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
