import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { BatchesPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchBatches: vi.fn(),
  fetchScenarios: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  fetchDatasets: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={String(to)}>{children}</a>,
  }
})

vi.mock('@/lib/batches-api', () => ({
  fetchBatches: mocks.fetchBatches,
  fetchBatch: vi.fn(),
  fetchBatchItems: vi.fn(),
  createBatch: vi.fn(),
  pauseBatch: vi.fn(),
  resumeBatch: vi.fn(),
  cancelBatch: vi.fn(),
  retryFailedBatchItems: vi.fn(),
  exportBatchResults: vi.fn(),
}))

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
  fetchScenario: vi.fn(),
}))

vi.mock('@/lib/datasets-api', () => ({
  fetchDatasets: mocks.fetchDatasets,
  fetchDataset: vi.fn(),
  createDataset: vi.fn(),
  preflightDataset: vi.fn(),
  autoMapDataset: vi.fn(),
}))

vi.mock('@/hooks/use-permissions', () => ({
  useCan: () => true,
}))

describe('BatchesPage', () => {
  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('renders batch automation list with status badges and metrics', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试用户',
      email: null,
      roles: [],
      permissions: ['batch:read', 'batch:write', 'batch:execute'],
    })

    mocks.fetchBatches.mockResolvedValue({
      items: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          name: '批量开户跑批任务',
          scenarioId: 'sc-1',
          scenarioVersionId: 'scv-1',
          datasetId: 'ds-1',
          targetAccountId: null,
          status: 'RUNNING',
          failurePolicy: 'stop_on_threshold',
          failureThreshold: 5,
          pacingConfig: { minDelayMs: 1000, maxDelayMs: 3000 },
          totalItems: 100,
          successItems: 45,
          failedItems: 2,
          reviewItems: 1,
          pausedReason: null,
          createdByAccountId: null,
          createdAt: '2026-09-22T00:00:00Z',
          updatedAt: '2026-09-22T00:00:00Z',
        },
      ],
      nextCursor: undefined,
    })

    const queryClient = new QueryClient()
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <BatchesPage />
      </QueryClientProvider>
    )

    await expect.element(screen.getByText('批量开户跑批任务')).toBeInTheDocument()
    await expect.element(screen.getByText('RUNNING')).toBeInTheDocument()
    await expect.element(screen.getByText('45')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: /详情/ })).toBeInTheDocument()
    await expect.element(screen.getByText('已删除账号')).toBeInTheDocument()
  })
})
