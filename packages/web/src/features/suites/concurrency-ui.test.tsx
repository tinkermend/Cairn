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
  fetchScenarios: vi.fn(async () => ({ items: [] })),
  fetchTarget: vi.fn(async () => ({ id: '22222222-2222-4222-8222-222222222222', name: '测试目标' })),
  saveSuiteDraft: vi.fn(),
  validateSuite: vi.fn(),
  publishSuite: vi.fn(),
  updateSuiteEnabled: vi.fn(),
  createSuiteRun: vi.fn(),
  previewSuiteRun: vi.fn(),
  cancelSuiteRun: vi.fn(),
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
  }
})

vi.mock('@/lib/targets-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/targets-api')>()
  return {
    ...actual,
    fetchTarget: mocks.fetchTarget,
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

describe('场景集并发调度与运行度量 UI', () => {
  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('SuiteDetailPage: 展示执行模式与并发数配置项', async () => {
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
      name: '并发场景集',
      description: null,
      status: 'active',
      draft: {
        revision: 1,
        document: {
          schemaVersion: 1,
          groups: [],
          members: [],
          sharedInput: {},
          executionMode: 'parallel',
          maxConcurrency: 5,
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

    await expect.element(page.getByText('执行模式')).toBeVisible()
    await expect.element(page.getByText('最大并发数 (1–10)')).toBeVisible()
    await expect.element(page.getByText('受控并发 (Worker 池)')).toBeVisible()
    const input = page.getByLabelText('最大并发数 (1–10)')
    await expect.element(input).toHaveValue(5)
  })

  it('SuiteRunDetailPage: 展示执行模式、活跃数、耗时度量与账号列', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试员',
      email: null,
      roles: [],
      permissions: ['suite:read', 'run:read'],
    })

    mocks.fetchSuiteRun.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      suiteId: '11111111-1111-4111-8111-111111111111',
      suiteVersionId: '44444444-4444-4444-8444-444444444444',
      targetId: '22222222-2222-4222-8222-222222222222',
      status: 'RUNNING',
      verdict: null,
      evidenceStatus: 'PENDING',
      cancelRequested: false,
      reason: null,
      failurePolicy: 'continue',
      executionMode: 'parallel',
      maxConcurrency: 3,
      deadlineAt: '2026-09-22T10:00:00.000Z',
      startedAt: '2026-09-22T09:00:00.000Z',
      finishedAt: null,
      wallClockMs: 12000,
      childDurationMs: 24000,
      counts: {
        planned: 3,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        skipped: 0,
        pending: 0,
        active: 2,
      },
      revision: 3,
      eventSeq: 5,
      items: [
        {
          memberId: 'm1',
          ordinal: 0,
          groupId: null,
          displayName: '成员一',
          scenarioId: '55555555-5555-4555-8555-555555555555',
          scenarioVersionId: '66666666-6666-4666-8666-666666666666',
          childRunId: '77777777-7777-4777-8777-777777777777',
          admission: 'ACTIVE',
          skipReason: null,
          runStatus: 'RUNNING',
          outcomeStatus: null,
          evidenceStatus: 'PENDING',
          targetAccountId: '88888888-8888-4888-8888-888888888888',
        },
      ],
      readAt: '2026-09-22T09:05:00.000Z',
      createdAt: '2026-09-22T09:00:00.000Z',
      automaticReport: null,
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render(
      <QueryClientProvider client={queryClient}>
        <SuiteRunDetailPage />
      </QueryClientProvider>,
    )

    await expect.element(page.getByText('受控并发 (上限 3)')).toBeVisible()
    await expect.element(page.getByText('目标账号')).toBeVisible()
    await expect.element(page.getByText('节约 50%')).toBeVisible()
  })
})
