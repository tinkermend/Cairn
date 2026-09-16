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
  fetchTargetAuthProfile: vi.fn(),
  fetchAuthProfileValidation: vi.fn(),
  observeAuthProfileValidation: vi.fn(),
  publishTargetAuthProfile: vi.fn(),
  startAuthProfileValidation: vi.fn(),
  fetchTargetAccessPolicy: vi.fn(),
  updateTargetAccessPolicy: vi.fn(),
  fetchTargetCleanup: vi.fn(),
  retryTargetCleanup: vi.fn(),
  previewDeleteTarget: vi.fn(),
  deleteTarget: vi.fn(),
  deleteTargetAccount: vi.fn(),
  fetchSessionOverview: vi.fn(),
  fetchScenarios: vi.fn(),
}))

vi.mock('@/lib/targets-api', () => mocks)
vi.mock('@/lib/sessions-api', () => ({
  fetchSessionOverview: mocks.fetchSessionOverview,
}))
vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
}))
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

function signIn(permissions = ['target:read', 'target:write', 'target:delete', 'map:read']) {
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
          expectedIdentity: null,
          authCapability: 'LEGACY',
        },
      ],
    })
    mocks.fetchTargetAuthProfile.mockResolvedValue({ current: null, history: [], accounts: [] })
    mocks.fetchTargetAccessPolicy.mockResolvedValue({
      targetId: TARGET_ID,
      revision: 0,
      policy: {
        schemaVersion: 1,
        policyVersion: 1,
        rules: [{ origin: 'https://shop.example.test', purpose: 'business_surface', effect: 'allow' }],
      },
      seeded: true,
      resourceLoadsUnrestricted: true,
      updatedAt: '1970-01-01T00:00:00.000Z',
    })
    mocks.previewDeleteTarget.mockResolvedValue({ previewToken: 'tok', counts: {}, blockers: [] })
    mocks.fetchSessionOverview.mockResolvedValue({
      items: [],
      nextCursor: null,
      summary: {
        total: 1,
        available: 1,
        needsCheck: 0,
        needsLogin: 0,
        identityMismatch: 0,
        maintenance: 0,
        executing: 0,
        lost: 0,
        unprepared: 0,
        retained: 0,
      },
      asOf: '2026-09-16T00:00:00.000Z',
    })
    mocks.fetchScenarios.mockResolvedValue({
      items: [
        {
          id: 'sc-1',
          name: '商城冒烟巡检',
          targetId: TARGET_ID,
          status: 'active',
          latestVersionId: 'v-1',
          latestVersionNo: 1,
          stepCount: 5,
          createdAt: '2026-09-14T00:00:00.000Z',
          updatedAt: '2026-09-14T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.setUser(null)
  })

  it('账号表保留筛选入口，并把关键词交给服务端', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByText('值班账号')).toBeInTheDocument()
    await expect.element(screen.getByText('登录核验规则')).toBeInTheDocument()
    await expect.element(screen.getByText('核验等级')).toBeInTheDocument()
    await expect.element(screen.getByText('期望身份')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('搜索目标账号')).toBeInTheDocument()
    await screen.getByLabelText('搜索目标账号').fill('ops')
    await expect.poll(() => mocks.fetchTargetAccounts.mock.calls[mocks.fetchTargetAccounts.mock.calls.length - 1]?.[1]).toMatchObject({
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

  it('支持切换到关联场景与目标授权标签页', async () => {
    const screen = await renderPage()
    await screen.getByRole('tab', { name: /关联场景/ }).click()
    await expect.element(screen.getByText('商城冒烟巡检')).toBeInTheDocument()

    await screen.getByRole('tab', { name: /目标授权/ }).click()
    await expect.element(screen.getByText(/已配置授权边界/)).toBeInTheDocument()
  })
})
