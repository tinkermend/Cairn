import swc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['src/**/*.spec.ts'],
    // 集成测试的库前置条件：连不上就整包失败，不静默少跑一半
    globalSetup: ['./vitest.global-setup.mts'],
  },
  // NestJS 依赖 emitDecoratorMetadata，esbuild 不支持，需要 SWC 转译
  plugins: [swc.vite({ module: { type: 'es6' } })],
})
