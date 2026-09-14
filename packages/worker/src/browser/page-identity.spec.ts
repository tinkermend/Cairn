import { describe, expect, it } from 'vitest'
import { createManagedPage, originAllowed, pickPopupHandoff } from './page-identity'

describe('popup handoff selection', () => {
  const page = { isClosed: () => false } as import('playwright').Page
  const closed = { isClosed: () => true } as import('playwright').Page

  it('拒绝零个、多个和越权来源，不取最后一个猜测', () => {
    expect(pickPopupHandoff([], ['https://app.example']).ok).toBe(false)
    expect(
      pickPopupHandoff(
        [
          { page, url: 'https://app.example/a' },
          { page, url: 'https://app.example/b' },
        ],
        ['https://app.example'],
      ),
    ).toMatchObject({ ok: false, code: 'PAGE_HANDOFF_AMBIGUOUS' })
    expect(
      pickPopupHandoff([{ page, url: 'https://evil.example' }], ['https://app.example']),
    ).toMatchObject({ ok: false, code: 'PAGE_HANDOFF_OUT_OF_SCOPE' })
    expect(pickPopupHandoff([{ page: closed, url: 'https://app.example' }], ['https://app.example'])).toMatchObject({
      ok: false,
      code: 'PAGE_HANDOFF_NO_POPUP',
    })
  })

  it('唯一允许来源则收养', () => {
    const chosen = pickPopupHandoff([{ page, url: 'https://app.example/ok' }], ['https://app.example'])
    expect(chosen).toEqual({ ok: true, page })
  })

  it('没有 Playwright 事件接口时仍能建立 PageRef', () => {
    const page = { isClosed: () => false } as import('playwright').Page
    const entry = createManagedPage({ page, runId: '00000000-0000-4000-8000-000000000099', kind: 'base' })
    expect(entry.documentEpoch).toBe(0)
    expect(entry.page).toBe(page)
  })

  it('origin 检查拒绝凭据和奇怪协议', () => {
    expect(originAllowed('https://user:pass@app.example', ['https://app.example'])).toBe(false)
    expect(originAllowed('https://app.example/path', ['https://app.example'])).toBe(true)
  })
})
