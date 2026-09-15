import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { TargetDetailPage } from './detail'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  fetchTarget: vi.fn(),
  fetchTargetAccounts: vi.fn(),
  fetchTargetCleanup: vi.fn(),
  retryTargetCleanup: vi.fn(),
  previewDeleteTarget: vi.fn(),
  deleteTarget: vi.fn(),
  deleteTargetAccount: vi.fn(),
}))

vi.mock('@/lib/targets-api', () => mocks)
vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('./account-form-dialog', () => ({ AccountFormDialog: () => null }))
vi.mock('./target-form-dialog', () => ({ TargetFormDialog: () => null }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    getRouteApi: () => ({
      useParams: () => ({ targetId: TARGET_ID }),
    }),
    useNavigate: () => vi.fn(),
    Link: ({ children }: { children: ReactNode }) => <a href='#'>{children}</a>,
  }
})

function signIn() {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: ['target:read', 'target:write', 'target:delete'],
  })
}

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TargetDetailPage />
    </QueryClientProvider>,
  )
}

describe('TargetDetailPage 账号列表', () => {
  beforeEach(() => {
    signIn()
    mocks.fetchTarget.mockResolvedValue({
      id: TARGET_ID,
      name: '演示商城',
      code: 'shop',
      entryUrl: 'https://shop.example.test',
      authMethod: 'password',
      captchaMode: 'none',
      status: 'active',
      accountCount: 1,
      updatedAt: '2026-09-14T00:00:00.000Z',
    })
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          targetId: TARGET_ID,
          displayName: '值班账号',
          username: 'ops',
          status: 'active',
          hasPassword: true,
        },
      ],
    })
    mocks.previewDeleteTarget.mockResolvedValue({ previewToken: 'tok', counts: {}, blockers: [] })
  })

  afterEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.setUser(null)
  })

  it('账号表保留筛选入口，并把关键词交给服务端', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByText('值班账号')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('搜索目标账号')).toBeInTheDocument()
    await screen.getByLabelText('搜索目标账号').fill('ops')
    await expect.poll(() => mocks.fetchTargetAccounts.mock.calls.at(-1)?.[1]).toMatchObject({
      search: 'ops',
      limit: 20,
    })
  })

  it('筛选无结果时仍保留搜索框和清除筛选', async () => {
    mocks.fetchTargetAccounts.mockResolvedValue({ items: [] })
    const screen = await renderPage()
    await screen.getByLabelText('搜索目标账号').fill('没有这个')
    await expect.element(screen.getByText('没有匹配的目标账号')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('搜索目标账号')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '清除筛选' })).toBeInTheDocument()
  })

  it('已删除目标展示清理状态', async () => {
    mocks.fetchTarget.mockRejectedValue(new Error('目标系统不存在'))
    mocks.fetchTargetCleanup.mockResolvedValue({
      resourceId: TARGET_ID,
      resourceType: 'target',
      status: 'failed',
      totalObjects: 2,
      purgedObjects: 1,
      failedObjects: 1,
      totalBytes: 2048,
      purgedBytes: 1024,
      lastError: '部分对象文件清理失败，请重试',
    })
    const screen = await renderPage()
    await expect.element(screen.getByText('目标系统已删除。业务记录不可访问，附件按清理状态处理。')).toBeInTheDocument()
    await expect.element(screen.getByText(/清理失败/)).toBeInTheDocument()
  })
})
