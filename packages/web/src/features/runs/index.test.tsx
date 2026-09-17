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
  previewDeleteRun: vi.fn(),
  deleteRun: vi.fn(),
  fetchScenarios: vi.fn().mockResolvedValue({ items: [] }),
  fetchTargets: vi.fn().mockResolvedValue({ items: [] }),
}))

vi.mock('@/lib/runs-api', () => ({
  fetchRuns: mocks.fetchRuns,
  cancelRun: mocks.cancelRun,
  createRun: mocks.createRun,
  previewDeleteRun: mocks.previewDeleteRun,
  deleteRun: mocks.deleteRun,
}))
vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
  fetchScenario: vi.fn(),
  fetchScenarioCapabilities: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
  fetchTargetAccounts: vi.fn().mockResolvedValue({ items: [] }),
}))
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
    evidenceStatus: 'PENDING',
    outcomeStatus: 'NOT_EVALUATED',
    lease: null,
    debugMode: 'runThrough',
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
      evidenceStatus: 'INCOMPLETE',
      outcomeStatus: 'FAIL',
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
    mocks.previewDeleteRun.mockResolvedValue({
      canDelete: true,
      blockers: [],
      cascadeImpact: {
        targets: 0,
        targetAccounts: 0,
        scenarios: 0,
        recordingDrafts: 0,
        runs: 1,
        stepRuns: 2,
        attempts: 2,
        storedObjects: 3,
      },
    })
    mocks.deleteRun.mockResolvedValue({ success: true })
    mocks.fetchScenarios.mockResolvedValue({ items: [] })
    mocks.fetchTargets.mockResolvedValue({ items: [] })
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
    await expect.element(screen.getByText('证据不完整')).toBeInTheDocument()
    const headers = [...document.querySelectorAll('thead th')].map((node) => node.textContent?.trim())
    expect(headers.slice(0, 6)).toEqual(['状态', '业务结果', '证据', '场景', '目标系统', '创建时间'])
    const incompleteRow = [...document.querySelectorAll('tbody tr')].find((row) =>
      row.textContent?.includes('登录巡检'),
    )
    const cells = [...(incompleteRow?.querySelectorAll('td') ?? [])].map((node) => node.textContent ?? '')
    expect(cells[0]).toContain('成功')
    expect(cells[1]).toContain('业务异常')
    expect(cells[2]).toContain('证据不完整')
    expect(cells[3]).toContain('登录巡检')
    expect(cells[1]).not.toContain('登录巡检')
    await expect.element(screen.getByRole('combobox', { name: '业务结果筛选' })).toBeInTheDocument()
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

  /** 终态运行支持删除；非终态运行不展示删除入口 */
  it('具备 run:delete 权限时，仅终态运行展示删除按钮', async () => {
    signIn(['run:read', 'run:delete'])
    const screen = await renderPage()

    await expect.element(screen.getByText('下单巡检')).toBeInTheDocument()
    // 第一条是 QUEUED，第二条是 SUCCEEDED
    const deleteButtons = screen.getByRole('button', { name: /删除运行/ })
    expect(deleteButtons.elements()).toHaveLength(1)
    await expect.element(screen.getByRole('button', { name: '删除运行44444444-4444-4444-8444-444444444445' })).toBeInTheDocument()
  })

  /** 验收 37：viewer 看得见列表，但没有创建与取消。 */
  it('只读权限：没有创建运行与取消', async () => {
    signIn(['run:read'])
    const screen = await renderPage()

    await expect.element(screen.getByText('下单巡检')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /创建运行/ }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '取消', exact: true }).elements()).toHaveLength(0)
    expect(screen.getByRole('button', { name: /删除运行/ }).elements()).toHaveLength(0)
  })

  it('仅有 run:execute 时不显示创建运行', async () => {
    signIn(['run:read', 'run:execute'])
    const screen = await renderPage()

    await expect.element(screen.getByText('下单巡检')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /创建运行/ }).elements()).toHaveLength(0)
  })

  it('状态筛选包含排队与待核查', async () => {
    signIn(['run:read'])
    const screen = await renderPage()
    await expect.element(screen.getByRole('button', { name: '排队' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '待核查' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '恢复中' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '需要登录' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '挂起中' })).toBeInTheDocument()
  })

  it('具备编写权限时提供场景筛选', async () => {
    mocks.fetchScenarios.mockResolvedValue({
      items: [{ id: '33333333-3333-4333-8333-333333333333', name: '下单巡检' }],
    })
    signIn(['run:read', 'workflow:read'])
    const screen = await renderPage()
    await expect.element(screen.getByRole('combobox', { name: '场景筛选' })).toBeInTheDocument()
  })

  it('已删除目录只显示名称和已删除标记', async () => {
    mocks.fetchRuns.mockResolvedValue({
      items: [
        summary({
          scenarioDeleted: true,
          targetDeleted: true,
          scenarioName: '旧场景',
          targetName: '旧目标',
        }),
      ],
    })
    signIn(['run:read'])
    const screen = await renderPage()
    await expect.element(screen.getByText('旧场景')).toBeInTheDocument()
    await expect.element(screen.getByText('旧目标')).toBeInTheDocument()
    expect(screen.getByText('已删除').elements().length).toBeGreaterThanOrEqual(2)
    expect(document.querySelector('a[href*="scenarios"]')).toBeNull()
    expect(document.querySelector('a[href*="targets"]')).toBeNull()
  })

  it('具备开跑组合权限时显示创建运行', async () => {
    signIn(['run:read', 'run:execute', 'target:read', 'workflow:read'])
    const screen = await renderPage()

    await expect.element(screen.getByRole('button', { name: /创建运行/ }).first()).toBeInTheDocument()
  })
})
