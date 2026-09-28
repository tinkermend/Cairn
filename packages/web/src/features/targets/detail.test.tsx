import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SESSION_POLICY } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { TargetDetailPage } from './detail'

const TARGET_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  fetchTarget: vi.fn(),
  fetchTargetOverview: vi.fn(),
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
  updateTargetAccount: vi.fn(),
  updateTargetSessionPolicy: vi.fn(),
  updateTargetResolutionPolicy: vi.fn(),
  updateTargetAiActionTrace: vi.fn(),
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
vi.mock('@/lib/platform-config-api', () => ({
  fetchPlatformConfig: vi.fn().mockResolvedValue({
    document: {
      platformAi: { enabled: false },
      browserAi: { enabled: false, defaultResolution: 'rule', resolutionCeiling: 'rule' },
      locator: { defaultPlan: { v: 2, order: ['rule'] }, limits: { v: 2, allowed: ['rule'] } },
    },
  }),
}))
let routerSearch: { action?: string; prefill_username?: string; tab?: 'accounts' | 'scenarios' } = {}
const navigateMock = vi.fn()
const accountDialogMock = vi.fn()

vi.mock('./account-form-dialog', () => ({
  AccountFormDialog: (props: { open: boolean; defaultUsername?: string }) => {
    accountDialogMock(props)
    return props.open ? (
      <div data-testid='account-form-dialog' data-username={props.defaultUsername}>
        Account Dialog
      </div>
    ) : null
  },
}))
vi.mock('./target-form-dialog', () => ({ TargetFormDialog: () => null }))
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    getRouteApi: () => ({
      useParams: () => ({ targetId: TARGET_ID }),
      useSearch: () => routerSearch,
    }),
    useNavigate: () => navigateMock,
    Link: ({ children }: { children: ReactNode }) => <a href='#'>{children}</a>,
  }
})

