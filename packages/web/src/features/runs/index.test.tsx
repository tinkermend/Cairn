import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunListResponse, RunSummaryDto } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { RunsPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchRuns: vi.fn(),
  cancelRun: vi.fn(),
  createRun: vi.fn(),
}))

vi.mock('@/lib/runs-api', () => mocks)
vi.mock('@/lib/scenarios-api', () => ({ fetchScenarios: vi.fn() }))
vi.mock('@/lib/targets-api', () => ({ fetchTargetAccounts: vi.fn() }))
vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({ children }: { children: React.ReactNode }) => <a href='#'>{children}</a>,
  }
})

function summary(overrides: Partial<RunSummaryDto>): RunSummaryDto {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    status: 'QUEUED',
    cancelRequested: false,
    targetId: '11111111-1111-4111-8111-111111111111',
    targetName: '演示商城',
    targetAccountId: null,
    targetAccountName: null,
    scenarioId: '33333333-3333-4333-8333-333333333333',
    scenarioName: '下单巡检',
    scenarioVersionId: '55555555-5555-4555-8555-555555555555',
    createdAt: '2026-09-11T02:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    lease: null,
    ...overrides,
  }
}

const list: RunListResponse = {
  items: [
    summary({}),
    summary({
      id: '44444444-4444-4444-8444-444444444445',
      status: 'SUCCEEDED',
      scenarioName: '登录巡检',
      startedAt: '2026-09-11T01:00:00.000Z',
      finishedAt: '2026-09-11T01:00:20.000Z',
    }),
  ],
}

function signIn(permissions: string[]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
  })
}

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RunsPage />
    </QueryClientProvider>,
  )
}

describe('RunsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchRuns.mockResolvedValue(list)
    mocks.cancelRun.mockResolvedValue({ status: 'CANCELLED' })
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  /** 列表是用来认出"这是哪一条"的，裸 UUID 等于没有信息（D14）。 */
  it('列出场景名与目标系统名，不是 UUID', async () => {
    signIn(['run:read'])
    const screen = await renderPage()

    await expect.element(screen.getByText('下单巡检')).toBeInTheDocument()
    await expect.element(screen.getByText('登录巡检')).toBeInTheDocument()
    expect(screen.getByText('演示商城').elements()).toHaveLength(2)
    expect(document.body.textContent).not.toContain('33333333-3333-4333-8333-333333333333')
    expect(document.body.textContent).not.toContain('11111111-1111-4111-8111-111111111111')
  })

  /** 验收 35：排队中可取消；已成功的不给取消入口。 */
  it('只有未终态的行有取消入口，点了就调接口', async () => {
    signIn(['run:read', 'run:cancel', 'run:execute'])
    const screen = await renderPage()

    const cancels = screen.getByRole('button', { name: '取消', exact: true })
    await expect.element(cancels.first()).toBeInTheDocument()
    expect(cancels.elements()).toHaveLength(1)

    await cancels.first().click()
    expect(mocks.cancelRun).toHaveBeenCalledWith('44444444-4444-4444-8444-444444444444')
  })

  /** 验收 37：viewer 看得见列表，但没有创建与取消。 */
  it('只读权限：没有创建运行与取消', async () => {
    signIn(['run:read'])
    const screen = await renderPage()

    await expect.element(screen.getByText('下单巡检')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /创建运行/ }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '取消', exact: true }).elements()).toHaveLength(0)
  })
})
