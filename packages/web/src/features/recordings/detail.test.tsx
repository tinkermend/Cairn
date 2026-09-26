import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecordingDraftDetailDto } from '@cairn/shared'
import { parseDemonstrationFile } from '@cairn/authoring'
import { useAuthStore } from '@/stores/auth-store'
import { RecordingDetailPage } from './detail'

const mocks = vi.hoisted(() => ({
  fetchRecording: vi.fn(),
  renameRecording: vi.fn(),
  deleteRecording: vi.fn(),
  fetchDemonstration: vi.fn(),
  fetchDemonstrationImage: vi.fn(),
  fetchScenarios: vi.fn(),
  createScenario: vi.fn(),
  // 详情页里的目标定位字段（authoring/fields/target.tsx）会查能力清单；
  // 这里返回 undefined，页面按「能力未知」渲染，与真实的加载中状态一致。
  fetchScenarioCapabilities: vi.fn(async () => undefined),
  fetchRecordingGeneralization: vi.fn<() => Promise<any>>(async () => null),
  observeRecordingGeneralization: vi.fn(() => () => {}),
  submitRecordingGeneralizationRound: vi.fn(),
  acceptRecordingGeneralizationRound: vi.fn(),
  rejectRecordingGeneralizationRound: vi.fn(),
  revertRecordingGeneralizationRound: vi.fn(),
  handoffCreateScenario: vi.fn(),
}))

vi.mock('@/lib/recordings-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/recordings-api')>()
  return {
    ...actual,
    fetchRecording: mocks.fetchRecording,
    renameRecording: mocks.renameRecording,
    deleteRecording: mocks.deleteRecording,
    fetchRecordingGeneralization: mocks.fetchRecordingGeneralization,
    observeRecordingGeneralization: mocks.observeRecordingGeneralization,
    submitRecordingGeneralizationRound: mocks.submitRecordingGeneralizationRound,
    acceptRecordingGeneralizationRound: mocks.acceptRecordingGeneralizationRound,
    rejectRecordingGeneralizationRound: mocks.rejectRecordingGeneralizationRound,
    revertRecordingGeneralizationRound: mocks.revertRecordingGeneralizationRound,
    handoffCreateScenario: mocks.handoffCreateScenario,
  }
})

vi.mock('@/lib/demonstrations-api', () => ({
  fetchDemonstration: mocks.fetchDemonstration,
  fetchDemonstrationImage: mocks.fetchDemonstrationImage,
}))

