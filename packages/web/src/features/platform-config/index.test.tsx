import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import { FACTORY_PLATFORM_CONFIG, PERMISSIONS } from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError } from '@/lib/api-client'
import { ThemeProvider } from '@/context/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { PlatformConfigPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchPlatformConfig: vi.fn(),
  fetchPlatformConfigRevisions: vi.fn(),
  updatePlatformConfig: vi.fn(),
  restorePlatformConfig: vi.fn(),
  registerPlatformConfigSecret: vi.fn(),
}))

vi.mock('@/components/layout/app-header', () => ({ AppHeader: () => null }))
vi.mock('@/lib/platform-config-api', () => ({
  fetchPlatformConfig: mocks.fetchPlatformConfig,
  fetchPlatformConfigRevisions: mocks.fetchPlatformConfigRevisions,
  registerPlatformConfigSecret: mocks.registerPlatformConfigSecret,
  restorePlatformConfig: mocks.restorePlatformConfig,
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

let client: QueryClient
async function renderPage() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <PlatformConfigPage />
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  )
}

describe('PlatformConfigPage', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    await page.viewport(1440, 900)
    mocks.fetchPlatformConfig.mockResolvedValue(current)
    mocks.fetchPlatformConfigRevisions.mockResolvedValue({
      items: [],
      nextCursor: undefined,
    })
    mocks.updatePlatformConfig.mockImplementation(async (body) => ({
      ...current,
      revision: body.expectedRevision + 1,
      document: body.document,
      source: 'update',
    }))
  })

  afterEach(() => {
    client?.clear()
    useAuthStore.getState().auth.setUser(null)
  })

  it('管理员能看见四组策略，主操作是保存并生效，页面不回显密钥', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await expect
      .element(screen.getByRole('heading', { name: '平台配置' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: '浏览器 AI' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: '执行默认值' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: '会话策略' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: '证据策略' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: '变更记录' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '保存并生效' }))
      .toBeInTheDocument()
    expect(document.body.innerText).not.toMatch(/sk-|apiKey/)
    expect(JSON.stringify(current)).not.toMatch(/sk-|apiKey/)
  })

  it('只有读权限时不能保存', async () => {
    signIn(['platform-config:read'])
    const screen = await renderPage()
    await expect
      .element(screen.getByRole('heading', { name: '平台配置' }))
      .toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '保存并生效' }).elements()
    ).toHaveLength(0)
  })

  it('登记密钥同时提交当前模型地址，成功后清空明文输入', async () => {
    mocks.registerPlatformConfigSecret.mockResolvedValue({
      secretRef: {
        provider: 'local',
        secretId: '00000000-0000-4000-8000-000000000010',
      },
    })
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByLabelText('模型服务地址').fill('https://model.example/v1')
    await screen.getByLabelText('模型密钥').fill('review-only-fake-key')
    await screen.getByRole('button', { name: '登记密钥', exact: true }).click()
    await expect.element(screen.getByLabelText('模型密钥')).toHaveValue('')
    expect(mocks.registerPlatformConfigSecret).toHaveBeenCalledWith({
      baseUrl: 'https://model.example/v1',
      apiKey: 'review-only-fake-key',
    })
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

  it('409 冲突时保留输入与基准修订，明确重新加载后才可编辑保存', async () => {
    mocks.updatePlatformConfig.mockRejectedValueOnce(
      new ApiRequestError(409, {
        code: 'PLATFORM_CONFIG_CONFLICT',
        message: '平台配置已被他人更新',
        requestId: 'req-conflict',
        details: {
          ...current,
          revision: 2,
          reason: '他人已改',
          source: 'update',
        },
      })
    )
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    await screen.getByLabelText('默认步骤超时（ms）').fill('45000')
    await screen.getByLabelText('变更原因').fill('提高超时')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await expect.element(screen.getByText(/已保留你的输入/)).toBeInTheDocument()
    await expect.element(screen.getByText(/当前修订 2/)).toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('默认步骤超时（ms）'))
      .toHaveValue(45000)
    expect(mocks.updatePlatformConfig).toHaveBeenCalledTimes(1)
    expect(mocks.updatePlatformConfig.mock.calls[0]![0]).toMatchObject({
      expectedRevision: 1,
    })

    await expect
      .element(screen.getByRole('button', { name: '保存并生效' }))
      .toBeDisabled()
    await screen
      .getByRole('button', { name: '放弃本次修改并载入最新配置' })
      .click()
    await expect
      .element(screen.getByLabelText('默认步骤超时（ms）'))
      .toHaveValue(30000)
    await screen.getByLabelText('默认步骤超时（ms）').fill('45000')
    await screen.getByLabelText('变更原因').fill('重新提高超时')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await vi.waitFor(() =>
      expect(mocks.updatePlatformConfig).toHaveBeenCalledTimes(2)
    )
    expect(mocks.updatePlatformConfig.mock.calls[1]![0]).toMatchObject({
      expectedRevision: 2,
      document: { execution: { defaultTimeoutMs: 45_000 } },
    })
  })

  it('窄屏仍能看到各组页签', async () => {
    await page.viewport(390, 844)
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await expect
      .element(screen.getByRole('tab', { name: '浏览器 AI' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: '变更记录' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '保存并生效' }))
      .toBeInTheDocument()
    for (const name of [
      '执行默认值',
      '会话策略',
      '证据策略',
      '变更记录',
      '浏览器 AI',
    ]) {
      await screen.getByRole('tab', { name }).click()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        window.innerWidth
      )
    }
  })

  it('后台刷新保留脏表单，不能用新修订覆盖其他分组', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    await screen.getByLabelText('默认步骤超时（ms）').fill('45000')
    mocks.fetchPlatformConfig.mockResolvedValue({
      ...current,
      revision: 2,
      source: 'update',
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        session: { ...FACTORY_PLATFORM_CONFIG.session, idleTtlSeconds: 900 },
      },
    })
    await client.invalidateQueries({ queryKey: ['platform-config'] })
    await expect.element(screen.getByText(/当前修订 2/)).toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('默认步骤超时（ms）'))
      .toHaveValue(45000)
    await expect
      .element(screen.getByRole('button', { name: '保存并生效' }))
      .toBeDisabled()
    expect(mocks.updatePlatformConfig).not.toHaveBeenCalled()
    await screen
      .getByRole('button', { name: '放弃本次修改并载入最新配置' })
      .click()
    await screen.getByLabelText('默认步骤超时（ms）').fill('45000')
    await screen.getByLabelText('变更原因').fill('仅提高超时')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    expect(mocks.updatePlatformConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 2,
        document: expect.objectContaining({
          session: expect.objectContaining({ idleTtlSeconds: 900 }),
        }),
      })
    )
  })

  it('未编辑的表单跟随后台最新值', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    await expect
      .element(screen.getByLabelText('默认步骤超时（ms）'))
      .toHaveValue(30000)
    mocks.fetchPlatformConfig.mockResolvedValue({
      ...current,
      revision: 2,
      source: 'update',
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        execution: { defaultTimeoutMs: 45000, defaultRetryLimit: 0 },
      },
    })
    await client.invalidateQueries({ queryKey: ['platform-config'] })
    await expect
      .element(screen.getByLabelText('默认步骤超时（ms）'))
      .toHaveValue(45000)
    await expect
      .element(screen.getByRole('button', { name: '保存并生效' }))
      .toBeEnabled()
  })

  it('恢复后表单与新修订同步，保存其他分组不会撤回恢复值', async () => {
    const restored = {
      ...current,
      revision: 3,
      source: 'restore',
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        execution: { defaultTimeoutMs: 45000, defaultRetryLimit: 0 },
      },
    }
    mocks.fetchPlatformConfigRevisions.mockResolvedValue({
      items: [
        {
          id: 'r2',
          revision: 2,
          source: 'update',
          reason: '45 秒配置',
          document: restored.document,
          actorAccountId: current.updatedByAccountId,
          createdAt: current.updatedAt,
          diff: [
            { path: 'execution.defaultTimeoutMs', from: 30000, to: 45000 },
          ],
        },
      ],
      nextCursor: undefined,
    })
    mocks.restorePlatformConfig.mockResolvedValue(restored)
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    await expect
      .element(screen.getByLabelText('默认步骤超时（ms）'))
      .toHaveValue(30000)
    await screen.getByRole('tab', { name: '变更记录' }).click()
    await screen.getByLabelText('恢复原因').fill('恢复 45 秒配置')
    await screen.getByRole('button', { name: '恢复这一版' }).click()
    await expect.element(screen.getByText(/当前修订 3/)).toBeInTheDocument()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    await expect
      .element(screen.getByLabelText('默认步骤超时（ms）'))
      .toHaveValue(45000)
    await screen.getByRole('tab', { name: '会话策略' }).click()
    await screen.getByLabelText('空闲寿命（秒）').fill('900')
    await screen.getByLabelText('变更原因').fill('延长空闲时间')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    expect(mocks.updatePlatformConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 3,
        document: expect.objectContaining({
          execution: { defaultTimeoutMs: 45000, defaultRetryLimit: 0 },
        }),
      })
    )
  })
})
