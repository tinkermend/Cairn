import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import '@/styles/index.css'
import { SuiteDetailPage } from './detail'

const mocks = vi.hoisted(() => ({
  fetchSuite: vi.fn(),
  fetchSuiteRun: vi.fn(),
  fetchScenarios: vi.fn(async () => ({
    items: [
      { id: 'sc-1', name: '登录巡检场景', latestVersionId: 'v1' },
      { id: 'sc-2', name: '风控拦截场景', latestVersionId: 'v2' },
    ],
  })),
  fetchTarget: vi.fn(async () => ({ id: 'target-01', name: 'modelapi中转站' })),
  fetchTargetAccounts: vi.fn(async () => ({
    items: [
      { id: 'acc-1', displayName: '管理员', username: 'admin@modelapi.io' },
    ],
  })),
  saveSuiteDraft: vi.fn(),
  validateSuite: vi.fn(async () => ({ ok: true, issues: [] })),
  publishSuite: vi.fn(async () => ({
    id: 'suite-01',
    status: 'active',
    published: { id: 'pub-1', versionNo: 2 },
    draft: { revision: 2, document: {} },
  })),
  updateSuiteEnabled: vi.fn(),
  createSuiteRun: vi.fn(),
  previewSuiteRun: vi.fn(),
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useParams: () => ({
      suiteId: 'suite-01',
    }),
    useNavigate: () => mocks.navigate,
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={String(to)}>{children}</a>,
  }
})

vi.mock('@/lib/suites-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/suites-api')>()
  return {
    ...actual,
    fetchSuite: mocks.fetchSuite,
    fetchSuiteRun: mocks.fetchSuiteRun,
    saveSuiteDraft: mocks.saveSuiteDraft,
    validateSuite: mocks.validateSuite,
    publishSuite: mocks.publishSuite,
    updateSuiteEnabled: mocks.updateSuiteEnabled,
    createSuiteRun: mocks.createSuiteRun,
    previewSuiteRun: mocks.previewSuiteRun,
  }
})

vi.mock('@/lib/targets-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/targets-api')>()
  return {
    ...actual,
    fetchTarget: mocks.fetchTarget,
    fetchTargetAccounts: mocks.fetchTargetAccounts,
  }
})

vi.mock('@/lib/scenarios-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/scenarios-api')>()
  return {
    ...actual,
    fetchScenarios: mocks.fetchScenarios,
  }
})

vi.mock('@/hooks/use-permissions', () => ({
  useCan: () => true,
}))

