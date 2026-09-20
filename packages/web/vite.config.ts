/// <reference types="vitest/config" />
import { existsSync } from 'node:fs'
import path from 'path'
import { defineConfig, type Logger, type Plugin, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { playwright } from '@vitest/browser-playwright'

const repoEnv = path.resolve(import.meta.dirname, '../../.env')
if (existsSync(repoEnv)) process.loadEnvFile(repoEnv)

const API_ORIGIN = process.env.CAIRN_API_ORIGIN ?? 'http://127.0.0.1:3030'

/** Vite 默认只在代理失败时打日志。开发期 API 重启后补一条恢复日志。 */
function apiProxyRecovery(): {
  plugin: Plugin
  configure: NonNullable<ProxyOptions['configure']>
} {
  let logger: Logger | undefined
  let down = false

  return {
    plugin: {
      name: 'cairn-api-proxy-recovery',
      apply: 'serve',
      configResolved(config) {
        logger = config.logger
      },
    },
    configure(proxy) {
      proxy.on('error', () => {
        down = true
      })
      proxy.on('proxyRes', (_proxyRes, req) => {
        if (!down) return
        down = false
        logger?.info(`http proxy recovered: ${req.url ?? '/'}`, { timestamp: true })
      })
    },
  }
}

const apiProxyRecoveryHooks = apiProxyRecovery()

const proxyConfig = {
  // 开发与预览期把后端调用转发到本地 api，避免跨域并让前端代码里只写相对路径。
  // 画面 SSE 必须禁用代理超时，否则首帧会被缓冲到连接结束，试跑页一直空白。
  '/api': {
    target: API_ORIGIN,
    changeOrigin: true,
    timeout: 0,
    proxyTimeout: 0,
    configure: apiProxyRecoveryHooks.configure,
  },
  '/health': {
    target: API_ORIGIN,
    changeOrigin: true,
    configure: apiProxyRecoveryHooks.configure,
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    apiProxyRecoveryHooks.plugin,
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
      'recharts',
    ],
  },
  server: {
    host: '127.0.0.1',
    fs: {
      allow: [path.resolve(import.meta.dirname, '../..')],
    },
    proxy: proxyConfig,
  },
  preview: {
    proxy: proxyConfig,
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
