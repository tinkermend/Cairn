import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { SuitesPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchSuites: vi.fn(),
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

vi.mock('@/lib/suites-api', () => ({
  fetchSuites: mocks.fetchSuites,
  createSuite: vi.fn(),
  previewDeleteSuite: vi.fn(),
  deleteSuite: vi.fn(),
}))

vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
  fetchTarget: vi.fn(),
}))

vi.mock('@/hooks/use-permissions', () => ({
  useCan: () => true,
}))

describe('场景集列表', () => {
  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('展示集合名称、成员数与发布状态', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试',
      email: null,
      roles: [],
      permissions: ['suite:read', 'suite:write'],
    })
    mocks.fetchSuites.mockResolvedValue({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          targetId: '22222222-2222-4222-8222-222222222222',
          name: '系统日常巡检',
          description: null,
          status: 'active',
          draftRevision: 2,
          publishedVersionNo: 1,
          memberCount: 3,
          updatedAt: '2026-09-19T00:00:00.000Z',
        },
      ],
      nextCursor: undefined,
    })
    const screen = await render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SuitesPage />
      </QueryClientProvider>,
    )
    await expect.element(screen.getByRole('heading', { name: '场景集', exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('系统日常巡检')).toBeInTheDocument()
    await expect.element(screen.getByText('v1')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '新建场景集' })).toBeInTheDocument()
  })
})
