import { describe, expect, it, vi } from 'vitest'
import type { Page, Locator } from 'playwright'
import { readLocatorMany } from '../runtime.js'
import { executeOnPage } from '../surface.js'
import type { BrowserCommand } from '@cairn/shared'

describe('CFA-12: readLocatorMany 与确定性提取全部匹配', () => {
  it('readLocatorMany 支持按 text / attribute / value 提取全部匹配项', async () => {
    const el1 = {
      innerText: vi.fn().mockResolvedValue('Item 1'),
      getAttribute: vi.fn().mockResolvedValue('attr-1'),
      inputValue: vi.fn().mockResolvedValue('val-1'),
    } as unknown as Locator
    const el2 = {
      innerText: vi.fn().mockResolvedValue('Item 2'),
      getAttribute: vi.fn().mockResolvedValue('attr-2'),
      inputValue: vi.fn().mockResolvedValue('val-2'),
    } as unknown as Locator
    const locator = {
      all: vi.fn().mockResolvedValue([el1, el2]),
    } as unknown as Locator

    expect(await readLocatorMany(locator, 'text')).toEqual(['Item 1', 'Item 2'])
    expect(await readLocatorMany(locator, 'attribute', 'data-id')).toEqual(['attr-1', 'attr-2'])
    expect(await readLocatorMany(locator, 'value')).toEqual(['val-1', 'val-2'])
  })

  function createMockPage(itemTexts: string[]): Page {
    const elements = itemTexts.map((text) => ({
      innerText: vi.fn().mockResolvedValue(text),
      getAttribute: vi.fn().mockResolvedValue(''),
      inputValue: vi.fn().mockResolvedValue(text),
    }))
    const mockLocator = {
      count: vi.fn().mockResolvedValue(itemTexts.length),
      all: vi.fn().mockResolvedValue(elements),
      evaluate: vi.fn().mockResolvedValue(null),
    }
    const mockPage = {
      isClosed: () => false,
      url: () => 'https://example.test',
      context: () => ({ pages: () => [mockPage] }),
      mainFrame: () => mockPage,
      frames: () => [mockPage],
      locator: vi.fn().mockReturnValue(mockLocator),
      getByText: vi.fn().mockReturnValue(mockLocator),
      getByRole: vi.fn().mockReturnValue(mockLocator),
      getByLabel: vi.fn().mockReturnValue(mockLocator),
      getByTestId: vi.fn().mockReturnValue(mockLocator),
      evaluate: vi.fn().mockResolvedValue(true),
    } as unknown as Page
    return mockPage
  }

  it('0 项匹配时输出空列表与 count: 0', async () => {
    const page = createMockPage([])
    const command: BrowserCommand = {
      type: 'extract',
      target: { framePath: [], candidates: [{ by: 'css', value: '.row' }] },
      as: 'text',
      many: { maxItems: 10 },
      timeoutMs: 50,
    }
    const result = await executeOnPage(page, command)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('failed')
    expect(result.output).toEqual({ value: [], count: 0 })
  })

  it('N 项匹配正常返回列表与 count', async () => {
    const page = createMockPage(['A', 'B', 'C'])
    const command: BrowserCommand = {
      type: 'extract',
      target: { framePath: [], candidates: [{ by: 'css', value: '.row' }] },
      as: 'text',
      many: { maxItems: 10, minItems: 1 },
    }
    const result = await executeOnPage(page, command)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('failed')
    expect(result.output).toEqual({ value: ['A', 'B', 'C'], count: 3 })
  })

  it('匹配数超过 maxItems 报 EXTRACT_TOO_MANY', async () => {
    const page = createMockPage(['A', 'B', 'C'])
    const command: BrowserCommand = {
      type: 'extract',
      target: { framePath: [], candidates: [{ by: 'css', value: '.row' }] },
      as: 'text',
      many: { maxItems: 2 },
    }
    const result = await executeOnPage(page, command)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('EXTRACT_TOO_MANY')
    expect(result.error.safeMessage).toContain('实际匹配 3 项')
  })

  it('匹配数少于 minItems 报 EXTRACT_TOO_FEW', async () => {
    const page = createMockPage(['A'])
    const command: BrowserCommand = {
      type: 'extract',
      target: { framePath: [], candidates: [{ by: 'css', value: '.row' }] },
      as: 'text',
      many: { maxItems: 10, minItems: 2 },
    }
    const result = await executeOnPage(page, command)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected fail')
    expect(result.error.code).toBe('EXTRACT_TOO_FEW')
    expect(result.error.safeMessage).toContain('实际匹配 1 项')
  })
})
