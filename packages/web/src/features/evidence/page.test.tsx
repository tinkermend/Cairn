import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import type { EvidenceSearchResponse } from '@cairn/shared'
import { EvidencePage } from './page'

const search = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}))

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  fetchEvidenceSearch: vi.fn(),
  fetchEvidenceDetail: vi.fn(),
  fetchEvidenceRetentionSummary: vi.fn(),
  fetchEvidenceRetentionObjects: vi.fn(),
  fetchTargets: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  fetchScenarios: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  fetchTargetAccounts: vi.fn(async () => ({ items: [], nextCursor: undefined })),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useSearch: () => search.value,
    useNavigate: () => mocks.navigate,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={String(to)}>{children}</a>,
  }
})

vi.mock('@/lib/evidence-api', () => ({
  fetchEvidenceSearch: mocks.fetchEvidenceSearch,
  fetchEvidenceDetail: mocks.fetchEvidenceDetail,
  fetchEvidenceRetentionSummary: mocks.fetchEvidenceRetentionSummary,
  fetchEvidenceRetentionObjects: mocks.fetchEvidenceRetentionObjects,
}))

vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
  fetchTargetAccounts: mocks.fetchTargetAccounts,
}))

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
}))

vi.mock('@/hooks/use-permissions', () => ({
  useCan: () => false,
}))

const listed: EvidenceSearchResponse = {
  items: [
    {
      evidence: {
        schemaVersion: 1,
        id: '11111111-1111-4111-8111-111111111111',
        runId: '22222222-2222-4222-8222-222222222222',
        type: 'screenshot',
        status: 'available',
        createdAt: '2026-09-19T00:00:00.000Z',
      },
      targetId: '33333333-3333-4333-8333-333333333333',
      targetName: '目标甲',
      targetNameCurrent: '目标甲',
      targetDeleted: false,
      scenarioId: '44444444-4444-4444-8444-444444444444',
      scenarioName: '场景甲',
      scenarioNameCurrent: '场景甲',
      scenarioDeleted: false,
      scenarioVersionId: '55555555-5555-4555-8555-555555555555',
      scenarioVersionNo: 1,
      scenarioVersionKind: 'published',
      stepName: '登录',
      stepOrdinal: 0,
      attemptNo: 1,
      runStatus: 'FAILED',
      stepRunStatus: 'FAILED',
      attemptStatus: 'FAILED',
      outcomeStatus: 'FAIL',
      runEvidenceStatus: 'COMPLETE',
      displayStatus: 'available',
      displayStatusLabel: '可查看',
      filterBuckets: ['available'],
      overlayProtected: false,
      retainUntil: '2026-09-26T00:00:00.000Z',
      retainUntilUnknown: false,
      byteSize: 12,
      byteSizeUnknown: false,
      errorSummary: '账号被锁',
      objectLinked: true,
      reasonCode: null,
      reasonUnknown: false,
    },
  ],
  asOf: '2026-09-19T12:00:00.000Z',
  readAt: '2026-09-19T12:00:01.000Z',
  timeWindowLifted: false,
  sort: 'createdAt_desc',
  summary: { evidenceCount: 1, objectCount: 1, knownBytes: 12, unknownByteObjects: 0 },
}

