import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: import.meta.dirname,
    // 显式收窄：默认 include 同样匹配 dist 下编译出来的 .test.js，
    // 测试结果不该取决于有没有先跑过构建
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    // beforeAll 里的 openIsolatedDb 要建库 + 跑全部迁移，实测常在 7s 上下；
    // vitest 默认 hookTimeout 是 10s，整包并行时越线就把文件判红。
    // 与 worker 用同一档预算，不让两个包对同一件事有两套上限。
    hookTimeout: 60_000,
    globalSetup: ['./vitest.global-setup.mts'],
  },
})
