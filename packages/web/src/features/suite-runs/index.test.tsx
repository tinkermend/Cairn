import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { SuiteRunListResponse, SuiteRunSummaryDto } from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { SuiteRunsPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchSuiteRuns: vi.fn(),
  fetchTargets: vi.fn().mockResolvedValue({ items: [] }),
}))

const navigateMock = vi.fn()

vi.mock('@/lib/suites-api', () => ({
  fetchSuiteRuns: mocks.fetchSuiteRuns,
}))

vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
  fetchTarget: vi.fn(),
  fetchTargetAccounts: vi.fn().mockResolvedValue({ items: [] }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigateMock,
    Link: ({ children, to, search, onClick, ...props }: any) => {
      const searchStr = search ? '?' + new URLSearchParams(search).toString() : ''
      return (
        <a
          href={`${to}${searchStr}`}
          onClick={(e) => {
            onClick?.(e)
          }}
          {...props}
        >
          {children}
        </a>
      )
    },
  }
})

function summary(overrides: Partial<SuiteRunSummaryDto> = {}): SuiteRunSummaryDto {
  return {
    id: 'sr-11111111-1111-4111-8111-111111111111',
    suiteId: 'st-22222222-2222-4222-8222-222222222222',
    suiteVersionId: 'sv-33333333-3333-4333-8333-333333333333',
    suiteName: '核心业务链路巡检',
    targetId: 'tgt-44444444-4444-4444-8444-444444444444',
    status: 'COMPLETED',
    verdict: 'all_pass',
    stopReason: null,
    concurrencyLimit: 2,
    failurePolicy: 'continue',
    startedAt: '2026-09-27T01:00:00.000Z',
    finishedAt: '2026-09-27T01:05:00.000Z',
    wallClockMs: 300000,
    childDurationMs: 450000,
    counts: {
      planned: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      pending: 0,
      active: 0,
    },
    revision: 1,
    eventSeq: 5,
    readAt: '2026-09-27T01:05:00.000Z',
    createdAt: '2026-09-27T01:00:00.000Z',
    plannedCount: 2,
    reason: null,
    ...overrides,
  }
}

const listResponse: SuiteRunListResponse = {
  items: [summary()],
  nextCursor: undefined,
}

function signIn(permissions: string[]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试员',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <SuiteRunsPage />
    </QueryClientProvider>
  )
}

describe('SuiteRunsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    navigateMock.mockReset()
    mocks.fetchSuiteRuns.mockResolvedValue(listResponse)
    mocks.fetchTargets.mockResolvedValue({
      items: [
        { id: 'tgt-1', name: '演示商城' },
        { id: 'tgt-2', name: '运营后台' },
      ],
    })
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('展示完整的 5 个运行记录导航标签页且场景集运行处于选中状态', async () => {
    signIn(['suite:read', 'run:read', 'report:read', 'run:delete', 'target:read'])
    const screen = await renderPage()

    // 5 个标签页均应存在
    await expect.element(screen.getByRole('tab', { name: '独立运行' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '场景集运行' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '交付报告' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '材料检索' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '留存与清理' })).toBeInTheDocument()

    // 场景集运行页签应处于激活状态
    const activeTab = screen.getByRole('tab', { name: '场景集运行' })
    expect(activeTab.element().getAttribute('data-state')).toBe('active')

    // 独立运行与其他标签应指向对应 /runs 路径
    const runsLink = screen.getByRole('tab', { name: '独立运行' })
    expect(runsLink.element().getAttribute('href')).toBe('/runs')

    const reportsLink = screen.getByRole('tab', { name: '交付报告' })
    expect(reportsLink.element().getAttribute('href')).toBe('/runs?view=reports')

    const materialsLink = screen.getByRole('tab', { name: '材料检索' })
    expect(materialsLink.element().getAttribute('href')).toBe('/runs?view=materials')

    const retentionLink = screen.getByRole('tab', { name: '留存与清理' })
    expect(retentionLink.element().getAttribute('href')).toBe('/runs?view=retention')
  })

  it('缺少 report:read 权限时隐藏交付报告标签页', async () => {
    signIn(['suite:read', 'run:read', 'run:delete'])
    const screen = await renderPage()

    await expect.element(screen.getByRole('tab', { name: '独立运行' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '场景集运行' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '材料检索' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '留存与清理' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '交付报告' }).elements()).toHaveLength(0)
  })

  it('缺少 run:delete 权限时隐藏留存与清理标签页', async () => {
    signIn(['suite:read', 'run:read', 'report:read'])
    const screen = await renderPage()

    await expect.element(screen.getByRole('tab', { name: '独立运行' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '场景集运行' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '交付报告' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '材料检索' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '留存与清理' }).elements()).toHaveLength(0)
  })
})
