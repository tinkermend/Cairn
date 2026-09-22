import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { DatasetsPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchDatasets: vi.fn(),
  fetchTargets: vi.fn(async () => ({ items: [], nextCursor: undefined })),
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

vi.mock('@/lib/datasets-api', () => ({
  fetchDatasets: mocks.fetchDatasets,
  createDataset: vi.fn(),
  deleteDataset: vi.fn(),
  fetchDatasetRows: vi.fn(),
  preflightDataset: vi.fn(),
  autoMapDataset: vi.fn(),
}))

vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
}))

vi.mock('@/hooks/use-permissions', () => ({
  useCan: () => true,
}))

describe('DatasetsPage', () => {
  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('renders dataset list with row counts and action buttons', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试用户',
      email: null,
      roles: [],
      permissions: ['dataset:read', 'dataset:write', 'dataset:delete'],
    })

    mocks.fetchDatasets.mockResolvedValue({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          name: '新用户开户名单',
          targetId: '22222222-2222-4222-8222-222222222222',
          sourceType: 'excel',
          sourceFilename: 'users.xlsx',
          selectedSheet: 'Sheet1',
          rowCount: 42,
          columns: [
            { name: '手机号', key: 'phone', type: 'string', sampleValues: ['13800138000'] },
          ],
          createdByAccountId: 'u1',
          createdAt: '2026-09-22T00:00:00Z',
          updatedAt: '2026-09-22T00:00:00Z',
        },
      ],
      nextCursor: undefined,
    })

    const queryClient = new QueryClient()
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <DatasetsPage />
      </QueryClientProvider>
    )

    await expect.element(screen.getByText('新用户开户名单')).toBeInTheDocument()
    await expect.element(screen.getByText(/42 行/)).toBeInTheDocument()
    await expect.element(screen.getByText('EXCEL', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: /查看数据/ })).toBeInTheDocument()
  })
})
