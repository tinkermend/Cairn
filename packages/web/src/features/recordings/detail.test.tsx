import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingDraftDetailDto } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { RecordingDetailPage } from './detail'

const mocks = vi.hoisted(() => ({
  fetchRecording: vi.fn(),
  renameRecording: vi.fn(),
  deleteRecording: vi.fn(),
  fetchScenarios: vi.fn(),
  createScenario: vi.fn(),
}))

vi.mock('@/lib/recordings-api', () => ({
  fetchRecording: mocks.fetchRecording,
  renameRecording: mocks.renameRecording,
  deleteRecording: mocks.deleteRecording,
}))

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
  createScenario: mocks.createScenario,
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useParams: () => ({ recordingId: 'rec-123' }),
    useNavigate: () => vi.fn(),
    Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  }
})

const mockDraft: RecordingDraftDetailDto = {
  id: 'rec-123',
  targetId: 'tgt-1',
  targetName: '财务核算系统',
  name: '报销审批流程录制',
  recordingId: 'rec-session-1',
  sourceVersion: 'playwright-crx@0.15.0',
  eventCount: 5,
  itemCount: 3,
  unresolvedCount: 1,
  createdBy: { id: 'u1', displayName: '张三' },
  imported: false,
  importedScenarioId: undefined,
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
  diagnostics: ['检测到 1 处跨域 iframe 操作'],
  events: [
    {
      name: 'navigate',
      url: 'https://finance.example.com/login',
    },
    {
      name: 'fill',
      selector: 'input#password',
      value: 'secret123',
      markedSensitive: true,
    },
    {
      name: 'custom_gesture',
      selector: 'div.canvas',
    },
  ],
  items: [
    {
      index: 0,
      sourceIndexes: [0],
      status: 'mapped',
      sourceAction: 'navigate',
      name: '打开登录页面',
      candidateStepType: 'navigate',
      input: { targetUrl: 'https://finance.example.com/login' },
      diagnostics: [],
    },
    {
      index: 1,
      sourceIndexes: [1],
      status: 'parameterized',
      sourceAction: 'fill',
      name: '输入密码',
      candidateStepType: 'fill',
      input: { selector: 'input#password', value: '' },
      sensitive: true,
      diagnostics: ['密码明文已脱敏，需绑定参数'],
    },
    {
      index: 2,
      sourceIndexes: [2],
      status: 'unresolved',
      sourceAction: 'custom_gesture',
      name: '未知手势操作',
      diagnostics: ['无法匹配确定性动作'],
    },
  ],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RecordingDetailPage />
    </QueryClientProvider>,
  )
}

describe('录制草稿详情页', () => {
  beforeEach(() => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '张三',
      email: null,
      roles: ['author'],
      permissions: ['workflow:write', 'workflow:delete'],
    })
    mocks.fetchRecording.mockResolvedValue(mockDraft)
    mocks.fetchScenarios.mockResolvedValue({ items: [], nextCursor: null })
  })

  afterEach(() => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.reset()
  })

  it('展示草稿元信息、指标看板条与全局诊断', async () => {
    const screen = await renderPage()

    // 标题与目标系统
    await expect.element(screen.getByText('报销审批流程录制')).toBeVisible()
    await expect.element(screen.getByText('财务核算系统')).toBeVisible()
    await expect.element(screen.getByText('来源 脚本录制')).toBeVisible()
    await expect.element(screen.getByText('创建者: 张三')).toBeVisible()

    // 4 宫格指标卡
    await expect.element(screen.getByText('总操作步骤')).toBeVisible()
    await expect.element(screen.getByText('已就绪', { exact: true })).toBeVisible()
    await expect.element(screen.getByText('待补参数')).toBeVisible()
    await expect.element(screen.getByText('待处理项')).toBeVisible()

    // 全局诊断横幅
    await expect.element(screen.getByText('检测到 1 处跨域 iframe 操作')).toBeVisible()

    // 主操作按钮
    await expect.element(screen.getByRole('button', { name: '回填到场景' })).toBeVisible()
  })

  it('展示步骤流水线并联动右侧透视器审查步骤', async () => {
    const screen = await renderPage()

    // 步骤流水线中的步骤名称
    const stepList = screen.getByRole('list', { name: /录制操作步骤列表/ })
    await expect.element(stepList.getByText('打开登录页面')).toBeVisible()
    await expect.element(stepList.getByText('输入密码')).toBeVisible()
    await expect.element(stepList.getByText('未知手势操作')).toBeVisible()

    // 默认选中第一步，右侧透视器展示候选步骤类型
    await expect.element(screen.getByText('步骤 01 / 3').first()).toBeVisible()
    await expect.element(screen.getByText('https://finance.example.com/login').first()).toBeVisible()

    // 点击第二步（含敏感密码脱敏）
    await stepList.getByText('输入密码').click()

    // 右侧透视器更新为第二步
    await expect.element(screen.getByText('步骤 02 / 3').first()).toBeVisible()
    await expect.element(screen.getByText('敏感数据已自动保护').first()).toBeVisible()
    await expect.element(screen.getByText('input#password').first()).toBeVisible()
  })

  it('支持根据状态快速过滤步骤列表', async () => {
    const screen = await renderPage()

    const stepList = screen.getByRole('list', { name: /录制操作步骤列表/ })

    // 点击“待处理”过滤
    await screen.getByRole('button', { name: '待处理 (1)' }).click()

    // 只有第三步显示，前两步被过滤，右侧透视器自动切换为未知手势操作
    await expect.element(stepList.getByText('未知手势操作')).toBeVisible()
    await expect.element(stepList.getByText('打开登录页面')).not.toBeInTheDocument()

    // 重置回全部
    await screen.getByRole('button', { name: '全部 (3)' }).click()
    await expect.element(stepList.getByText('打开登录页面')).toBeVisible()
  })

  it('点击回填到场景唤起回填引导弹窗', async () => {
    const screen = await renderPage()

    await screen.getByRole('button', { name: '回填到场景' }).click()

    await expect.element(screen.getByText('回填录制草稿到场景')).toBeVisible()
    await expect.element(screen.getByRole('tab', { name: '以草稿新建场景' })).toBeVisible()
  })

  it('已回填草稿展示前往对应 Studio 的主操作', async () => {
    mocks.fetchRecording.mockResolvedValue({
      ...mockDraft,
      imported: true,
      importedScenarioId: 'sc-999',
    })

    const screen = await renderPage()

    await expect.element(screen.getByText('已回填到场景')).toBeVisible()
    await expect.element(screen.getByRole('link', { name: '前往对应 Studio' })).toBeVisible()
  })
})
