import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { demonstrationCapturePlugin } from '../../capture-plugin'

function patchedRecorder(): string {
  const lib = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/playwright-crx/lib')
  const path = readdirSync(lib)
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => resolve(lib, file))
    .find((file) => readFileSync(file, 'utf8').includes('async _createActionInContext(frame, action)'))
  if (!path) throw new Error('playwright-crx recorder module not found')
  const transform = demonstrationCapturePlugin().transform as (code: string, id: string) => { code: string } | undefined
  const patched = transform(readFileSync(path, 'utf8'), path)?.code
  if (!patched) throw new Error('playwright-crx recorder patch not installed')
  return patched
}

describe('playwright-crx capture seam', () => {
  it('patches real upstream actions and standalone navigation', () => {
    const patched = patchedRecorder()
    expect(patched).toContain('globalThis.__cairnCaptureBegin?.(frame, context, \'perform\')')
    expect(patched).toContain('globalThis.__cairnCaptureBegin?.(frame, context, \'record\')')
    expect(patched).toContain('globalThis.__cairnCaptureStandalone?.(actionInContext)')
    expect(patched).toContain('if (actionInContext.action.name === "closePage") return;')
    expect(patched).toContain('this._enabled && ["openPage", "navigate"].includes(actionInContext.action.name)')
    expect(patched!.indexOf('if (actionInContext.action.name === "closePage") return;'))
      .toBeLessThan(patched!.indexOf('globalThis.__cairnCaptureStandalone?.(actionInContext)'))
    expect(patched?.match(/globalThis\.__cairnCaptureStandalone\?\.\(actionInContext\)/g)).toHaveLength(1)
  })

  it('derives a selector on pointerdown without mousemove and lets unknown targets receive native clicks', () => {
    const patched = patchedRecorder()
    const sourceMarker = 'const source$2 = '
    const sourceAt = patched.indexOf(sourceMarker)
    const sourceEnd = patched.indexOf('\n', sourceAt)
    const injected = runInNewContext(patched.slice(sourceAt + sourceMarker.length, sourceEnd - 1)) as string
    const start = injected.indexOf('var RecordActionTool = class {')
    const end = injected.indexOf('var TextAssertionTool = class {', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    class MouseEventMock {
      type = 'click'
      button = 0
      detail = 1
      which = 1
      defaultPrevented = false
      preventDefault() { this.defaultPrevented = true }
      stopPropagation() {}
      stopImmediatePropagation() {}
    }
    const RecordActionTool = runInNewContext(`${injected.slice(start, end)}\nRecordActionTool`, {
      MouseEvent: MouseEventMock,
      PointerEvent: MouseEventMock,
      KeyboardEvent: class {},
      HighlightColors: { action: 'red' },
      consumeEvent: (event: MouseEventMock) => event.preventDefault(),
      isRangeInput: () => false,
      asCheckbox: () => null,
      positionForEvent: () => undefined,
      buttonForEvent: () => 'left',
      modifiersForEvent: () => 0,
    }) as new (recorder: unknown) => {
      onPointerDown(event: MouseEventMock): void
      onClick(event: MouseEventMock): void
      _pendingClickAction?: { action: { selector: string } }
    }
    const target = { nodeName: 'BUTTON', isConnected: true }
    function tool(selector: string | null) {
      return new RecordActionTool({
        deepEventTarget: () => target,
        state: { testIdAttributeName: 'data-testid' },
        injectedScript: {
          generateSelector: () => ({ selector, elements: [target] }),
          utils: { builtins: { setTimeout: () => 1 } },
        },
        updateHighlight: () => {},
      })
    }
    const known = tool('css=button')
    const knownEvent = new MouseEventMock()
    known.onPointerDown(knownEvent)
    known.onClick(knownEvent)
    expect(knownEvent.defaultPrevented).toBe(true)
    expect(known._pendingClickAction?.action.selector).toBe('css=button')

    const unknown = tool(null)
    const unknownEvent = new MouseEventMock()
    unknown.onPointerDown(unknownEvent)
    unknown.onClick(unknownEvent)
    expect(unknownEvent.defaultPrevented).toBe(false)
    expect(unknown._pendingClickAction).toBeUndefined()
  })
})
