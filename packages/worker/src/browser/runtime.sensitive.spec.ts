import { describe, expect, it, vi } from 'vitest'
import type { Page } from 'playwright'
import { pageHasSensitiveContent } from './runtime.js'

function pageWithLocators(input: {
  closed?: boolean
  counts?: Record<string, number>
  visible?: Record<string, boolean>
  rejectCount?: string
  rejectVisibility?: string
}): Page {
  return {
    isClosed: () => input.closed ?? false,
    locator: vi.fn((selector: string) => ({
      count: async () => {
        if (selector === input.rejectCount) throw new Error('inspection failed')
        return input.counts?.[selector] ?? 0
      },
      nth: () => ({
        isVisible: async () => {
          if (selector === input.rejectVisibility) throw new Error('visibility failed')
          return input.visible?.[selector] ?? false
        },
      }),
    })),
  } as unknown as Page
}

describe('screenshot sensitive-content inspection', () => {
  it('marks visible password and configured sensitive selectors', async () => {
    expect(await pageHasSensitiveContent(pageWithLocators({
      counts: { 'input[type="password"]': 1 },
      visible: { 'input[type="password"]': true },
    }))).toBe(true)
    expect(await pageHasSensitiveContent(pageWithLocators({
      counts: { '.secret': 1 }, visible: { '.secret': true },
    }), ['.secret'])).toBe(true)
  })

  it('keeps an inspected page without matching selectors unflagged', async () => {
    expect(await pageHasSensitiveContent(pageWithLocators({ counts: {} }), ['.secret'])).toBe(false)
  })

  it('fails closed when the page is gone or a selector cannot be inspected', async () => {
    expect(await pageHasSensitiveContent(pageWithLocators({ closed: true }))).toBe(true)
    expect(await pageHasSensitiveContent(pageWithLocators({
      rejectCount: 'input[type="password"]',
    }))).toBe(true)
    expect(await pageHasSensitiveContent(pageWithLocators({
      counts: { '.secret': 1 }, rejectVisibility: '.secret',
    }), ['.secret'])).toBe(true)
  })
})
