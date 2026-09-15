/// <reference types="vitest/config" />
import { existsSync } from 'node:fs'
import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { playwright } from '@vitest/browser-playwright'

const repoEnv = path.resolve(import.meta.dirname, '../../.env')
if (existsSync(repoEnv)) process.loadEnvFile(repoEnv)

const API_ORIGIN = process.env.CAIRN_API_ORIGIN ?? 'http://127.0.0.1:3030'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  optimizeDeps: {
    include: [
      '@radix-ui/react-tabs',
      '@radix-ui/react-switch',
      'react-day-picker',
      'react-day-picker/locale',
      'date-fns',
    ],
  },
  server: {
    fs: {
      allow: [path.resolve(import.meta.dirname, '../..')],
    },
    proxy: {
      // 开发期把后端调用转发到本地 api，避免跨域并让前端代码里只写相对路径。
      // 画面 SSE 必须禁用代理超时，否则首帧会被缓冲到连接结束，试跑页一直空白。
      '/api': { target: API_ORIGIN, changeOrigin: true, timeout: 0, proxyTimeout: 0 },
      '/health': { target: API_ORIGIN, changeOrigin: true },
    },
  },
  test: {
    silent: 'passed-only',
    unstubEnvs: true,
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    coverage: {
      // include: ['src/**/*.{js,jsx,ts,tsx}'], // Uncomment to expand the report to all src/**/* so untested modules appear as 0% coverage.
      exclude: [
        'src/components/ui/**',
        'src/assets/**',
        'src/tanstack-table.d.ts',
        'src/routeTree.gen.ts',
        'src/test-utils/**',
        'src/routes/**',
      ],
    },
  },
})