function signIn(permissions = ['target:read', 'target:write', 'target:delete', 'map:read', 'session:read', 'workflow:read']) {
  useAuthStore.getState().auth.setAccessToken('')
  useAuthStore.getState().auth.setUser({
    id: 'u1',
    displayName: '测试',
    email: null,
    roles: [],
    permissions,
    targetScopes: [{ roleId: 'test', mode: 'all', targetIds: [] }],
    targetScopePermissions: [{ roleId: 'test', permissions }],
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
    routerSearch = {}
    navigateMock.mockReset()
    accountDialogMock.mockReset()
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
    mocks.fetchTargetOverview.mockResolvedValue({
      items: [{ target: { id: TARGET_ID }, scenarios: { state: 'available', value: { total: 1, active: 1 } } }],
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.setUser(null)
  })

  it('账号表保留筛选入口，并把关键词交给服务端', async () => {
    const screen = await renderPage()
    await expect.element(screen.getByText('值班账号')).toBeInTheDocument()
    await expect.element(screen.getByText('登录态检测')).toBeInTheDocument()
    await expect.element(screen.getByText('会话', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('未准备')).toBeInTheDocument()
    expect(document.body.innerText).not.toContain('旧模式')
    expect(document.body.innerText).not.toContain('核验等级')
    await expect.element(screen.getByText('期望身份')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('搜索目标账号')).toBeInTheDocument()
    await screen.getByLabelText('搜索目标账号').fill('ops')
    await expect.poll(() => mocks.fetchTargetAccounts.mock.calls[mocks.fetchTargetAccounts.mock.calls.length - 1]?.[1]).toMatchObject({
      search: 'ops',
      limit: 20,
    })
    expect(mocks.fetchSessionOverview).toHaveBeenCalledWith(expect.objectContaining({ targetId: TARGET_ID }))
  })

  it('从 URL 恢复关联场景 Tab', async () => {
    routerSearch = { tab: 'scenarios' }
    const screen = await renderPage()
    await expect.element(screen.getByRole('tab', { name: '关联场景' })).toHaveAttribute('data-state', 'active')
    await expect.element(screen.getByText('商城冒烟巡检')).toBeInTheDocument()
  })

  it('cap>1 时会话列带最坏状态和占用分数', async () => {
    mocks.fetchSessionOverview.mockResolvedValue({
      items: [
        {
          targetId: TARGET_ID,
          targetName: '演示商城',
          targetAccountId: '22222222-2222-4222-8222-222222222222',
          accountDisplayName: '值班账号',
          accountUsername: 'ops',
          accountStatus: 'active',
          status: 'executing',
          retained: false,
          sessionId: 's1',
          generation: 1,
          instanceStatus: 'OPEN',
          authState: 'AUTHENTICATED',
          identityState: null,
          observedTier: null,
          occupyingRunId: 'run-1',
          occupyingOperationId: null,
          retainUntil: null,
          lastAuthCheckedAt: null,
          lastAuthSuccessAt: null,
          ownerWorkerId: 'worker-a',
          primaryAction: 'view',
          liveCount: 2,
          effectiveCap: 3,
        },
      ],
      nextCursor: null,
      summary: {
        total: 1,
        available: 0,
        needsCheck: 0,
        needsLogin: 0,
        identityMismatch: 0,
        maintenance: 0,
        executing: 1,
        lost: 0,
        unprepared: 0,
        retained: 0,
      },
      asOf: '2026-09-21T00:00:00.000Z',
    })
    const screen = await renderPage()
    await expect.element(screen.getByText('执行中', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('2/3', { exact: true })).toBeInTheDocument()
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

  it('支持切换到关联场景与访问范围标签页', async () => {
    signIn()
    const screen = await renderPage()
    await screen.getByRole('tab', { name: /关联场景/ }).click()
    await expect.element(screen.getByText('商城冒烟巡检')).toBeInTheDocument()

    await screen.getByRole('tab', { name: /访问范围/ }).click()
    await expect.element(screen.getByText('目标定位')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('目标默认定位顺序')).toBeInTheDocument()
    await expect.element(screen.getByText(/已配置授权边界/)).toBeInTheDocument()
  })

  it('无登录态检测时不能选用认证保活', async () => {
    const baseTarget = {
      id: TARGET_ID,
      name: '演示商城',
      code: 'shop',
      entryUrl: 'https://shop.example.test',
      authMethod: 'password',
      captchaMode: 'none',
      status: 'active',
      accountCount: 1,
      updatedAt: '2026-09-14T00:00:00.000Z',
      sessionPolicy: null,
      effectiveSessionPolicy: DEFAULT_SESSION_POLICY,
    }
    mocks.fetchTarget.mockResolvedValue(baseTarget)
    mocks.updateTargetSessionPolicy.mockImplementation(async (_id: string, body: { reclaim?: string | null }) => ({
      ...baseTarget,
      sessionPolicy: { reclaim: body.reclaim },
      effectiveSessionPolicy: { ...DEFAULT_SESSION_POLICY, reclaim: body.reclaim },
    }))
    const screen = await renderPage()
    await screen.getByRole('tab', { name: /登录态检测/ }).click()
    await expect.element(screen.getByText('会话策略')).toBeInTheDocument()
    await expect.element(screen.getByText(/未配置登录态检测时不能选用认证保活/)).toBeInTheDocument()
    await screen.getByLabelText('回收模式').click()
    await expect.element(screen.getByRole('option', { name: '认证有效即保活' })).toBeDisabled()
    expect(mocks.updateTargetSessionPolicy).not.toHaveBeenCalled()
  })

  it('页面探测规则展示已登录与已失效定位', async () => {
    mocks.fetchTargetAuthProfile.mockResolvedValue({
      current: {
        revision: 1,
        digest: 'd'.repeat(64),
        createdAt: '2026-09-21T00:00:00.000Z',
        createdBy: null,
        definition: {
          verify: {
            mode: 'page',
            path: '/',
            success: { locator: { by: 'css', value: '.el-menu' } },
            failure: { locator: { by: 'css', value: 'input.input-account[type=password]' } },
          },
          renew: 'none',
          scope: { origins: ['https://shop.example.test'], pathPrefixes: ['/'] },
        },
        validation: null,
      },
      history: [],
      accounts: [
        {
          accountId: '22222222-2222-4222-8222-222222222222',
          expectedIdentity: null,
          configRevision: 1,
          capability: 'LEGACY',
        },
      ],
    })
    const screen = await renderPage()
    await screen.getByRole('tab', { name: /登录态检测/ }).click()
    await expect.element(screen.getByText('页面 DOM 定位')).toBeInTheDocument()
    await expect.element(screen.getByText('CSS 选择器：.el-menu')).toBeInTheDocument()
    await expect.element(screen.getByText('CSS 选择器：input.input-account[type=password]')).toBeInTheDocument()
    await expect.element(screen.getByText('规则已发布、验收未齐（登录态检测未开放）')).toBeInTheDocument()
  })

  it('已验收登录态检测后可覆盖会话回收模式为认证保活', async () => {
    const baseTarget = {
      id: TARGET_ID,
      name: '演示商城',
      code: 'shop',
      entryUrl: 'https://shop.example.test',
      authMethod: 'password',
      captchaMode: 'none',
      status: 'active',
      accountCount: 1,
      updatedAt: '2026-09-14T00:00:00.000Z',
      sessionPolicy: null,
      effectiveSessionPolicy: DEFAULT_SESSION_POLICY,
    }
    mocks.fetchTarget.mockResolvedValue(baseTarget)
    mocks.fetchTargetAuthProfile.mockResolvedValue({
      current: {
        revision: 1,
        digest: 'd'.repeat(64),
        createdAt: '2026-09-19T00:00:00.000Z',
        createdBy: null,
        definition: {
          verify: { mode: 'http', success: { status: 200 }, failure: { status: 401 } },
          renew: 'none',
          scope: { origins: ['https://shop.example.test'], pathPrefixes: ['/'] },
        },
        validation: {
          recordedAt: '2026-09-19T00:00:00.000Z',
          actorId: '11111111-1111-4111-8111-111111111111',
          operationId: '33333333-3333-4333-8333-333333333333',
          steps: {
            valid_pass: {
              authState: 'AUTHENTICATED',
              identityState: 'UNVERIFIED',
              observedIdentity: null,
              unknownClass: null,
              evidenceSummary: 'ok',
              authProfileRevision: 1,
              diagnosticCode: null,
            },
            server_revoked: {
              authState: 'EXPIRED',
              identityState: 'UNVERIFIED',
              observedIdentity: null,
              unknownClass: null,
              evidenceSummary: 'expired',
              authProfileRevision: 1,
              diagnosticCode: null,
            },
          },
        },
      },
      history: [],
      accounts: [],
    })
    mocks.updateTargetSessionPolicy.mockImplementation(async (_id: string, body: { reclaim?: string | null }) => ({
      ...baseTarget,
      sessionPolicy: { reclaim: body.reclaim },
      effectiveSessionPolicy: { ...DEFAULT_SESSION_POLICY, reclaim: body.reclaim },
    }))
    const screen = await renderPage()
    await screen.getByRole('tab', { name: /登录态检测/ }).click()
    await expect.element(screen.getByLabelText('回收模式')).toBeInTheDocument()
    await screen.getByLabelText('回收模式').click()
    await screen.getByRole('option', { name: '认证有效即保活' }).click()
    await expect.poll(() => {
      const calls = mocks.updateTargetSessionPolicy.mock.calls
      return calls[calls.length - 1]?.[1]
    }).toMatchObject({
      reclaim: 'AUTH_DRIVEN',
    })
    await expect.element(screen.getByText(/认证保活不占人工保留配额/)).toBeInTheDocument()
  })

  it('登录核验规则页可覆盖失联处置并提示风险', async () => {
    const baseTarget = {
      id: TARGET_ID,
      name: '演示商城',
      code: 'shop',
      entryUrl: 'https://shop.example.test',
      authMethod: 'password',
      captchaMode: 'none',
      status: 'active',
      accountCount: 1,
      updatedAt: '2026-09-14T00:00:00.000Z',
      sessionPolicy: null,
      effectiveSessionPolicy: DEFAULT_SESSION_POLICY,
    }
    mocks.fetchTarget.mockResolvedValue(baseTarget)
    mocks.updateTargetSessionPolicy.mockImplementation(
      async (_id: string, body: { lostDisposition?: string | null }) => ({
        ...baseTarget,
        sessionPolicy: { lostDisposition: body.lostDisposition },
        effectiveSessionPolicy: { ...DEFAULT_SESSION_POLICY, lostDisposition: body.lostDisposition },
      }),
    )
    const screen = await renderPage()
    await screen.getByRole('tab', { name: /登录态检测/ }).click()
    await expect.element(screen.getByLabelText('失联处置')).toBeInTheDocument()
    await screen.getByLabelText('失联处置').click()
    await screen.getByRole('option', { name: '失联后自动让路' }).click()
    await expect.poll(() => {
      const calls = mocks.updateTargetSessionPolicy.mock.calls
      return calls[calls.length - 1]?.[1]
    }).toMatchObject({
      lostDisposition: 'AUTO',
    })
    await expect.element(screen.getByText(/只释放账本上的活会话键/)).toBeInTheDocument()
  })

  it('可从顶栏点击系统资料查看抽屉', async () => {
    const screen = await renderPage()
    await screen.getByRole('button', { name: /系统资料/ }).click()
    await expect.element(screen.getByText('系统完整资料')).toBeInTheDocument()
    await expect.element(screen.getByText('登录框定位')).toBeInTheDocument()
  })

  it('深链包含 create-account 与 prefill_username 时自动打开弹窗并静默清理 URL', async () => {
    routerSearch = { action: 'create-account', prefill_username: 'auto_admin' }
    const screen = await renderPage()
    await expect.element(screen.getByTestId('account-form-dialog')).toBeInTheDocument()
    expect(accountDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        open: true,
        defaultUsername: 'auto_admin',
      }),
    )
    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/targets/$targetId',
        params: { targetId: TARGET_ID },
        search: {},
        replace: true,
      }),
    )
  })

  it('目标范围不含当前系统时隐藏写操作并拒绝添加账号深链', async () => {
    routerSearch = { action: 'create-account' }
    const current = useAuthStore.getState().auth.user!
    useAuthStore.getState().auth.setUser({
      ...current,
      permissions: [...current.permissions, 'run:delete'],
      targetScopes: [
        { roleId: 'reader', mode: 'all', targetIds: [] },
        { roleId: 'writer', mode: 'selected', targetIds: ['22222222-2222-4222-8222-222222222222'] },
      ],
      targetScopePermissions: [
        { roleId: 'reader', permissions: ['target:read'] },
        { roleId: 'writer', permissions: ['target:write', 'target:delete', 'run:delete'] },
      ],
    })
    const screen = await renderPage()
    await expect.element(screen.getByText('演示商城').first()).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '编辑系统' }).query()).toBeNull()
    expect(screen.getByRole('button', { name: '添加目标账号' }).query()).toBeNull()
    expect(screen.getByRole('button', { name: '删除' }).query()).toBeNull()
    expect(screen.getByTestId('account-form-dialog').query()).toBeNull()
    await expect.poll(() => navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: {}, replace: true }))
  })

  it('账号行正确展示凭据状态、到期倒计时，点击换密可唤起快捷改密弹窗并提交更新', async () => {
    signIn(['target:read', 'target:write', 'credential:read', 'credential:write'])
    const futureDue = new Date(Date.now() + 15 * 86400 * 1000).toISOString()
    mocks.fetchTargetAccounts.mockResolvedValue({
      items: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          targetId: TARGET_ID,
          displayName: '值班账号',
          username: 'ops',
          status: 'active',
          hasPassword: true,
          maintenanceDueAt: futureDue,
          validityPolicy: { mode: 'days', amount: 90, timeZone: 'Asia/Shanghai' },
          configRevision: 1,
          maxConcurrentSessions: 1,
        },
      ],
    })
    mocks.updateTargetAccount.mockResolvedValue({ success: true })
    const screen = await renderPage()
    await expect.element(screen.getByText('剩 15 天')).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: /换密/ })).toBeInTheDocument()

    // 点击换密唤起快捷弹窗
    await screen.getByRole('button', { name: /换密/ }).click()
    await expect.element(screen.getByText('更新目标账号密码')).toBeInTheDocument()
    await expect.element(screen.getByText('值班账号 (ops)')).toBeInTheDocument()

    // 输入新密码并保存
    await screen.getByLabelText('新密码').fill('NewSecret2026!')
    await screen.getByRole('button', { name: '保存新密码' }).click()

    await expect.poll(() => mocks.updateTargetAccount).toHaveBeenCalledWith(
      TARGET_ID,
      '22222222-2222-4222-8222-222222222222',
      expect.objectContaining({
        password: 'NewSecret2026!',
        expectedRevision: 1,
      }),
    )
  })

  it('无 credential:write 权限时不展示换密操作按钮', async () => {
    signIn(['target:read', 'target:write'])
    const screen = await renderPage()
    await expect.element(screen.getByText('值班账号')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /换密/ }).query()).toBeNull()
  })
})