vi.mock('@/components/rbac/can', () => ({
  Can: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('SuiteDetailPage 左右双栏流水线工作台 UI 验收', () => {
  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
  })

  it('展示左右双栏工作台架构：左侧流水线编排工作区 + 右侧属性检查器', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '管理员',
      email: null,
      roles: [],
      permissions: ['suite:read', 'suite:write', 'run:execute', 'target:read', 'workflow:read'],
    })

    mocks.fetchSuite.mockResolvedValue({
      id: 'suite-01',
      targetId: 'target-01',
      name: 'modelapi中转站-全链路巡检套件',
      description: '每日巡检工作套件',
      status: 'active',
      draft: {
        revision: 1,
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            {
              memberId: 'm1',
              ordinal: 0,
              scenarioId: 'sc-1',
              scenarioVersionId: 'v1',
              displayName: '账号登录检查',
              input: {},
            },
          ],
          sharedInput: { env: 'production' },
          executionMode: 'parallel',
          maxConcurrency: 4,
          failurePolicy: 'continue',
          autoGenerateFinalReport: true,
        },
      },
      published: { id: 'pub-0', versionNo: 1 },
      deletedAt: null,
      deletedBy: null,
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render(
      <QueryClientProvider client={queryClient}>
        <SuiteDetailPage />
      </QueryClientProvider>,
    )
    await page.viewport(1440, 900)

    // 1. 顶部 Header 验证
    await expect.element(page.getByText('所属目标系统: modelapi中转站')).toBeVisible()
    await expect.element(page.getByText('已发布 v1')).toBeVisible()
    await expect.element(page.getByText('已启用')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '启动运行' })).toBeVisible()
    await expect.element(page.getByRole('button', { name: '保存草稿' })).toBeVisible()

    // 2. 左侧流水线工作区（Pipeline Workspace）验证
    await expect.element(page.getByText('流水线编排')).toBeVisible()
    await expect.element(page.getByText('平铺序列 (1 个场景)')).toBeVisible()
    await expect.element(page.getByLabelText('m1 展示名称')).toHaveValue('账号登录检查')
    await expect.element(page.getByText('登录巡检场景')).toBeVisible()

    // 3. 右侧属性与运行环境检查器（Suite Inspector）验证
    await expect.element(page.getByText('基本信息')).toBeVisible()
    await expect.element(page.getByLabelText('名称', { exact: true })).toHaveValue('modelapi中转站-全链路巡检套件')
    await expect.element(page.getByLabelText('说明')).toHaveValue('每日巡检工作套件')
    await expect.element(page.getByText('执行与并发策略')).toBeVisible()
    await expect.element(page.getByLabelText('最大并发数 (1–10)')).toHaveValue(4)
    await expect.element(page.getByText('全局公共参数 (Shared Input)')).toBeVisible()
    await expect.element(page.getByText('集合报告')).toBeVisible()

    await page.screenshot({ path: '__screenshots__/split-view-preview.png' })
  })

  it('支持切换至多阶段依赖流水线编排模式并展示阶段管道', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '管理员',
      email: null,
      roles: [],
      permissions: ['suite:read', 'suite:write', 'run:execute', 'target:read', 'workflow:read'],
    })

    mocks.fetchSuite.mockResolvedValue({
      id: 'suite-01',
      targetId: 'target-01',
      name: '多阶段巡检套件',
      description: null,
      status: 'active',
      draft: {
        revision: 1,
        document: {
          schemaVersion: 1,
          groups: [],
          members: [],
          stages: [
            {
              id: 'stage-1',
              name: '准备阶段',
              ordinal: 0,
              executionMode: 'sequential',
              maxConcurrency: 1,
              failurePolicy: 'stop',
              members: [
                {
                  memberId: 'm_auth',
                  ordinal: 0,
                  scenarioId: 'sc-1',
                  scenarioVersionId: 'v1',
                  displayName: '环境探访与Token生成',
                  targetAccountId: 'acc-1',
                  input: { env: 'prod' },
                },
              ],
            },
            {
              id: 'stage-2',
              name: '并发压测阶段',
              ordinal: 1,
              executionMode: 'parallel',
              maxConcurrency: 3,
              failurePolicy: 'continue',
              members: [],
            },
          ],
          sharedInput: {},
          executionMode: 'parallel',
          maxConcurrency: 3,
          failurePolicy: 'continue',
          autoGenerateFinalReport: false,
        },
      },
      published: null,
      deletedAt: null,
      deletedBy: null,
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render(
      <QueryClientProvider client={queryClient}>
        <SuiteDetailPage />
      </QueryClientProvider>,
    )
    await page.viewport(1440, 900)

    await expect.element(page.getByText('多阶段依赖编排 (2 个阶段)')).toBeVisible()
    await expect.element(page.getByText('Stage 1')).toBeVisible()
    await expect.element(page.getByText('Stage 2')).toBeVisible()
    await expect.element(page.getByLabelText('阶段 1 名称')).toHaveValue('准备阶段')
    await expect.element(page.getByLabelText('阶段 2 名称')).toHaveValue('并发压测阶段')
    await expect.element(page.getByText('未发布草稿')).toBeVisible()

    await page.screenshot({ path: '__screenshots__/split-view-stages-preview.png' })
  })

  it('支持通过场景库查找对话框搜索并选择场景加入编排', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '管理员',
      email: null,
      roles: [],
      permissions: ['suite:read', 'suite:write', 'run:execute', 'target:read', 'workflow:read'],
    })

    mocks.fetchSuite.mockResolvedValue({
      id: 'suite-01',
      targetId: 'target-01',
      name: 'modelapi中转站-全链路巡检套件',
      description: '每日巡检工作套件',
      status: 'active',
      draft: {
        revision: 1,
        document: {
          schemaVersion: 1,
          groups: [],
          members: [
            {
              memberId: 'm1',
              ordinal: 0,
              scenarioId: 'sc-1',
              scenarioVersionId: 'v1',
              displayName: '账号登录检查',
              input: {},
            },
          ],
          sharedInput: {},
          executionMode: 'parallel',
          maxConcurrency: 4,
          failurePolicy: 'continue',
        },
      },
      published: { id: 'pub-0', versionNo: 1 },
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await render(
      <QueryClientProvider client={queryClient}>
        <SuiteDetailPage />
      </QueryClientProvider>,
    )
    await page.viewport(1440, 900)

    const findButton = page.getByRole('button', { name: '查找...' })
    await findButton.click()

    await expect.element(page.getByText('选择场景加入场景集')).toBeVisible()
    await expect.element(page.getByText('风控拦截场景')).toBeVisible()

    await page.screenshot({ path: '__screenshots__/split-view-picker-preview.png' })
  })
})
