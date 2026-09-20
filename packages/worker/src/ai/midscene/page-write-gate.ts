import type { Page } from 'playwright'
import type { ActionGate } from './action-gate.js'

/** SDK actions contain multiple awaited writes. Check ownership before each browser call. */
export function gatePageWrites(page: Page, gate: ActionGate): Page {
  const cache = new WeakMap<object, object>()
  const checkedMethods = new Set([
    'click',
    'dblclick',
    'tap',
    'fill',
    'clear',
    'type',
    'press',
    'pressSequentially',
    'insertText',
    'down',
    'up',
    'move',
    'wheel',
    'check',
    'uncheck',
    'setChecked',
    'selectOption',
    'setInputFiles',
    'focus',
    'blur',
    'dragTo',
    'goto',
    'reload',
    'goBack',
    'goForward',
    'evaluate',
    'evaluateHandle',
    'dispatchEvent',
  ])
  const nestedMethods = new Set([
    'context',
    'mainFrame',
    'frame',
    'frames',
    'locator',
    'getByRole',
    'getByText',
    'getByLabel',
    'getByPlaceholder',
    'getByTestId',
    'getByTitle',
    'getByAltText',
    'frameLocator',
    'first',
    'last',
    'nth',
    'filter',
    'and',
    'or',
    'newCDPSession',
  ])
  function wrap<T>(value: T): T {
    if (Array.isArray(value)) return value.map(wrap) as T
    if (!value || typeof value !== 'object') return value
    const existing = cache.get(value)
    if (existing) return existing as T
    const proxy = new Proxy(value, {
      get(target, prop) {
        const member = Reflect.get(target, prop, target)
        if (prop === 'mouse' || prop === 'keyboard') return wrap(member)
        if (typeof member !== 'function') return member
        return (...args: unknown[]) => {
          const name = String(prop)
          // clearInput uses CDP Input.dispatchKeyEvent between clicking and typing.
          if (
            checkedMethods.has(name) ||
            (name === 'send' && /^(Input\.|Runtime\.evaluate)/.test(String(args[0])))
          ) {
            gate.assertAllowed('action')
          }
          const result = Reflect.apply(member, target, args)
          if (!nestedMethods.has(name)) return result
          return result instanceof Promise ? result.then(wrap) : wrap(result)
        }
      },
    })
    cache.set(value, proxy)
    return proxy
  }
  return wrap(page)
}
