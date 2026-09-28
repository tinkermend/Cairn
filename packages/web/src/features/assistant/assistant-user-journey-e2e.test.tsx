import '@/styles/index.css'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { createAssistantTurn } from '@/lib/assistant-api'
import type { CreateAssistantTurnBody } from '@cairn/shared'
import { AssistantHost } from './host'

const { navigate, routeState } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  routeState: { pathname: '/' },
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    useRouterState: () => ({ location: { pathname: routeState.pathname } }),
  }
})

let lastTurnId = 1
vi.mock('@/lib/assistant-api', () => ({
  fetchAssistantCapabilities: vi.fn(async () => ({
    items: [
      { id: 'platform.guide', label: '功能导览', available: true, missingPermissions: [], requiredContext: [] },
      { id: 'scenario.explain', label: '场景解释', available: true, missingPermissions: [], requiredContext: ['scenarioId'] },
      { id: 'scenario.propose-step', label: '步骤建议', available: true, missingPermissions: [], requiredContext: ['scenarioId', 'stepId'] },
      { id: 'run.diagnose', label: '运行诊断', available: true, missingPermissions: [], requiredContext: ['runId'] },
      { id: 'run.compare', label: '运行对比', available: true, missingPermissions: [], requiredContext: ['runId'] },
      { id: 'knowledge.answer', label: '有源问答', available: true, missingPermissions: [], requiredContext: [] },
    ],
    modelEnabled: true,
  })),
  createAssistantConversation: vi.fn(async () => ({
    id: 'conv-user-journey',
    title: '普通用户体验会话',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  createAssistantTurn: vi.fn(async (_convId: string, payload: CreateAssistantTurnBody) => ({
    id: `turn-user-${lastTurnId++}`,
    conversationId: 'conv-user-journey',
    clientTurnId: payload.clientTurnId || `ct-${Date.now()}`,
    parentTurnId: null,
    question: payload.question,
    capabilityId: payload.capabilityHint || 'platform.guide',
    status: 'COMPLETED',
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    result: {
      kind: 'knowledge_answer',
      summary: `已针对「${payload.question}」完成分析与解答。`,
      claims: [
        {
          factKind: 'observed',
          text: `针对问题 "${payload.question}" 找到相关依据`,
          citations: ['help:general'],
        },
      ],
      missing: payload.question.includes('火星')
        ? [{ key: 'query:mars', reason: 'no_matching_facts', message: '未找到相关事实' }]
        : payload.question.includes('uuid-ghost')
          ? [{ key: 'step:uuid-ghost', reason: 'step_not_found', message: '步骤不存在' }]
          : [],
    },
    error: null,
    suggestedFollowups: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  fetchAssistantConversations: vi.fn(async () => ({ items: [], nextCursor: null })),
  deleteAssistantConversation: vi.fn(async () => ({ id: 'mock', deleted: true })),
  fetchAssistantTurns: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  fetchAssistantTurn: vi.fn(),
  cancelAssistantTurn: vi.fn(async () => ({ canceled: true })),
  observeAssistantTurn: vi.fn(() => () => {}),
}))

const defaultCapabilities = {
  items: [
    { id: 'platform.guide' as const, label: '功能导览', available: true, missingPermissions: [], requiredContext: [] },
    { id: 'scenario.explain' as const, label: '场景解释', available: true, missingPermissions: [], requiredContext: ['scenarioId'] },
    { id: 'scenario.propose-step' as const, label: '步骤建议', available: true, missingPermissions: [], requiredContext: ['scenarioId', 'stepId'] },
    { id: 'run.diagnose' as const, label: '运行诊断', available: true, missingPermissions: [], requiredContext: ['runId'] },
    { id: 'run.compare' as const, label: '运行对比', available: true, missingPermissions: [], requiredContext: ['runId'] },
    { id: 'knowledge.answer' as const, label: '有源问答', available: true, missingPermissions: [], requiredContext: [] },
  ],
  modelEnabled: true,
}

describe('普通用户视角：跨菜单页面识途助手端到端正反例与 UI 巡检', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await page.viewport(1440, 900)
    localStorage.clear()

    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({
      id: 'usr-regular',
      displayName: '张工 (普通运维与编排员)',
      email: 'zhang@example.com',
      roles: ['author', 'operator'],
      permissions: ['ai:assist', 'workflow:write', 'workflow:read', 'target:read', 'run:read', 'session:read'],
    })

    useAssistantStore.setState({
      open: true,
      conversationId: 'conv-user-journey',
      turns: [],
      question: '',
      busy: false,
      cancelling: false,
      error: null,
      pageContext: null,
      capabilityHint: undefined,
      capabilities: defaultCapabilities,
      adoptHandler: null,
      rollbackHandler: null,
      activeTurnId: null,
      activeStage: null,
      activeQueuePosition: null,
      thinkingText: '',
      thinkingStream: false,
      mode: 'floating',
      dockWidth: 420,
      activeQuote: null,
      boundContext: null,
      currentBindingOwnerToken: null,
      previewStepId: null,
      lastAdoptedProposalId: null,
      lastAdoptedDigest: null,
      conversations: [],
      historyOpen: false,
      historyLoading: false,
      historyLoadingMore: false,
      historyNextCursor: null,
      historyError: null,
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('菜单 1：首页 / 平台概览页面（无特定实体，全局上下文）', () => {
    it('正例：UI 展示全局上下文徽标与通用助手描述，推荐新手入门导览并支持发问', async () => {
      routeState.pathname = '/'
      useAssistantStore.setState({
        boundContext: null,
        pageContext: null,
      })

      render(<AssistantHost />)

      // UI 巡检 1：标题栏与上下文描述
      const title = page.getByRole('heading', { name: '识途助手' })
      await expect.element(title).toBeVisible()
      const desc = page.getByText('帮你理解场景、分析运行、找到功能入口')
      await expect.element(desc).toBeVisible()

      // UI 巡检 2：ContextCapsule 全局身份（顶部副标题直属呈现，无冗余长句）
      const globalBadge = page.getByText('全局上下文 · 识途通用助理')
      await expect.element(globalBadge).toBeVisible()

      // UI 巡检 3：顶部不再出现重复冗余的通用推荐按钮
      await expect.element(page.getByRole('button', { name: '🚀 快速上手编排' })).not.toBeInTheDocument()

      // UI 巡检 4：下方启动区提供紧凑胶囊（方案 B），展示场景编排指引
      const guideChip = page.getByRole('button', { name: '找到场景编排入口' })
      await expect.element(guideChip).toBeVisible()

      // 用户行为正例：普通用户点击「找到场景编排入口」发起提问
      await userEvent.click(guideChip)
      expect(createAssistantTurn).toHaveBeenCalledWith(
        'conv-user-journey',
        expect.objectContaining({
          question: expect.stringContaining('在哪里打开场景编排和场景工作区？'),
          capabilityHint: 'platform.guide',
        })
      )
    })

    it('反例：普通用户在首页提问完全无关问题（如天气/火星），助手诚实报告缺口', async () => {
      routeState.pathname = '/'
      render(<AssistantHost />)

      const input = page.getByRole('textbox', { name: '向助手提问' })
      await userEvent.fill(input, '火星上有生命存在吗？')
      const sendBtn = page.getByRole('button', { name: '发送' })
      await userEvent.click(sendBtn)

      expect(createAssistantTurn).toHaveBeenCalledWith(
        'conv-user-journey',
        expect.objectContaining({
          question: '火星上有生命存在吗？',
        })
      )
    })
  })

  describe('菜单 2：目标系统详情页（/targets/tgt-erp-01）', () => {
    it('正例：UI 展示目标系统名称与正常状态，推荐检查账号健康度与地图覆盖', async () => {
      routeState.pathname = '/targets/tgt-erp-01'
      useAssistantStore.setState({
        boundContext: {
          page: 'target',
          entityId: '01920000-0000-7000-8000-000000000001',
          targetId: '01920000-0000-7000-8000-000000000001',
          statusLabel: '正常',
          statusTone: 'success',
          summaryText: '目标系统「生产ERP」(erp-01)',
        },
        pageContext: {
          page: 'target',
          targetId: '01920000-0000-7000-8000-000000000001',
        },
      })

      render(<AssistantHost />)

      // UI 巡检：顶部胶囊展示实体简写、状态和描述
      await expect.element(page.getByText('正常')).toBeVisible()
      await expect.element(page.getByText('目标系统「生产ERP」(erp-01)')).toBeVisible()
      await expect.element(page.getByText('#01920000')).toBeVisible()

      // 推荐 Chips 巡检
      const accountHealthChip = page.getByRole('button', { name: '🔑 检查账号健康度', exact: true })
      const mapChip = page.getByRole('button', { name: '🗺️ 目标菜单地图覆盖', exact: true })
      await expect.element(accountHealthChip).toBeVisible()
      await expect.element(mapChip).toBeVisible()

      // 用户点击「🔑 检查账号健康度」
      await userEvent.click(accountHealthChip)
      expect(createAssistantTurn).toHaveBeenCalledWith(
        'conv-user-journey',
        expect.objectContaining({
          question: expect.stringContaining('认证健康状态与会话租约'),
          capabilityHint: 'knowledge.answer',
        })
      )
    })
  })

  describe('菜单 3：会话管理（/sessions）', () => {
    it('正例：进入会话管理页，自动适配目标与会话运维推荐 Chips', async () => {
      routeState.pathname = '/sessions'
      useAssistantStore.setState({
        boundContext: {
          page: 'session',
          targetId: '01920000-0000-7000-8000-000000000002',
        },
        pageContext: {
          page: 'session',
          targetId: '01920000-0000-7000-8000-000000000002',
        },
      })

      render(<AssistantHost />)

      const authReasonChip = page.getByRole('button', { name: '🔑 为什么登录失效', exact: true })
      const occupiedChip = page.getByRole('button', { name: '🔒 会话被谁占用', exact: true })
      const queueChip = page.getByRole('button', { name: '⌛ 为什么开跑一直在等会话', exact: true })
      await expect.element(authReasonChip).toBeVisible()
      await expect.element(occupiedChip).toBeVisible()
      await expect.element(queueChip).toBeVisible()
    })
  })

  describe('菜单 4：场景编排工作台（/scenarios/sc-order-flow）', () => {
    it('反例：未保存草稿只提醒先保存，不承诺分析助手看不到的本地改动', async () => {
      routeState.pathname = '/scenarios/sc-order-flow'
      useAssistantStore.setState({
        boundContext: {
          page: 'studio',
          scenarioId: 'sc-order-flow',
          isDirty: true,
          statusLabel: '场景编排',
          statusTone: 'info',
          summaryText: '订单处理与开票全流程 (v3 草稿已修改)',
        },
        pageContext: {
          page: 'studio',
          scenarioId: 'sc-order-flow',
        },
      })

      render(<AssistantHost />)

      // UI 巡检：黄色警示未保存草稿徽标
      await expect.element(page.getByText('存在未保存草稿')).toBeVisible()
      await expect.element(page.getByText('订单处理与开票全流程 (v3 草稿已修改)')).toBeVisible()

      // 推荐 Chips 巡检
      const explainScenarioChip = page.getByRole('button', { name: '💡 解释场景全貌', exact: true })
      await expect.element(explainScenarioChip).toBeVisible()
      await expect.element(page.getByRole('button', { name: '📝 审查未保存改动', exact: true })).not.toBeInTheDocument()
      await expect.element(page.getByText('当前有未保存修改。助手会依据已保存版本回答；要分析刚才的编辑，请先保存草稿。')).toBeVisible()
    })

    it('反例：输入框已有自己手写的未发送内容时，点击推荐 Chip 不会冲掉输入，而是安全追加', async () => {
      routeState.pathname = '/scenarios/sc-order-flow'
      useAssistantStore.setState({
        boundContext: {
          page: 'studio',
          scenarioId: 'sc-order-flow',
        },
        pageContext: {
          page: 'studio',
          scenarioId: 'sc-order-flow',
        },
      })

      render(<AssistantHost />)

      const input = page.getByRole('textbox', { name: '向助手提问' })
      await userEvent.fill(input, '请结合财务部门规范，')

      const explainChip = page.getByRole('button', { name: '💡 解释场景全貌', exact: true })
      await userEvent.click(explainChip)

      // 输入框内容安全保留手写前缀，追加了 Chip 的提问文本，且绝不意外清空或覆盖
      await expect.element(input).toHaveValue('请结合财务部门规范，\n请解释当前场景的业务流程、步骤时序与全局契约。')
    })
  })

  describe('菜单 5：运行记录详情（/runs/run-failed-001）', () => {
    it('正例：运行报错页面，红色错误警示与步骤报错诊断、根因分析、对比上一次运行一目了然', async () => {
      routeState.pathname = '/runs/run-failed-001'
      useAssistantStore.setState({
        boundContext: {
          page: 'run',
          runId: 'run-failed-001',
          selectedStepId: 'step-click-pay',
          selectedStepFailed: true,
          statusLabel: '运行失败',
          statusTone: 'error',
          summaryText: '支付超时：等待页面响应超过 30s',
        },
        pageContext: {
          page: 'run',
          runId: 'run-failed-001',
          stepId: 'step-click-pay',
        },
      })

      render(<AssistantHost />)

      // UI 巡检：红色错误状态与失败摘要
      await expect.element(page.getByText('运行失败', { exact: true })).toBeVisible()
      await expect.element(page.getByText('支付超时：等待页面响应超过 30s')).toBeVisible()

      // 推荐 Chips 巡检（置顶当前报错步骤诊断）
      const stepDiagChip = page.getByRole('button', { name: '🔎 排查当前步骤报错', exact: true })
      const rcaChip = page.getByRole('button', { name: '🚨 排查本次失败', exact: true })
      const compareChip = page.getByRole('button', { name: '🔄 对比上一次运行', exact: true })
      await expect.element(stepDiagChip).toBeVisible()
      await expect.element(rcaChip).toBeVisible()
      await expect.element(compareChip).toBeVisible()

      // 用户点击「🔎 排查当前步骤报错」
      await userEvent.click(stepDiagChip)
      expect(createAssistantTurn).toHaveBeenCalledWith(
        'conv-user-journey',
        expect.objectContaining({
          question: expect.stringContaining('当前步骤记录了什么错误'),
          capabilityHint: 'run.diagnose',
        })
      )
    })

    it('反例：普通用户试图查询不存在的虚构步骤或历史版本，系统诚实反馈不捏造', async () => {
      routeState.pathname = '/runs/run-failed-001'
      render(<AssistantHost />)

      const input = page.getByRole('textbox', { name: '向助手提问' })
      await userEvent.fill(input, '请诊断步骤 uuid-ghost 的执行表现')
      const sendBtn = page.getByRole('button', { name: '发送' })
      await userEvent.click(sendBtn)

      expect(createAssistantTurn).toHaveBeenCalledWith(
        'conv-user-journey',
        expect.objectContaining({
          question: '请诊断步骤 uuid-ghost 的执行表现',
        })
      )
    })
  })
})
