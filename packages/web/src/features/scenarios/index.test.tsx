import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { ScenariosPage } from './index'

const mocks = vi.hoisted(() => ({
  fetchScenarios: vi.fn(),
  fetchTargets: vi.fn(async () => ({ items: [{ id: 'target-1', name: '商城后台' }], nextCursor: undefined })),
  previewDeleteScenario: vi.fn(async () => ({ impact: 'none' })),
  deleteScenario: vi.fn(async () => ({ success: true })),
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
    getRouteApi: () => ({
      useSearch: () => ({ targetId: undefined }),
    }),
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={String(to)}>{children}</a>,
  }
})

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
  previewDeleteScenario: mocks.previewDeleteScenario,
  deleteScenario: mocks.deleteScenario,
  createScenario: vi.fn(),
}))

vi.mock('@/lib/targets-api', () => ({
  fetchTargets: mocks.fetchTargets,
  fetchTarget: vi.fn(),
}))

vi.mock('@/features/assistant/use-assistant-context-binding', () => ({
  useAssistantContextBinding: vi.fn(),
}))

describe('场景编排主列表', () => {
  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
    vi.clearAllMocks()
  })

  it('正确渲染去冗余复合行，操作列平铺详情、查看运行记录与删除，无试跑入口', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试工程师',
      email: null,
      roles: [],
      permissions: ['workflow:read', 'workflow:write', 'run:read', 'workflow:delete', 'target:read'],
    })

    mocks.fetchScenarios.mockResolvedValue({
      items: [
        {
          id: 'sc-1',
          targetId: 'target-1',
          name: '商品创建端到端验收',
          status: 'active',
          purpose: 'user',
          latestVersionId: 'v-1',
          latestVersionNo: 3,
          stepCount: 8,
          draftDirty: true,
          createdAt: '2026-09-28T00:00:00.000Z',
          updatedAt: '2026-09-28T02:00:00.000Z',
          createdByName: '测试架构师',
          latestRun: {
            id: 'run-101',
            status: 'SUCCEEDED',
            outcomeStatus: 'PASS',
            createdAt: '2026-09-28T03:00:00.000Z',
          },
          schedule: {
            id: 'sch-1',
            name: '夜间定时冒烟',
            summary: '每天 02:00',
            enabled: true,
          },
        },
      ],
      nextCursor: undefined,
    })

    const screen = await render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ScenariosPage />
      </QueryClientProvider>,
    )

    // 1. 验证 PageHeader
    await expect.element(screen.getByRole('heading', { name: '场景编排', exact: true })).toBeInTheDocument()

    // 2. 验证指标卡已被彻底移除（无“本页场景”）
    await expect.element(screen.getByText('本页场景')).not.toBeInTheDocument()
    await expect.element(screen.getByText('本页已启用')).not.toBeInTheDocument()

    // 3. 验证表头清晰列布局（独立调度状态与创建人/时间列，彻底剔除最新版本列）
    await expect.element(screen.getByText('场景与目标系统')).toBeInTheDocument()
    await expect.element(screen.getByText('状态', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('最近运行')).toBeInTheDocument()
    await expect.element(screen.getByText('调度状态')).toBeInTheDocument()
    await expect.element(screen.getByText('创建人 / 时间')).toBeInTheDocument()
    await expect.element(screen.getByText('操作', { exact: true })).toBeInTheDocument()
    await expect.element(screen.getByText('最新版本')).not.toBeInTheDocument()

    // 4. 验证复合实体行与元数据副标
    await expect.element(screen.getByText('商品创建端到端验收')).toBeInTheDocument()
    await expect.element(screen.getByText('商城后台')).toBeInTheDocument()
    await expect.element(screen.getByText('8 个步骤')).toBeInTheDocument()
    await expect.element(screen.getByText('业务场景')).toBeInTheDocument()

    // 5. 验证状态（彻底无多余 v3 版本号徽标）
    const table = screen.getByRole('table')
    await expect.element(table.getByText('已启用')).toBeInTheDocument()
    await expect.element(table.getByText('草稿')).toBeInTheDocument()
    await expect.element(screen.getByText('v3')).not.toBeInTheDocument()

    // 6. 验证最近运行（仅显示 正常/异常 与相对时间穿透链接，杜绝复杂业务通过标签）
    await expect.element(screen.getByText('正常')).toBeInTheDocument()
    await expect.element(screen.getByRole('link', { name: /正常/ })).toBeInTheDocument()

    // 7. 验证调度状态
    await expect.element(screen.getByText('每天 02:00')).toBeInTheDocument()

    // 8. 验证创建人与创建时间信息
    await expect.element(screen.getByText('测试架构师')).toBeInTheDocument()

    // 8. 验证彻底无试跑按钮与多余详情按钮
    await expect.element(screen.getByRole('button', { name: /试跑/ })).not.toBeInTheDocument()
    await expect.element(screen.getByRole('link', { name: '详情' })).not.toBeInTheDocument()

    // 场景名称本身作为进入详情的直接链接
    await expect.element(screen.getByRole('link', { name: '商品创建端到端验收' })).toBeInTheDocument()

    // 9. 验证精炼操作：运行记录与删除
    await expect.element(screen.getByRole('link', { name: /运行记录/ })).toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: /删除场景/ })).toBeInTheDocument()

    // 点击删除拉起二次确认弹窗
    const deleteBtn = screen.getByRole('button', { name: /删除场景/ })
    await deleteBtn.click()
    await expect.element(screen.getByRole('alertdialog')).toBeInTheDocument()
  })

  it('权限受限用户（无 run:read 与 workflow:delete）不显示运行记录和删除按钮', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u2',
      displayName: '只读审计员',
      email: null,
      roles: [],
      permissions: ['workflow:read', 'target:read'],
    })

    mocks.fetchScenarios.mockResolvedValue({
      items: [
        {
          id: 'sc-2',
          targetId: 'target-1',
          name: '仅查看场景',
          status: 'disabled',
          purpose: 'user',
          latestVersionId: 'v-2',
          latestVersionNo: 1,
          stepCount: 3,
          draftDirty: false,
          createdAt: '2026-09-28T00:00:00.000Z',
          updatedAt: '2026-09-28T02:00:00.000Z',
        },
      ],
      nextCursor: undefined,
    })

    const screen = await render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ScenariosPage />
      </QueryClientProvider>,
    )

    await expect.element(screen.getByText('仅查看场景')).toBeInTheDocument()
    // 运行记录与删除不可见
    await expect.element(screen.getByRole('link', { name: /运行记录/ })).not.toBeInTheDocument()
    await expect.element(screen.getByRole('button', { name: /删除场景/ })).not.toBeInTheDocument()
  })
})