describe('证据中心页', () => {
  it('展示结构化检索而不是关键词框', async () => {
    mocks.fetchEvidenceSearch.mockResolvedValue(listed)
    search.value = {}
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <EvidencePage />
      </QueryClientProvider>,
    )
    await expect.element(screen.getByRole('heading', { name: '证据与报告', exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('最近失败')).toBeInTheDocument()
    await expect.element(screen.getByText('目标甲')).toBeInTheDocument()
    await expect.element(screen.getByText('账号被锁')).toBeInTheDocument()
    await expect.element(screen.getByRole('textbox', { name: '运行 ID', exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('textbox', { name: '场景集 ID' })).toBeInTheDocument()
    await expect.element(screen.getByRole('textbox', { name: '步骤运行 ID' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '运行状态' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '步骤状态' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '业务结果' })).toBeInTheDocument()
    expect(screen.container.querySelector('input[type="search"]')).toBeNull()
  })

  it('留存页签把未知字节写成未知而不是 0', async () => {
    mocks.fetchEvidenceSearch.mockResolvedValue(listed)
    mocks.fetchEvidenceRetentionSummary.mockResolvedValue({
      asOf: '2026-09-19T12:00:00.000Z',
      readAt: '2026-09-19T12:00:01.000Z',
      accessible: {
        objectCount: 2,
        knownBytes: 12,
        unknownByteObjects: 1,
        expiringSoon: { objectCount: 0, knownBytes: 0, unknownByteObjects: 0 },
        pendingCleanup: { objectCount: 1, knownBytes: 0, unknownByteObjects: 1 },
        purgeFailed: 0,
        byTarget: [],
        byType: [],
      },
      deletedRunCleanup: {
        objectCount: 1,
        knownBytes: 4,
        unknownByteObjects: 0,
        pending: 1,
        failed: 0,
        inProgress: 0,
      },
      canListDeletedRunObjects: false,
    })
    mocks.fetchEvidenceRetentionObjects.mockResolvedValue({
      items: [],
      asOf: '2026-09-19T12:00:00.000Z',
      readAt: '2026-09-19T12:00:01.000Z',
      view: 'pending_cleanup',
      withheldDeletedRunItems: false,
    })
    search.value = { tab: 'retention' }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { getByText } = await render(
      <QueryClientProvider client={client}>
        <EvidencePage />
      </QueryClientProvider>,
    )
    await expect.element(getByText('1 个字节未知')).toBeInTheDocument()
    await expect.element(getByText(/已删除运行待清理/)).toBeInTheDocument()
    await expect.element(getByText(/需要 run:delete/)).toBeInTheDocument()
  })

  it('已生效筛选逐项可清除，清除一项只去掉那一项', async () => {
    mocks.fetchEvidenceSearch.mockResolvedValue(listed)
    mocks.navigate.mockClear()
    search.value = { asOf: listed.asOf, types: 'screenshot,trace', view: 'recent_failures', cursor: 'abc' }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <EvidencePage />
      </QueryClientProvider>,
    )
    const chips = screen.getByRole('list', { name: '已生效筛选' })
    await expect.element(chips).toBeInTheDocument()
    await expect.element(screen.getByText('类型：截图')).toBeInTheDocument()
    await expect.element(screen.getByText('类型：Trace')).toBeInTheDocument()
    await expect.element(screen.getByText('视图：最近失败')).toBeInTheDocument()

    await screen.getByRole('button', { name: '清除筛选：类型：截图' }).click()
    expect(mocks.navigate).toHaveBeenCalledTimes(1)
    const call = mocks.navigate.mock.calls[0]?.[0] as { search: Record<string, unknown> }
    expect(call.search.types).toBe('trace')
    expect(call.search.view).toBe('recent_failures')
    // 筛选变了，翻页位置要回到第一页
    expect(call.search.cursor).toBeUndefined()
  })

  it('没有筛选时不出现已生效筛选清单', async () => {
    mocks.fetchEvidenceSearch.mockResolvedValue(listed)
    search.value = {}
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <EvidencePage />
      </QueryClientProvider>,
    )
    await expect.element(screen.getByText('目标甲')).toBeInTheDocument()
    expect(screen.container.querySelector('ul[aria-label="已生效筛选"]')).toBeNull()
  })

  it('可选列默认不显示', async () => {
    mocks.fetchEvidenceSearch.mockResolvedValue(listed)
    search.value = { asOf: listed.asOf }
    const screen = await render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <EvidencePage />
      </QueryClientProvider>,
    )
    await expect.element(screen.getByText('目标甲')).toBeInTheDocument()
    const headers = [...screen.container.querySelectorAll('th')].map((th) => th.textContent)
    expect(headers).toContain('可用性')
    expect(headers).not.toContain('体积')
    expect(headers).not.toContain('对外发布')
  })

  it('按地址里的 columns 显示体积、到期、版本、对外发布', async () => {
    mocks.fetchEvidenceSearch.mockResolvedValue({
      ...listed,
      items: [{ ...listed.items[0]!, evidence: { ...listed.items[0]!.evidence, externalAccess: true } }],
    })
    search.value = { asOf: listed.asOf, columns: 'released,size,version,expires' }
    const screen = await render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <EvidencePage />
      </QueryClientProvider>,
    )
    await expect.element(screen.getByText('目标甲')).toBeInTheDocument()
    const headers = [...screen.container.querySelectorAll('th')].map((th) => th.textContent)
    // 顺序固定，不随地址里的书写顺序变化
    expect(headers.slice(-4)).toEqual(['体积', '到期时间', '场景版本', '对外发布'])
    const cells = [...screen.container.querySelectorAll('tbody td')].map((td) => td.textContent)
    expect(cells).toContain('12 B')
    expect(cells).toContain('v1')
    expect(cells).toContain('已对外发布')
  })

  it('切换可选列只改 columns，不重置翻页位置', async () => {
    mocks.fetchEvidenceSearch.mockResolvedValue(listed)
    mocks.navigate.mockClear()
    search.value = { asOf: listed.asOf, cursor: 'abc' }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const screen = await render(
      <QueryClientProvider client={client}>
        <EvidencePage />
      </QueryClientProvider>,
    )
    await screen.getByRole('button', { name: '显示列' }).click()
    await screen.getByRole('menuitemcheckbox', { name: '体积' }).click()
    const call = mocks.navigate.mock.calls[mocks.navigate.mock.calls.length - 1]?.[0] as { search: Record<string, unknown> }
    expect(call.search.columns).toBe('size')
    expect(call.search.cursor).toBe('abc')
  })
})
