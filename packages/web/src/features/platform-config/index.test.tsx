import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FACTORY_PLATFORM_CONFIG, PERMISSIONS } from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { ThemeProvider } from '@/context/theme-provider'
import { ApiRequestError } from '@/lib/api-client'
import { Toaster } from '@/components/ui/sonner'
import { useAuthStore } from '@/stores/auth-store'
import { PlatformConfigPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchPlatformConfig: vi.fn(),
  fetchPlatformConfigRevisions: vi.fn(),
  updatePlatformConfig: vi.fn(),
}))

vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('@/lib/platform-config-api', () => ({
  fetchPlatformConfig: mocks.fetchPlatformConfig,
  fetchPlatformConfigRevisions: mocks.fetchPlatformConfigRevisions,
  registerPlatformConfigSecret: vi.fn(),
  restorePlatformConfig: vi.fn(),
  testPlatformConfigConnection: vi.fn(),
  updatePlatformConfig: mocks.updatePlatformConfig,
  validatePlatformConfig: vi.fn(),
}))

const current = {
  revision: 1,
  document: FACTORY_PLATFORM_CONFIG,
  updatedAt: '2026-09-13T00:00:00.000Z',
  updatedByAccountId: '00000000-0000-4000-8000-000000000001',
  reason: '初始化',
  source: 'bootstrap' as const,
}

function signIn(permissions: readonly string[]) {
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions: [...permissions],
  })
}

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <PlatformConfigPage />
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>,
  )
}

describe('PlatformConfigPage', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await page.viewport(1440, 900)
    mocks.fetchPlatformConfig.mockResolvedValue(current)
    mocks.fetchPlatformConfigRevisions.mockResolvedValue({ items: [], nextCursor: undefined })
    mocks.updatePlatformConfig.mockResolvedValue({ ...current, revision: 2, source: 'update' })
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('管理员能看见四组策略，主操作是保存并生效，页面不回显密钥', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await expect.element(screen.getByRole('heading', { name: '平台配置' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '浏览器 AI' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '执行默认值' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '会话策略' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '证据策略' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '变更记录' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '保存并生效' })).toBeInTheDocument()
    expect(document.body.innerText).not.toMatch(/sk-|apiKey/)
    expect(JSON.stringify(current)).not.toMatch(/sk-|apiKey/)
  })

  it('只有读权限时不能保存', async () => {
    signIn(['platform-config:read'])
    const screen = await renderPage()
    await expect.element(screen.getByRole('heading', { name: '平台配置' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存并生效' }).elements()).toHaveLength(0)
  })

  it('校验失败时保留输入', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    const timeout = screen.getByLabelText('默认步骤超时（ms）')
    await timeout.fill('10000')
    await screen.getByLabelText('变更原因').fill('故意不合法')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await expect.element(timeout).toHaveValue(10000)
    expect(mocks.updatePlatformConfig).not.toHaveBeenCalled()
  })

  it('409 冲突时保留输入，再用最新修订保存', async () => {
    mocks.updatePlatformConfig
      .mockRejectedValueOnce(
        new ApiRequestError(409, {
          code: 'PLATFORM_CONFIG_CONFLICT',
          message: '平台配置已被他人更新',
          requestId: 'req-conflict',
          details: { ...current, revision: 2, reason: '他人已改', source: 'update' },
        }),
      )
      .mockResolvedValueOnce({ ...current, revision: 3, source: 'update' })
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    await screen.getByLabelText('默认步骤超时（ms）').fill('45000')
    await screen.getByLabelText('变更原因').fill('提高超时')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await expect.element(screen.getByText(/已保留你的输入/)).toBeInTheDocument()
    await expect.element(screen.getByText(/当前修订 2/)).toBeInTheDocument()
    await expect.element(screen.getByLabelText('默认步骤超时（ms）')).toHaveValue(45000)
    expect(mocks.updatePlatformConfig).toHaveBeenCalledTimes(1)
    expect(mocks.updatePlatformConfig.mock.calls[0]![0]).toMatchObject({ expectedRevision: 1 })

    await screen.getByRole('button', { name: '保存并生效' }).click()
    await vi.waitFor(() => expect(mocks.updatePlatformConfig).toHaveBeenCalledTimes(2))
    expect(mocks.updatePlatformConfig.mock.calls[1]![0]).toMatchObject({
      expectedRevision: 2,
      document: { execution: { defaultTimeoutMs: 45_000 } },
    })
  })

  it('窄屏仍能看到各组页签', async () => {
    await page.viewport(390, 844)
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await expect.element(screen.getByRole('tab', { name: '浏览器 AI' })).toBeInTheDocument()
    await expect.element(screen.getByRole('tab', { name: '变更记录' })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '保存并生效' })).toBeInTheDocument()
  })
})
