import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { crxLifecyclePlugin } from '../../../crx-lifecycle-plugin'

describe('playwright-crx 0.15.0 lifecycle seam', () => {
  it('failed Page cleanup releases debugger and always closes its context', () => {
    const lib = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/playwright-crx/lib')
    const path = readdirSync(lib)
      .filter(file => file.endsWith('.mjs'))
      .map(file => resolve(lib, file))
      .find(file => readFileSync(file, 'utf8').includes('async _doDetach(targetId)'))
    if (!path) throw new Error('playwright-crx application module not found')
    const original = readFileSync(path, 'utf8')
    const transform = crxLifecyclePlugin().transform as (code: string, id: string) => { code: string } | undefined
    const patched = transform(original, path)?.code
    expect(patched).toContain('if (!targetId || !this._transport.getTabId(targetId))')
    expect(patched).toContain('if (pageOrError instanceof Error) {\n      await this._transport.detach(targetId);')
    expect(patched).toContain('} finally {\n      await this._context.close({});\n    }')
    expect(patched?.match(/await this\._context\.close\(\{\}\);/g)).toHaveLength(1)
  })
  it('retires the previous injected recorder before a second attach in the same document', async () => {
    const lib = resolve(dirname(fileURLToPath(import.meta.url)), '../../../node_modules/playwright-crx/lib')
    const path = readdirSync(lib).filter(file => file.endsWith('.mjs')).map(file => resolve(lib, file)).find(file => readFileSync(file, 'utf8').includes('async _doDetach(targetId)'))!
    const transform = crxLifecyclePlugin().transform as (code: string, id: string) => { code: string }
    const patched = transform(readFileSync(path, 'utf8'), path).code
    const marker = 'const source$2 = '
    const at = patched.indexOf(marker)
    const injected = runInNewContext(patched.slice(at + marker.length, patched.indexOf('\n', at) - 1)) as string
    const start = injected.indexOf('var PollingRecorder = class {')
    const end = injected.indexOf('var pollingRecorder_default = PollingRecorder;', start)
    const instances: Array<{ uninstall: number; install: number }> = []
    const PollingRecorder = runInNewContext(`${injected.slice(start, end)}\nPollingRecorder`, {
      Recorder: class {
        injectedScript: unknown
        document: unknown
        counts = { uninstall: 0, install: 0 }
        constructor(injectedScript: { window: unknown }) {
          this.injectedScript = injectedScript
          this.document = { defaultView: injectedScript.window }
          instances.push(this.counts)
        }
        uninstall() { this.counts.uninstall++ }
        installListeners() { this.counts.install++ }
        setUIState() {}
      },
    }) as new (injectedScript: unknown) => unknown
    const callbacks: Array<() => void> = []
    const cleared: number[] = []
    let scheduled = 0
    const window = { __pw_recorderState: async () => ({ mode: 'recording' }) } as Record<string, unknown>
    const injectedScript = { window, onGlobalListenersRemoved: { add: (callback: () => void) => callbacks.push(callback) }, utils: { builtins: { setTimeout: () => { scheduled++; return 7 }, clearTimeout: (id: number) => cleared.push(id) } } }
    new PollingRecorder(injectedScript)
    await vi.waitFor(() => expect(scheduled).toBe(1))
    new PollingRecorder(injectedScript)
    await Promise.resolve()
    expect(instances[0]).toEqual({ uninstall: 1, install: 0 })
    expect(cleared).toContain(7)
    callbacks[0]!()
    expect(instances[0]!.install).toBe(0)
    expect(instances[1]!.uninstall).toBe(0)
    ;(window.__pw_uninstall as () => void)()
    expect(instances[1]!.uninstall).toBe(1)
  })
})
