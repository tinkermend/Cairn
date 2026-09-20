import { describe, expect, it } from 'vitest'
import { chromium, type Page } from 'playwright'
import { ActionGate } from './action-gate.js'
import { gatePageWrites } from './page-write-gate.js'

describe('atomic action browser write gate', () => {
  it('checks every asynchronous write, including CDP and nested locators', async () => {
    const writes: string[] = []; const stop = new AbortController(); const gate = new ActionGate(stop.signal)
    const page = { mouse: { click: async () => writes.push('click') }, keyboard: { type: async () => writes.push('type') }, locator: () => ({ first: () => ({ fill: async () => writes.push('fill') }) }), context: () => ({ newCDPSession: async () => ({ send: async () => writes.push('cdp') }) }) } as unknown as Page
    const guarded = gatePageWrites(page, gate)
    await guarded.mouse.click(1, 1)
    const cdp = await guarded.context().newCDPSession(guarded)
    stop.abort()
    expect(() => guarded.keyboard.type('forbidden')).toThrow(/ABORTED/)
    expect(() => guarded.locator('#a').first().fill('forbidden')).toThrow(/ABORTED/)
    expect(() => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' })).toThrow(/ABORTED/)
    expect(writes).toEqual(['click'])
  })
  it('uses a real page and CDP session; revoked ownership prevents partial-input continuation', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage(); await page.setContent('<input id="field" value="original"><button>submit</button>')
      const gate = new ActionGate(); const guarded = gatePageWrites(page, gate)
      await guarded.locator('#field').click()
      const cdp = await guarded.context().newCDPSession(guarded)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 })
      gate.markLeaseLost()
      expect(() => guarded.keyboard.insertText('forbidden')).toThrow(/LEASE_LOST/)
      expect(() => cdp.send('Input.insertText', { text: 'forbidden' })).toThrow(/LEASE_LOST/)
      expect(await page.locator('#field').inputValue()).toBe('original')
      await cdp.detach()
    } finally { await browser.close() }
  }, 20_000)
})
