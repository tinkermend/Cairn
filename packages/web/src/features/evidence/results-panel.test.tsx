import { describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import type { RunSummaryDto } from '@cairn/shared'
import { ResultsCenterPanel } from './results-panel'

const mocks = vi.hoisted(() => ({
  fetchRuns: vi.fn(),
  fetchTargets: vi.fn(async () => ({ items: [{ id: 'target-1', name: '目标甲' }], nextCursor: undefined })),
  fetchScenarios: vi.fn(async () => ({ items: [{ id: 'sc-1', name: '场景甲' }], nextCursor: undefined })),
  useRunObservation: vi.fn(),
}))

vi.mock('@/lib/runs-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runs-api')>()
  return {
    ...actual,
    fetchRuns: mocks.fetchRuns,
  }
})

vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
}))

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
}))

vi.mock('@/features/runs/use-run-observation', () => ({
  useRunObservation: mocks.useRunObservation,
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={String(to)}>{children}</a>,
  }
})

function summary(overrides: Partial<RunSummaryDto>): RunSummaryDto {
  return {
    executionOrigin: 'standalone',
    id: 'run-1',
    status: 'QUEUED',
    cancelRequested: false,
    targetId: 'target-1',
    targetName: '目标甲',
    targetAccountId: null,
    targetAccountName: null,
    scenarioId: 'sc-1',
    scenarioName: '场景甲',
    scenarioVersionId: '55555555-5555-4555-8555-555555555555',
    createdAt: '2026-09-19T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    evidenceStatus: 'PENDING',
    outcomeStatus: 'NOT_EVALUATED',
    lease: null,
    debugMode: 'runThrough',
    ...overrides,
  }
}

describe('ResultsCenterPanel', () => {
  it('渲染运行列表并支持打开流水线抽屉', async () => {
    mocks.fetchRuns.mockResolvedValue({
      items: [
        summary({
          status: 'FAILED',
          outcomeStatus: 'FAIL',
          evidenceStatus: 'COMPLETE',
          startedAt: '2026-09-19T00:00:01.000Z',
          finishedAt: '2026-09-19T00:00:05.000Z',
        }),
      ],
      nextCursor: undefined,
    })

    mocks.useRunObservation.mockReturnValue({
      run: {
        id: 'run-1',
        status: 'FAILED',
        targetId: 'target-1',
        scenarioId: 'sc-1',
        stepRuns: [
          {
            id: 'step-1',
            name: '打开页面',
            status: 'SUCCEEDED',
            ordinal: 0,
            attempts: [],
          },
          {
            id: 'step-2',
            name: '点击登录',
            status: 'FAILED',
            ordinal: 1,
            attempts: [],
          },
        ],
      },
      evidence: { items: [] },
      query: { isPending: false, isError: false },
    })

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const patch = vi.fn()

    const screen = await render(
      <QueryClientProvider client={client}>
        <ResultsCenterPanel search={{ tab: 'results' }} patch={patch} />
      </QueryClientProvider>,
    )

    await expect.element(screen.getByText('目标甲')).toBeInTheDocument()
    await expect.element(screen.getByText('场景甲')).toBeInTheDocument()
    await expect.element(screen.getByText('查看流水线')).toBeInTheDocument()

    // 点击查看流水线，打开全景执行流水线抽屉
    await screen.getByText('查看流水线').click()
    await expect.element(screen.getByText('全景执行流水线')).toBeInTheDocument()
    await expect.element(screen.getByText('共 2 步')).toBeInTheDocument()
  })
})
