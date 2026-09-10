import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: import.meta.dirname,
    // 显式收窄：默认 include 同样匹配 dist 下编译出来的 .test.js，
    // 测试结果不该取决于有没有先跑过构建
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    globalSetup: ['./vitest.global-setup.mts'],
  },
})
