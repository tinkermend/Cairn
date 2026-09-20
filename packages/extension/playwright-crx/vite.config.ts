import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { demonstrationCapturePlugin } from './capture-plugin'

const root = path.dirname(fileURLToPath(import.meta.url))

/** npm 包里残留的 monorepo 相对 require，Chrome 扩展里不会走到这些分支。 */
function stubPlaywrightCrxHoles(): Plugin {
  return {
    name: 'stub-playwright-crx-holes',
    resolveId(id, importer) {
      if (!importer?.includes('playwright-crx')) return
      if (id === '../playwright' || id === './bidiOverCdp') return `\0stub:${id}`
    },
    load(id) {
      if (id === '\0stub:../playwright') {
        return 'export function createPlaywright() { throw new Error("playwright-crx monorepo stub") }\nexport default {}'
      }
      if (id === '\0stub:./bidiOverCdp') {
        return 'export async function connectBidiOverCdp() { throw new Error("bidiOverCdp not bundled") }'
      }
    },
  }
}

export default defineConfig({
  plugins: [stubPlaywrightCrxHoles(), demonstrationCapturePlugin()],
  resolve: {
    alias: {
      '@isomorphic': path.resolve(root, 'vendor/playwright-isomorphic'),
      '@protocol': path.resolve(root, 'vendor/playwright-protocol'),
      '@web': path.resolve(root, 'vendor/playwright-web'),
      '@recorder': path.resolve(root, 'vendor/playwright-recorder'),
      '@cairn/design-tokens': path.resolve(root, '../../../docs/design/front/tokens.css'),
    },
  },
  build: {
    minify: false,
    chunkSizeWarningLimit: 10240,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: path.resolve(root, 'index.html'),
        background: path.resolve(root, 'src/background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
})
