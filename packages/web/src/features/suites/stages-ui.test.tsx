import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { SuiteDetailPage } from './detail'
import { SuiteRunDetailPage } from '../suite-runs/detail'

const mocks = vi.hoisted(() => ({
  fetchSuite: vi.fn(),
  fetchSuiteRun: vi.fn(),
  fetchScenarios: vi.fn(async () => ({
    items: [
      { id: 'sc-1', name: '登录准备场景', latestVersionId: 'v1' },
      { id: 'sc-2', name: '数据检查场景', latestVersionId: 'v2' },
    ],
  })),
  fetchTarget: vi.fn(async () => ({ id: '22222222-2222-4222-8222-222222222222', name: '测试目标' })),
  fetchTargetAccounts: vi.fn(async () => ({ items: [] })),
  saveSuiteDraft: vi.fn(),
  validateSuite: vi.fn(),
  publishSuite: vi.fn(),
  updateSuiteEnabled: vi.fn(),
  createSuiteRun: vi.fn(),
  previewSuiteRun: vi.fn(),
  cancelSuiteRun: vi.fn(),
  rerunSuiteItem: vi.fn(),
  fetchReports: vi.fn(async () => ({ items: [] })),
  fetchReportRevision: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useParams: () => ({
      suiteId: '11111111-1111-4111-8111-111111111111',
      suiteRunId: '33333333-3333-4333-8333-333333333333',
    }),
    useNavigate: () => mocks.navigate,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={String(to)}>{children}</a>,
  }
})

vi.mock('@/lib/suites-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/suites-api')>()
  return {
    ...actual,
    fetchSuite: mocks.fetchSuite,
    fetchSuiteRun: mocks.fetchSuiteRun,
    saveSuiteDraft: mocks.saveSuiteDraft,
    validateSuite: mocks.validateSuite,
    publishSuite: mocks.publishSuite,
    updateSuiteEnabled: mocks.updateSuiteEnabled,
    createSuiteRun: mocks.createSuiteRun,
    previewSuiteRun: mocks.previewSuiteRun,
    cancelSuiteRun: mocks.cancelSuiteRun,
    rerunSuiteItem: mocks.rerunSuiteItem,
  }
})

vi.mock('@/lib/reports-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reports-api')>()
  return {
    ...actual,
    fetchReports: mocks.fetchReports,
    fetchReportRevision: mocks.fetchReportRevision,
  }
})

vi.mock('@/lib/targets-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/targets-api')>()
  return {
    ...actual,
    fetchTarget: mocks.fetchTarget,
    fetchTargetAccounts: mocks.fetchTargetAccounts,
  }
})

vi.mock('@/lib/scenarios-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/scenarios-api')>()
  return {
    ...actual,
    fetchScenarios: mocks.fetchScenarios,
  }
})

vi.mock('@/lib/observation-stream', () => ({
  subscribeObservation: vi.fn(async () => () => {}),
}))

vi.mock('@/hooks/use-permissions', () => ({
  useCan: () => true,
}))

