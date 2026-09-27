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
  createSuiteRun: vi.fn(),
  previewSuiteRun: vi.fn(),
  updateSuiteEnabled: vi.fn(),
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
      permissions: ['suite:read', 'suite:write', 'run:execute'],
    })
    mocks.fetchSuites.mockResolvedValue({
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          targetId: '22222222-2222-4222-8222-222222222222',
          name: '系统日常巡检',
          description: '用于核心交易日常巡检',
          status: 'active',
          draftRevision: 2,
          publishedVersionNo: 1,
          memberCount: 3,
          isStageMode: false,
          stageCount: 0,
          latestRun: {
            id: 'run-101',
            status: 'COMPLETED',
            verdict: 'all_pass',
            startedAt: '2026-09-19T00:00:00.000Z',
            finishedAt: '2026-09-19T00:00:45.000Z',
            durationMs: 45000,
          },
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
    await expect.element(screen.getByText('用于核心交易日常巡检')).toBeInTheDocument()
    await expect.element(screen.getByText('平铺 · 3 场景')).toBeInTheDocument()
    await expect.element(screen.getByText('编排结束')).toBeInTheDocument()
    await expect.element(screen.getByText('全部通过')).toBeInTheDocument()
    await expect.element(screen.getByText('v1')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '启动 系统日常巡检' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '新建场景集' })).toBeInTheDocument()
  })

  it('多阶段场景集展示阶段规模标签与未运行态', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试',
      email: null,
      roles: [],
      permissions: ['suite:read', 'suite:write', 'run:execute'],
    })
    mocks.fetchSuites.mockResolvedValue({
      items: [
        {
          id: '22222222-1111-4111-8111-111111111111',
          targetId: '22222222-2222-4222-8222-222222222222',
          name: '风控多阶段套件',
          description: null,
          status: 'active',
          draftRevision: 3,
          publishedVersionNo: 1,
          memberCount: 5,
          isStageMode: true,
          stageCount: 2,
          latestRun: null,
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
    await expect.element(screen.getByText('风控多阶段套件')).toBeInTheDocument()
    await expect.element(screen.getByText('2 阶段 · 5 场景')).toBeInTheDocument()
    await expect.element(screen.getByText('有未发布草稿 (r3)')).toBeInTheDocument()
    await expect.element(screen.getByText('从未运行')).toBeInTheDocument()
  })
})
