import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@/styles/index.css'
import {
  FACTORY_PLATFORM_CONFIG,
  PERMISSIONS,
  PLATFORM_AI_PROVIDER_PRESETS,
  PLATFORM_AI_PROVIDER_REQUIRED_MESSAGE,
  PLATFORM_AI_THINKING_UNSUPPORTED_MESSAGE,
} from '@cairn/shared'
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
  registerMonitorAlertChannel: vi.fn(),
}))

vi.mock('@/lib/monitoring-api', () => ({
  registerMonitorAlertChannel: mocks.registerMonitorAlertChannel,
}))

vi.mock('@/lib/platform-config-api', () => ({
  fetchPlatformConfig: mocks.fetchPlatformConfig,
  fetchPlatformConfigRevisions: mocks.fetchPlatformConfigRevisions,
  registerPlatformConfigSecret: mocks.registerPlatformConfigSecret,
  restorePlatformConfig: mocks.restorePlatformConfig,
  testPlatformConfigConnection: vi.fn(),
  updatePlatformConfig: mocks.updatePlatformConfig,
  validatePlatformConfig: vi.fn(),
}))

// 存量文档形态：出厂预填提供商之前落库的平台 AI 没有 provider 键，用来构造「尚未选提供商」的场景。
const { provider: _factoryProvider, ...LEGACY_PLATFORM_AI } = FACTORY_PLATFORM_CONFIG.platformAi

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
    window.history.replaceState({}, '', '/')
  })

  it('管理员能看见五组策略，主操作是保存并生效，页面不回显密钥', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await expect
      .element(screen.getByRole('heading', { name: '平台配置' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: '浏览器 AI' }))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('tab', { name: '平台 AI' }))
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
    await expect
      .element(screen.getByLabelText('AI 定位能力上限', { exact: true }))
      .toHaveTextContent('仅规则')
    await expect
      .element(screen.getByLabelText('平台默认优先顺序', { exact: true }))
      .toHaveTextContent('规则优先，AI 兜底')
    expect(screen.getByText('请选择').elements()).toHaveLength(0)
    expect(document.body.innerText).not.toMatch(/sk-|apiKey/)
    expect(JSON.stringify(current)).not.toMatch(/sk-|apiKey/)
    await screen.getByRole('tab', { name: '会话策略' }).click()
    await expect.element(screen.getByLabelText('失联处置', { exact: true })).toBeInTheDocument()
    await expect
      .element(screen.getByText('原节点优先等待'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('维护操作排队期限'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('默认核验新鲜度'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('时段内自动登录次数'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('验证码机器尝试次数'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('验证码人工接管等待'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('单次人工保留上限'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('每次运行自动登录恢复次数'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('每次运行人工认证恢复次数'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('提交后等待离开登录页'))
      .toBeInTheDocument()
    await expect
      .element(screen.getByText('每节点预留空闲位'))
      .toBeInTheDocument()
  })

  it('普通用户选定仅文本能力上限后保存，修订中保留所选档位', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByLabelText('AI 定位能力上限', { exact: true }).click()
    await screen.getByRole('option', { name: /文本定位（规则/ }).click()
    await expect
      .element(screen.getByLabelText('AI 定位能力上限', { exact: true }))
      .toHaveTextContent('文本定位')
    await screen.getByLabelText('变更原因', { exact: true }).fill('仅文本验收')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await vi.waitFor(() => expect(mocks.updatePlatformConfig).toHaveBeenCalledTimes(1))
    expect(mocks.updatePlatformConfig.mock.calls[0]![0].document.browserAi.resolutionCeiling)
      .toBe('prefer_deterministic_text')
    await expect.element(screen.getByText(/当前修订 2/)).toBeInTheDocument()
  })

  it('新版配置把允许集合与默认顺序分开选择并预览', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('button', { name: '升级为新版定位配置' }).click()
    await screen.getByLabelText('平台允许的定位能力').click()
    await screen.getByRole('option', { name: '规则和文本模型' }).click()
    await screen.getByLabelText('平台默认定位顺序').click()
    await screen.getByRole('option', { name: '仅文本模型' }).click()
    await expect.element(screen.getByText(/定位计划没有可用路线/)).toBeInTheDocument()
    await screen.getByLabelText('变更原因', { exact: true }).fill('文本定位试验')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await vi.waitFor(() => expect(mocks.updatePlatformConfig).toHaveBeenCalledTimes(1))
    expect(mocks.updatePlatformConfig.mock.calls[0]![0].document.locator).toMatchObject({
      limits: { allowed: ['rule', 'text_ai'] }, defaultPlan: { order: ['text_ai'] },
    })
  })

  it('载入已保存的仅文本上限时，选择框显示当前修订的值', async () => {
    mocks.fetchPlatformConfig.mockResolvedValue({
      ...current,
      revision: 14,
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        browserAi: {
          ...FACTORY_PLATFORM_CONFIG.browserAi,
          resolutionCeiling: 'prefer_deterministic_text',
        },
      },
    })
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await expect.element(screen.getByText(/当前修订 14/)).toBeInTheDocument()
    await screen.getByLabelText('变更原因', { exact: true }).fill('回读检查')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await vi.waitFor(() => expect(mocks.updatePlatformConfig).toHaveBeenCalledTimes(1))
    expect(mocks.updatePlatformConfig.mock.calls[0]![0].document.browserAi.resolutionCeiling)
      .toBe('prefer_deterministic_text')
    await expect
      .element(screen.getByLabelText('AI 定位能力上限', { exact: true }))
      .toHaveTextContent('文本定位')
  })

  it('存量文档缺解析上限时仍显示出厂仅规则', async () => {
    const { resolutionCeiling: _ceiling, defaultResolution: _default, ...browserAi } =
      FACTORY_PLATFORM_CONFIG.browserAi
    mocks.fetchPlatformConfig.mockResolvedValue({
      ...current,
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        browserAi: {
          ...browserAi,
          resolutionCeiling: '',
          defaultResolution: '',
        },
      },
    })
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await expect
      .element(screen.getByLabelText('AI 定位能力上限', { exact: true }))
      .toHaveTextContent('仅规则')
    await expect
      .element(screen.getByLabelText('平台默认优先顺序', { exact: true }))
      .toHaveTextContent('规则优先，AI 兜底')
    expect(screen.getByText('请选择').elements()).toHaveLength(0)
  })

  it('执行默认值展示模块映射三项配置', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    await expect
      .element(screen.getByLabelText('模块映射候选上限', { exact: true }))
      .toHaveValue(10)
    await expect
      .element(screen.getByLabelText('模块映射 AI 候选上限', { exact: true }))
      .toHaveValue(5)
    await expect
      .element(screen.getByLabelText('模块映射记录保留天数', { exact: true }))
      .toHaveValue(90)
    await expect
      .element(screen.getByLabelText('模块质量窗口', { exact: true }))
      .toHaveValue(7)
    await expect
      .element(screen.getByLabelText('模块质量最少样本', { exact: true }))
      .toHaveValue(10)
    await expect
      .element(screen.getByLabelText('模块降级通过率阈值', { exact: true }))
      .toHaveValue(0.8)
    await expect
      .element(screen.getByLabelText('模块连续失败次数', { exact: true }))
      .toHaveValue(3)
    await expect
      .element(screen.getByRole('switch', { name: '开放动作模块冻结回退' }))
      .not.toBeChecked()
    await expect
      .element(screen.getByRole('switch', { name: '开放场景定时执行' }))
      .not.toBeChecked()
    await expect
      .element(screen.getByRole('switch', { name: '开放场景集定时执行' }))
      .not.toBeChecked()
    await expect
      .element(screen.getByRole('switch', { name: '开放知识分析' }))
      .not.toBeChecked()
  })

  it('告警已彻底收敛至统一的通知模块，平台配置不再呈现告警标签页', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    expect(screen.getByRole('tab', { name: '告警' }).elements()).toHaveLength(0)
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
    await screen.getByLabelText('模型服务地址', { exact: true }).fill('https://model.example/v1')
    await screen.getByLabelText('模型密钥', { exact: true }).fill('review-only-fake-key')
    await screen.getByRole('button', { name: '登记密钥', exact: true }).click()
    await expect.element(screen.getByLabelText('模型密钥', { exact: true })).toHaveValue('')
    expect(mocks.registerPlatformConfigSecret).toHaveBeenCalledWith({
      baseUrl: 'https://model.example/v1',
      apiKey: 'review-only-fake-key',
    })
    await expect.element(screen.getByText(/已绑定 Secret/)).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: '解除绑定' })).toBeInTheDocument()
    await screen.getByRole('button', { name: '解除绑定' }).click()
    await expect.element(screen.getByText('未绑定密钥')).toBeInTheDocument()
  })

  it('已绑定密钥在修改服务地址后显示地址已变更警告', async () => {
    mocks.fetchPlatformConfig.mockResolvedValueOnce({
      ...current,
      document: {
        ...current.document,
        browserAi: {
          ...current.document.browserAi,
          baseUrl: 'https://model.example/v1',
          secretRef: {
            provider: 'local',
            secretId: '00000000-0000-4000-8000-000000000010',
          },
        },
      },
    })
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await expect.element(screen.getByText(/已绑定 Secret/)).toBeInTheDocument()
    await screen.getByLabelText('模型服务地址', { exact: true }).fill('https://other-model.example/v1')
    await expect.element(screen.getByText(/地址已变更/)).toBeInTheDocument()
  })

  it('校验失败时保留输入', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    const timeout = screen.getByLabelText('默认步骤超时', { exact: true })
    await timeout.fill('10000')
    await screen.getByLabelText('变更原因', { exact: true }).fill('故意不合法')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await expect.element(screen.getByText(/须小于默认步骤超时/)).toBeInTheDocument()
    expect(mocks.updatePlatformConfig).not.toHaveBeenCalled()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    await expect.element(screen.getByLabelText('默认步骤超时', { exact: true })).toHaveValue(10000)
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
    await screen.getByLabelText('默认步骤超时', { exact: true }).fill('45000')
    await screen.getByLabelText('变更原因', { exact: true }).fill('提高超时')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await expect.element(screen.getByText(/已保留你的输入/)).toBeInTheDocument()
    await expect.element(screen.getByText(/当前修订 2/)).toBeInTheDocument()
    await expect
      .element(screen.getByLabelText('默认步骤超时', { exact: true }))
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
      .element(screen.getByLabelText('默认步骤超时', { exact: true }))
      .toHaveValue(30000)
    await screen.getByLabelText('默认步骤超时', { exact: true }).fill('45000')
    await screen.getByLabelText('变更原因', { exact: true }).fill('重新提高超时')
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
      '平台 AI',
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
    await screen.getByLabelText('默认步骤超时', { exact: true }).fill('45000')
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
      .element(screen.getByLabelText('默认步骤超时', { exact: true }))
      .toHaveValue(45000)
    await expect
      .element(screen.getByRole('button', { name: '保存并生效' }))
      .toBeDisabled()
    expect(mocks.updatePlatformConfig).not.toHaveBeenCalled()
    await screen
      .getByRole('button', { name: '放弃本次修改并载入最新配置' })
      .click()
    await screen.getByLabelText('默认步骤超时', { exact: true }).fill('45000')
    await screen.getByLabelText('变更原因', { exact: true }).fill('仅提高超时')
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
      .element(screen.getByLabelText('默认步骤超时', { exact: true }))
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
      .element(screen.getByLabelText('默认步骤超时', { exact: true }))
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
      .element(screen.getByLabelText('默认步骤超时', { exact: true }))
      .toHaveValue(30000)
    await screen.getByRole('tab', { name: '变更记录' }).click()
    await screen.getByLabelText('恢复原因', { exact: true }).fill('恢复 45 秒配置')
    await screen.getByRole('button', { name: '恢复这一版' }).click()
    await expect.element(screen.getByText(/当前修订 3/)).toBeInTheDocument()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    await expect
      .element(screen.getByLabelText('默认步骤超时', { exact: true }))
      .toHaveValue(45000)
    await screen.getByRole('tab', { name: '会话策略' }).click()
    await screen.getByLabelText('空闲寿命', { exact: true }).fill('900')
    await screen.getByLabelText('变更原因', { exact: true }).fill('延长空闲时间')
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

  it('平台 AI 提供商下拉预填官方地址，自定义地址保留，千问思考开关禁用', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '平台 AI' }).click()
    await expect.element(screen.getByText(/模型厂商/)).toBeInTheDocument()
    await screen.getByLabelText('模型提供商', { exact: true }).click()
    await screen.getByRole('option', { name: 'DeepSeek' }).click()
    await expect
      .element(screen.getByLabelText('模型服务地址', { exact: true }))
      .toHaveValue(PLATFORM_AI_PROVIDER_PRESETS.deepseek.defaultBaseUrl)
    await screen.getByLabelText('模型提供商', { exact: true }).click()
    await screen.getByRole('option', { name: '通义千问' }).click()
    await expect
      .element(screen.getByLabelText('模型服务地址', { exact: true }))
      .toHaveValue(PLATFORM_AI_PROVIDER_PRESETS.qwen.defaultBaseUrl)
    await expect
      .element(screen.getByText(PLATFORM_AI_THINKING_UNSUPPORTED_MESSAGE))
      .toBeInTheDocument()
    await expect
      .element(screen.getByRole('switch', { name: '思考模式' }))
      .toBeDisabled()
    await screen.getByLabelText('模型服务地址', { exact: true }).fill('https://proxy.example/v1')
    await screen.getByLabelText('模型提供商', { exact: true }).click()
    await screen.getByRole('option', { name: '智谱 GLM' }).click()
    await expect
      .element(screen.getByLabelText('模型服务地址', { exact: true }))
      .toHaveValue('https://proxy.example/v1')
  })

  it('平台 AI 模型是随提供商变化的下拉：出厂预填、切换联动、自定义模型名原样保留', async () => {
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '平台 AI' }).click()
    // 出厂已预填 DeepSeek 与其默认模型，用户只需补密钥
    await expect.element(screen.getByLabelText('模型名', { exact: true })).toHaveTextContent('deepseek-flash')
    await expect
      .element(screen.getByLabelText('模型服务地址', { exact: true }))
      .toHaveValue(PLATFORM_AI_PROVIDER_PRESETS.deepseek.defaultBaseUrl)

    await screen.getByLabelText('模型名', { exact: true }).click()
    await screen.getByRole('option', { name: 'deepseek-v4-pro' }).click()
    await expect.element(screen.getByLabelText('模型名', { exact: true })).toHaveTextContent('deepseek-v4-pro')

    // 切到千问：模型跟着换成千问默认，而不是残留 DeepSeek 的名字
    await screen.getByLabelText('模型提供商', { exact: true }).click()
    await screen.getByRole('option', { name: '通义千问' }).click()
    await expect.element(screen.getByLabelText('模型名', { exact: true })).toHaveTextContent('qwen3.8-flash')
    await screen.getByLabelText('模型名', { exact: true }).click()
    for (const id of ['qwen3.8-flash', 'qwen3.8-max', 'qwen3.7-plus', 'qwen3.7-flash']) {
      await expect.element(screen.getByRole('option', { name: id })).toBeInTheDocument()
    }

    // 自定义：出现手填框，切换提供商不覆盖手填值
    await screen.getByRole('option', { name: '自定义…' }).click()
    await screen.getByLabelText('自定义模型名', { exact: true }).fill('my-relay-alias')
    await screen.getByLabelText('模型提供商', { exact: true }).click()
    await screen.getByRole('option', { name: '智谱 GLM' }).click()
    await expect.element(screen.getByLabelText('自定义模型名', { exact: true })).toHaveValue('my-relay-alias')
  })

  it('已启用但缺提供商时，任意页签保存都被同一字段错误拦住', async () => {
    const secretRef = {
      provider: 'local' as const,
      secretId: '00000000-0000-4000-8000-000000000099',
    }
    mocks.fetchPlatformConfig.mockResolvedValue({
      ...current,
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        platformAi: {
          ...LEGACY_PLATFORM_AI,
          enabled: true,
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          secretRef,
        },
      },
    })
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '执行默认值' }).click()
    await screen.getByLabelText('默认步骤超时', { exact: true }).fill('45000')
    await screen.getByLabelText('变更原因', { exact: true }).fill('只改超时')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await expect
      .element(screen.getByText(PLATFORM_AI_PROVIDER_REQUIRED_MESSAGE))
      .toBeInTheDocument()
    expect(mocks.updatePlatformConfig).not.toHaveBeenCalled()
    await expect
      .element(screen.getByRole('tab', { name: '平台 AI' }))
      .toHaveAttribute('data-state', 'active')
  })

  it('平台 AI 页保存时，未挂载的浏览器 AI 解析空串按出厂补齐', async () => {
    const secretRef = {
      provider: 'local' as const,
      secretId: '00000000-0000-4000-8000-000000000099',
    }
    mocks.fetchPlatformConfig.mockResolvedValue({
      ...current,
      document: {
        ...FACTORY_PLATFORM_CONFIG,
        browserAi: {
          ...FACTORY_PLATFORM_CONFIG.browserAi,
          resolutionCeiling: '',
          defaultResolution: '',
        },
        platformAi: {
          ...FACTORY_PLATFORM_CONFIG.platformAi,
          enabled: true,
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          secretRef,
        },
      },
    })
    window.history.replaceState({}, '', '/platform-config?tab=platform-ai')
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByLabelText('变更原因', { exact: true }).fill('补选提供商')
    await screen.getByRole('button', { name: '保存并生效' }).click()
    await vi.waitFor(() => expect(mocks.updatePlatformConfig).toHaveBeenCalledTimes(1))
    expect(mocks.updatePlatformConfig.mock.calls[0]![0]).toMatchObject({
      document: {
        browserAi: {
          resolutionCeiling: 'deterministic_only',
          defaultResolution: 'prefer_deterministic',
        },
        platformAi: { provider: 'deepseek' },
      },
    })
  })

  it('未选提供商时不能启用识途助手', async () => {
    mocks.fetchPlatformConfig.mockResolvedValue({
      ...current,
      document: { ...FACTORY_PLATFORM_CONFIG, platformAi: LEGACY_PLATFORM_AI },
    })
    signIn(PERMISSIONS)
    const screen = await renderPage()
    await screen.getByRole('tab', { name: '平台 AI' }).click()
    await screen.getByRole('switch', { name: '启用识途助手' }).click()
    await expect
      .element(screen.getByText(PLATFORM_AI_PROVIDER_REQUIRED_MESSAGE))
      .toBeInTheDocument()
    expect(mocks.updatePlatformConfig).not.toHaveBeenCalled()
  })
})
