import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readOverviewAnalytics, runReadScope, type TargetScope } from '@cairn/db'
import type { OverviewAnalyticsQueryParsed, OverviewAnalyticsResponse } from '@cairn/shared'
import { OverviewService } from './overview.service'

vi.mock('@cairn/db', () => ({
  runReadScope: vi.fn(),
  readOverviewAnalytics: vi.fn(),
}))

const query: OverviewAnalyticsQueryParsed = { range: '7d' }

function payload(mark: string): OverviewAnalyticsResponse {
  return { summary: { totalRuns: mark.length } } as OverviewAnalyticsResponse
}

describe('OverviewService 缓存按可见目标隔离', () => {
  const service = new OverviewService({} as never)

  beforeEach(() => {
    vi.mocked(runReadScope).mockReset()
    vi.mocked(readOverviewAnalytics).mockReset()
  })

  function scopeFor(actorId: string): TargetScope {
    if (actorId === 'fleet') return { all: true, ids: [] }
    if (actorId === 'empty' || actorId === 'empty-2') return { all: false, ids: [] }
    if (actorId === 'reversed') return { all: false, ids: ['target-b', 'target-a'] }
    if (actorId === 'other') return { all: false, ids: ['target-c'] }
    return { all: false, ids: ['target-a', 'target-b'] }
  }

  it('相同可见集合共用结果，不同集合和全量范围互不串号', async () => {
    vi.mocked(runReadScope).mockImplementation(async (_handle, actorId: string) => scopeFor(actorId))
    vi.mocked(readOverviewAnalytics).mockImplementation(async (_handle, _query, scope: TargetScope) =>
      payload(scope.all ? '*' : [...scope.ids].sort().join(',')),
    )

    const first = await service.analytics(query, 'restricted')
    const sameSet = await service.analytics(query, 'reversed')
    const fleet = await service.analytics(query, 'fleet')
    const other = await service.analytics(query, 'other')
    const again = await service.analytics(query, 'restricted')

    expect(sameSet).toEqual(first)
    expect(again).toEqual(first)
    expect(fleet).not.toEqual(first)
    expect(other).not.toEqual(first)
    expect(readOverviewAnalytics).toHaveBeenCalledTimes(3)
  })

  it('指定 targetId 与省略 targetId 不共用缓存', async () => {
    vi.mocked(runReadScope).mockResolvedValue({ all: false, ids: ['target-a'] })
    vi.mocked(readOverviewAnalytics).mockImplementation(async (_handle, next: OverviewAnalyticsQueryParsed) =>
      payload(next.targetId ?? 'all-visible'),
    )

    const wide = await service.analytics(query, 'restricted')
    const narrow = await service.analytics({ range: '7d', targetId: 'target-a' }, 'restricted')
    expect(narrow).not.toEqual(wide)
    expect(readOverviewAnalytics).toHaveBeenCalledTimes(2)
  })

  it('空范围的在途请求合并为一次查询', async () => {
    let release: (value: OverviewAnalyticsResponse) => void = () => {}
    const gate = new Promise<OverviewAnalyticsResponse>((resolve) => {
      release = resolve
    })
    vi.mocked(runReadScope).mockImplementation(async (_handle, actorId: string) => scopeFor(actorId))
    vi.mocked(readOverviewAnalytics).mockReturnValue(gate)

    const first = service.analytics(query, 'empty')
    const second = service.analytics(query, 'empty-2')
    await vi.waitFor(() => expect(readOverviewAnalytics).toHaveBeenCalledTimes(1))
    const body = payload('empty')
    release(body)
    await expect(first).resolves.toBe(body)
    await expect(second).resolves.toBe(body)
  })
})