vi.mock('@/lib/scenarios-api', () => ({
  fetchScenarios: mocks.fetchScenarios,
  createScenario: mocks.createScenario,
  fetchScenarioCapabilities: mocks.fetchScenarioCapabilities,
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
    mocks.fetchRecordingGeneralization.mockResolvedValue(null)
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
    await screen.getByRole('button', { name: '取消' }).click()
  })

  it('已回填草稿同时展示前往对应 Studio 与再次回填到场景按钮', async () => {
    mocks.fetchRecording.mockResolvedValue({
      ...mockDraft,
      imported: true,
      importedScenarioId: 'sc-999',
    })

    const screen = await renderPage()

    await expect.element(screen.getByText('已回填到场景')).toBeVisible()
    await expect.element(screen.getByRole('link', { name: '前往对应 Studio' })).toBeVisible()
    const reHandoffBtn = screen.getByRole('button', { name: '再次回填到场景...' })
    await expect.element(reHandoffBtn).toBeVisible()

    await reHandoffBtn.click()
    await expect.element(screen.getByText('回填录制草稿到场景')).toBeVisible()
    await screen.getByRole('button', { name: '取消' }).click()
  })

  it('支持在步骤流水线中忽略与恢复步骤', async () => {
    const screen = await renderPage()

    await expect.element(screen.getByText('(已剔除 1 步)')).not.toBeInTheDocument()

    // 找到第一步的“忽略”按钮并点击
    const ignoreButtons = screen.getByRole('button', { name: '忽略' })
    await ignoreButtons.first().click()

    await expect.element(screen.getByText('(已剔除 1 步)')).toBeVisible()
    await expect.element(screen.getByText('已忽略')).toBeVisible()

    // 再次点击“恢复”
    await screen.getByRole('button', { name: '恢复' }).click()
    await expect.element(screen.getByText('(已剔除 1 步)')).not.toBeInTheDocument()
  })

  it('支持 demonstration@1 协议草稿展示统一工作台与原始示教视图切换', async () => {
    const demoDraft: RecordingDraftDetailDto = {
      ...mockDraft,
      sourceProtocol: 'demonstration@1',
      sourceVersion: 'cairn-crx-capture@1',
    }
    mocks.fetchRecording.mockResolvedValue(demoDraft)
    const validSource = parseDemonstrationFile({
      profile: 'midscene-yaml-flow@1',
      targetId: '00000000-0000-4000-8000-000000000001',
      captureId: '00000000-0000-4000-8000-000000000002',
      text: 'web:\n  url: https://finance.example.com/login\ntasks:\n  - flow:\n      - aiTap: 登录',
    })
    mocks.fetchDemonstration.mockResolvedValue({
      recordingDraftId: 'rec-123',
      source: validSource,
      artifacts: [],
    })

    const screen = await renderPage()

    // 依然展示统一工作台
    await expect.element(screen.getByText('操作步骤流水线 (3)')).toBeVisible()
    const rawViewBtn = screen.getByRole('button', { name: '原始示教视图' })
    await expect.element(rawViewBtn).toBeVisible()

    // 切换为原始示教事实溯源视图
    await rawViewBtn.click()
    await expect.element(screen.getByText('原始示教事实溯源')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '返回步骤流水线工作台' })).toBeVisible()

    // 返回工作台
    await screen.getByRole('button', { name: '返回步骤流水线工作台' }).click()
    await expect.element(screen.getByText('操作步骤流水线 (3)')).toBeVisible()
  })

  it('支持 demonstration@1 协议草稿展示 AI 意图泛化与候选场景预览', async () => {
    const demoDraft: RecordingDraftDetailDto = {
      ...mockDraft,
      sourceProtocol: 'demonstration@1',
      sourceVersion: 'cairn-crx-capture@1',
    }
    mocks.fetchRecording.mockResolvedValue(demoDraft)

    const mockGeneralizationData = {
      generalization: {
        id: 'gen-123',
        recordingDraftId: 'rec-123',
        revision: 1,
        status: 'editing' as const,
        factDigest: '11'.repeat(32),
        suggestionDigest: '22'.repeat(32),
        adapterVersion: 'midscene@1',
        ruleVersion: 'recording-generalization@1',
        candidateDigest: '33'.repeat(32),
        decisions: [{ id: 'rec_0', disposition: 'accept' as const }],
        rounds: [
          {
            roundId: 'round-1',
            source: 'rule' as const,
            intent: '放宽等待调参',
            status: 'proposed' as const,
            decisionPatches: [],
            operations: [
              {
                kind: 'set_step_policy' as const,
                id: 'op-1',
                stepId: 'step_0',
                timeoutMs: 30000,
              },
            ],
            intentCoverage: [],
            diffs: [],
            diagnostics: [],
            createdAt: '2026-09-26T12:00:00.000Z',
          },
        ],
        createdAt: '2026-09-26T12:00:00.000Z',
        updatedAt: '2026-09-26T12:00:00.000Z',
      },
      candidateDocument: {
        authoringSchemaVersion: 2 as const,
        schemaVersion: 1,
        inputs: [{ key: 'account', label: '账号', type: 'string' as const }],
        nodes: [
          {
            kind: 'step' as const,
            step: {
              type: 'navigate' as const,
              id: 'step_0',
              name: '打开登录页面',
              effectType: 'READ_ONLY' as const,
              timeoutMs: 30000,
              input: { targetUrl: 'https://finance.example.com/login' },
              outcomes: [
                {
                  id: 'oc-1',
                  scope: 'step' as const,
                  meaning: '页面加载成功',
                  severity: 'MUST' as const,
                  onViolation: 'halt' as const,
                  provenance: 'manual' as const,
                  rule: {
                    kind: 'deterministic' as const,
                    assert: { kind: 'status_ok' as const },
                  },
                },
              ],
            },
          },
        ],
      },
    }
    mocks.fetchRecordingGeneralization.mockResolvedValue(mockGeneralizationData)
    mocks.acceptRecordingGeneralizationRound.mockResolvedValue({
      generalization: {
        ...mockGeneralizationData.generalization,
        revision: 2,
        rounds: [
          {
            ...mockGeneralizationData.generalization.rounds[0]!,
            status: 'accepted' as const,
          },
        ],
      },
      candidateDocument: mockGeneralizationData.candidateDocument,
    })

    const screen = await renderPage()

    // 顶部展示 4 个分段页签
    await expect.element(screen.getByRole('tab', { name: /流水工作台/ })).toBeVisible()
    await expect.element(screen.getByRole('tab', { name: /AI 意图泛化/ })).toBeVisible()
    await expect.element(screen.getByRole('tab', { name: /候选场景预览/ })).toBeVisible()
    await expect.element(screen.getByRole('tab', { name: /原始示教事实/ })).toBeVisible()

    // 切换到 AI 意图泛化
    await screen.getByRole('tab', { name: /AI 意图泛化/ }).click()
    await expect.element(screen.getByText(/泛化轮次历史/)).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '放宽等待调参' })).toBeVisible()
    await expect.element(screen.getByText('待审查')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '采纳' })).toBeVisible()

    // 点击采纳
    await screen.getByRole('button', { name: '采纳' }).click()
    expect(mocks.acceptRecordingGeneralizationRound).toHaveBeenCalledWith('rec-123', 'round-1')

    // 切换到候选场景预览
    await screen.getByRole('tab', { name: /候选场景预览/ }).click()
    await expect.element(screen.getByText(/候选场景草稿/)).toBeVisible()
    await expect.element(screen.getByText('打开登录页面')).toBeVisible()
    await expect.element(screen.getByText('页面加载成功')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '以草稿新建场景' })).toBeVisible()
  })
})