vi.mock('@/components/rbac/can', () => ({
  Can: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('Stage 阶段编排与局部重跑 UI 验收', () => {
  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('SuiteDetailPage: 支持多阶段展示与阶段切换', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '管理员',
      email: null,
      roles: [],
      permissions: ['suite:read', 'suite:write', 'run:execute'],
    })

    mocks.fetchSuite.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      targetId: '22222222-2222-4222-8222-222222222222',
      name: '阶段编排巡检集',
      description: null,
      status: 'active',
      draft: {
        revision: 1,
        document: {
          schemaVersion: 1,
          groups: [],
          members: [],
          stages: [
            {
              id: 'stage-1',
              name: '准备阶段',
              ordinal: 0,
              executionMode: 'sequential',
              maxConcurrency: 1,
              failurePolicy: 'stop',
              members: [
                {
                  memberId: 'm1',
                  ordinal: 0,
                  scenarioId: 'sc-1',
                  scenarioVersionId: 'v1',
                  displayName: '登录准备',
                  input: {},
                },
              ],
            },
            {
              id: 'stage-2',
              name: '核心巡检阶段',
              ordinal: 1,
              executionMode: 'parallel',
              maxConcurrency: 4,
              failurePolicy: 'continue',
              members: [
                {
                  memberId: 'm2',
                  ordinal: 0,
                  scenarioId: 'sc-2',
                  scenarioVersionId: 'v2',
                  displayName: '指标提取',
                  input: {
                    token: '${stage[stage-1].members[m1].output.customData.token}',
                  },
                },
              ],
            },
          ],
          sharedInput: {},
          executionMode: 'parallel',
          maxConcurrency: 3,
          failurePolicy: 'continue',
          autoGenerateFinalReport: false,
        },
      },
      published: null,
      deletedAt: null,
      deletedBy: null,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render(
      <QueryClientProvider client={queryClient}>
        <SuiteDetailPage />
      </QueryClientProvider>,
    )

    // Verify stage headers and badges
    await expect.element(page.getByText('多阶段依赖编排 (2 个阶段)')).toBeVisible()
    await expect.element(page.getByText('Stage 1')).toBeVisible()
    await expect.element(page.getByText('Stage 2')).toBeVisible()
    await expect.element(page.getByLabelText('阶段 1 名称')).toHaveValue('准备阶段')
    await expect.element(page.getByLabelText('阶段 2 名称')).toHaveValue('核心巡检阶段')
  })

  it('SuiteRunDetailPage: 展示 Stage 标识、重跑标记与重跑按钮', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试员',
      email: null,
      roles: [],
      permissions: ['suite:read', 'suite:write', 'run:execute', 'run:read'],
    })

    mocks.fetchSuiteRun.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      suiteId: '11111111-1111-4111-8111-111111111111',
      suiteVersionId: '44444444-4444-4444-8444-444444444444',
      targetId: '22222222-2222-4222-8222-222222222222',
      status: 'FAILED',
      verdict: 'anomalies_found',
      evidenceStatus: 'COMPLETE',
      cancelRequested: false,
      reason: '1 项异常',
      failurePolicy: 'continue',
      readAt: '2026-09-22T08:30:00.000Z',
      executionMode: 'parallel',
      maxConcurrency: 3,
      counts: {
        total: 2,
        succeeded: 1,
        failed: 1,
        skipped: 0,
        active: 0,
        pending: 0,
      },
      items: [
        {
          memberId: 'm1',
          ordinal: 0,
          stageId: 'stage-1',
          stageOrdinal: 0,
          childRunId: 'run-1',
          originalRunId: 'run-1',
          rerunCount: 0,
          displayName: '登录准备',
          admission: 'DISPATCHED',
          runStatus: 'COMPLETED',
          outcomeStatus: 'PASS',
        },
        {
          memberId: 'm2',
          ordinal: 1,
          stageId: 'stage-2',
          stageOrdinal: 1,
          childRunId: 'run-2-rerun',
          originalRunId: 'run-2',
          rerunCount: 1,
          displayName: '指标提取',
          admission: 'DISPATCHED',
          runStatus: 'FAILED',
          outcomeStatus: 'FAIL',
        },
      ],
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render(
      <QueryClientProvider client={queryClient}>
        <SuiteRunDetailPage />
      </QueryClientProvider>,
    )

    // Stage badges in table
    await expect.element(page.getByText('Stage 1')).toBeVisible()
    await expect.element(page.getByText('Stage 2')).toBeVisible()
    // Rerun count badge
    await expect.element(page.getByText('重跑第 1 次')).toBeVisible()
    // Top rerun button
    await expect.element(page.getByRole('button', { name: /只重跑失败项/ })).toBeVisible()
    // Row level rerun button
    const rerunButtons = page.getByRole('button', { name: /重跑/ })
    await expect.element(rerunButtons.first()).toBeVisible()
  })
})
