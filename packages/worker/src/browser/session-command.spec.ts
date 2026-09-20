import { describe, expect, it, vi } from 'vitest'
import { adoptPage, closeRunPage } from './session-command'
import { emptyLive } from './session-live'

function stubPage(url: string) {
  const page = {
    closed: false,
    isClosed() {
      return this.closed
    },
    url: () => url,
    close: vi.fn(async () => {
      page.closed = true
    }),
    on: vi.fn(),
    off: vi.fn(),
  }
  return page
}

describe('adoptPage 录像切换可等待', () => {
  it('把 retarget 挂到页面条目上供交接等待', async () => {
    const page = stubPage('https://app.example/popup')
    const live = emptyLive({ basePage: stubPage('about:blank') } as never, 'sess', 2)
    const retarget = vi.fn(async () => {})
    const ctx = {
      retargetVideoForLease: retarget,
    }
    const entry = adoptPage.call(ctx, live, 'run-1', page as never, 'popup', 'lease-1')
    expect(entry.retarget).toBeDefined()
    await entry.retarget
    expect(retarget).toHaveBeenCalled()
    expect(live.currentPageIdByLease.get('lease-1')).toBe(entry.pageId)
    expect(entry.documentEpoch).toBe(0)
  })
})

describe('closeRunPage 保留 last page', () => {
  it('NEW_PAGE 释放后保留可用页，并关掉上一张', async () => {
    const base = stubPage('about:blank')
    const first = stubPage('https://app.example/one')
    const second = stubPage('https://app.example/two')
    const live = emptyLive({ basePage: base } as never, 'sess')
    live.runPages.set('lease-1', first as never)
    live.runPageIds.add('lease-1')
    const ctx = {
      leaseToSession: new Map([
        ['lease-1', 'sess'],
        ['lease-2', 'sess'],
      ]),
      leaseToRun: new Map([
        ['lease-1', 'run-1'],
        ['lease-2', 'run-2'],
      ]),
      lives: new Map([['sess', live]]),
      adoptPage,
    }
    await closeRunPage.call(ctx, 'lease-1')
    expect(first.closed).toBe(false)
    expect(live.lastPage).toBe(first)
    expect(live.runPages.has('lease-1')).toBe(false)
    expect([...live.pages.values()].some((entry) => entry.runId === 'sess' && entry.page === first)).toBe(true)

    live.runPages.set('lease-2', second as never)
    live.runPageIds.add('lease-2')
    await closeRunPage.call(ctx, 'lease-2')
    expect(first.closed).toBe(true)
    expect(second.closed).toBe(false)
    expect(live.lastPage).toBe(second)
    expect(base.closed).toBe(false)
  })

  it('about:blank 不保留，且不关 basePage', async () => {
    const base = stubPage('about:blank')
    const blank = stubPage('about:blank')
    const live = emptyLive({ basePage: base } as never, 'sess')
    live.runPages.set('lease-1', blank as never)
    const ctx = {
      leaseToSession: new Map([['lease-1', 'sess']]),
      leaseToRun: new Map([['lease-1', 'run-1']]),
      lives: new Map([['sess', live]]),
      adoptPage,
    }
    await closeRunPage.call(ctx, 'lease-1')
    expect(blank.closed).toBe(true)
    expect(base.closed).toBe(false)
    expect(live.lastPage).toBeUndefined()
  })
})
