import '@/styles/index.css'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import {
  createAssistantTurn,
} from '@/lib/assistant-api'
import { AssistantHost } from './host'

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    useRouterState: () => ({ location: { pathname: '/scenarios/sc-1' } }),
  }
})

vi.mock('@/lib/assistant-api', () => ({
  fetchAssistantCapabilities: vi.fn(async () => ({
    items: [
      {
        id: 'platform.guide',
        label: '功能导览',
        available: true,
        missingPermissions: [],
        requiredContext: [],
      },
      {
        id: 'scenario.explain',
        label: '场景解释',
        available: true,
        missingPermissions: [],
        requiredContext: ['scenarioId'],
      },
      {
        id: 'scenario.propose-step',
        label: '步骤建议',
        available: true,
        missingPermissions: [],
        requiredContext: ['scenarioId', 'stepId'],
      },
      {
        id: 'run.diagnose',
        label: '运行诊断',
        available: true,
        missingPermissions: [],
        requiredContext: ['runId'],
      },
      {
        id: 'run.compare',
        label: '运行对比',
        available: true,
        missingPermissions: [],
        requiredContext: ['runId'],
      },
    ],
    modelEnabled: true,
  })),
  createAssistantConversation: vi.fn(async () => ({
    id: 'conv-e2e-1',
    title: '新对话',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  createAssistantTurn: vi.fn(async () => ({
    id: 'turn-e2e-1',
    conversationId: 'conv-e2e-1',
    clientTurnId: 'client-turn-1',
    parentTurnId: null,
    question: '测试提问',
    capabilityId: 'scenario.propose-step',
    status: 'RUNNING',
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    result: null,
    error: null,
    suggestedFollowups: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  fetchAssistantConversations: vi.fn(async () => ({
    items: [],
    nextCursor: null,
  })),
  deleteAssistantConversation: vi.fn(async () => ({ id: 'mock', deleted: true })),
  fetchAssistantTurns: vi.fn(async () => ({ items: [], nextCursor: undefined })),
  fetchAssistantTurn: vi.fn(),
  cancelAssistantTurn: vi.fn(async () => ({ canceled: true })),
  observeAssistantTurn: vi.fn(() => () => {}),
}))

const defaultCapabilities = {
  items: [
    {
      id: 'platform.guide' as const,
      label: '功能导览',
      available: true,
      missingPermissions: [],
      requiredContext: [],
    },
    {
      id: 'scenario.explain' as const,
      label: '场景解释',
      available: true,
      missingPermissions: [],
      requiredContext: ['scenarioId'],
    },
    {
      id: 'scenario.propose-step' as const,
      label: '步骤建议',
      available: true,
      missingPermissions: [],
      requiredContext: ['scenarioId', 'stepId'],
    },
    {
      id: 'run.diagnose' as const,
      label: '运行诊断',
      available: true,
      missingPermissions: [],
      requiredContext: ['runId'],
    },
    {
      id: 'run.compare' as const,
      label: '运行对比',
      available: true,
      missingPermissions: [],
      requiredContext: ['runId'],
    },
  ],
  modelEnabled: true,
}

describe('Assistant Recommendation Engine E2E (Positive & Negative Test Suite)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await page.viewport(1440, 900)
    localStorage.clear()

    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({
      id: 'user-1',
      displayName: 'Workflow Tester',
      email: 'tester@example.com',
      roles: ['author'],
      permissions: ['ai:assist', 'workflow:write', 'workflow:read', 'target:read', 'run:read'],
    })

    useAssistantStore.setState({
      open: true,
      conversationId: 'conv-e2e-1',
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

  describe('正例 1：Studio 聚焦含脆弱选择器步骤时的推荐生成与一键提问闭环', () => {
    it('展示 ✏️ 修改建议、🎯 诊断选择器稳定性、📖 解释此步骤，点击自动填入并提交', async () => {
      useAssistantStore.setState({
        boundContext: {
          page: 'studio',
          scenarioId: 'sc-order',
          selectedStepId: 'step-submit-btn',
          hasCssSelector: true,
        },
      })

      render(<AssistantHost />)

      // 1. 验证 ContextCapsule 渲染了推荐 Chips
      const proposeChip = page.getByRole('button', { name: '✏️ 修改建议', exact: true })
      const selectorChip = page.getByRole('button', { name: '🎯 诊断选择器稳定性', exact: true })
      const explainChip = page.getByRole('button', { name: '📖 解释此步骤', exact: true })

      await expect.element(proposeChip).toBeVisible()
      await expect.element(selectorChip).toBeVisible()
      await expect.element(explainChip).toBeVisible()

      // 2. 验证 PromptCards 出现“场景推荐”置顶分组
      const recommendTab = page.getByRole('tab', { name: '场景推荐' })
      await expect.element(recommendTab).toBeVisible()

      // 3. 点击 Chip 闭环：输入框为空时一键触发对话提问
      await userEvent.click(proposeChip)

      expect(createAssistantTurn).toHaveBeenCalledWith(
        'conv-e2e-1',
        expect.objectContaining({
          question: expect.stringContaining('优化建议'),
          capabilityHint: 'scenario.propose-step',
        })
      )
    })
  })

  describe('正例 2：运行失败且聚焦报错单步状态', () => {
    it('优先展示 🔎 排查当前步骤报错 置顶 Chip', async () => {
      useAssistantStore.setState({
        boundContext: {
          page: 'run',
          runId: 'run-order',
          statusTone: 'error',
          selectedStepId: 'step-failing',
          selectedStepFailed: true,
        },
      })

      render(<AssistantHost />)

      const diagStepChip = page.getByRole('button', { name: '🔎 排查当前步骤报错', exact: true })
      await expect.element(diagStepChip).toBeVisible()
    })
  })

  describe('正例 3：运行详情页失败状态', () => {
    it('展示 🚨 排查本次失败 与 🔄 对比上一次运行', async () => {
      useAssistantStore.setState({
        boundContext: {
          page: 'run',
          runId: 'run-err-123',
          statusTone: 'error',
        },
      })

      render(<AssistantHost />)

      const rcaChip = page.getByRole('button', { name: '🚨 排查本次失败', exact: true })
      const compareChip = page.getByRole('button', { name: '🔄 对比上一次运行', exact: true })

      await expect.element(rcaChip).toBeVisible()
      await expect.element(compareChip).toBeVisible()
    })
  })

  describe('反例 4：Studio 草稿包含未保存修改', () => {
    it('不推荐助手无法读取的本地草稿差异', async () => {
      useAssistantStore.setState({
        boundContext: {
          page: 'studio',
          scenarioId: 'sc-order',
          isDirty: true,
        },
      })

      render(<AssistantHost />)

      const diffChip = page.getByRole('button', { name: '📝 审查未保存改动', exact: true })
      await expect.element(diffChip).not.toBeInTheDocument()
    })
  })

  describe('反例 1：权限门禁兜底（用户缺乏 workflow:write 权限）', () => {
    it('写操作类能力 scenario.propose-step 对应的 Chip 被完全过滤，绝不展示', async () => {
      useAuthStore.getState().auth.setUser({
        id: 'user-ro',
        displayName: 'Read Only User',
        email: 'ro@example.com',
        roles: ['viewer'],
        permissions: ['ai:assist', 'workflow:read', 'run:read'],
      })

      useAssistantStore.setState({
        boundContext: {
          page: 'studio',
          scenarioId: 'sc-order',
          selectedStepId: 'step-submit-btn',
          hasCssSelector: true,
        },
      })

      render(<AssistantHost />)

      // ✏️ 修改建议 与 🎯 优化选择器 依赖 scenario.propose-step (需要 workflow:write) 应被过滤
      const proposeChip = page.getByRole('button', { name: '✏️ 修改建议', exact: true })
      await expect.element(proposeChip).not.toBeInTheDocument()

      // 只读可用的 📖 解释此步骤 仍然保留
      const explainChip = page.getByRole('button', { name: '📖 解释此步骤', exact: true })
      await expect.element(explainChip).toBeVisible()
    })
  })

  describe('反例 2：无 AI 权限（缺乏 ai:assist）', () => {
    it('完全不产出任何推荐 Chips，保持安全静默', async () => {
      useAuthStore.getState().auth.setUser({
        id: 'user-no-ai',
        displayName: 'No AI User',
        email: 'no-ai@example.com',
        roles: ['editor'],
        permissions: ['workflow:read', 'workflow:write'],
      })

      useAssistantStore.setState({
        boundContext: {
          page: 'studio',
          scenarioId: 'sc-order',
          selectedStepId: 'step-submit-btn',
        },
      })

      render(<AssistantHost />)

      const proposeChip = page.getByRole('button', { name: '✏️ 修改建议', exact: true })
      await expect.element(proposeChip).not.toBeInTheDocument()
    })
  })

  describe('反例 3：后端能力接口离线/不可用 (available: false)', () => {
    it('当 scenario.propose-step 离线时，对应的修改类 Chip 自动隐藏，平滑降级', async () => {
      useAssistantStore.setState({
        boundContext: {
          page: 'studio',
          scenarioId: 'sc-order',
          selectedStepId: 'step-submit-btn',
        },
        capabilities: {
          items: [
            {
              id: 'scenario.explain',
              label: '场景解释',
              available: true,
              missingPermissions: [],
              requiredContext: ['scenarioId'],
            },
            {
              id: 'scenario.propose-step',
              label: '步骤建议',
              available: false, // 离线
              missingPermissions: [],
              requiredContext: ['scenarioId', 'stepId'],
            },
          ],
          modelEnabled: true,
        },
      })

      render(<AssistantHost />)

      const proposeChip = page.getByRole('button', { name: '✏️ 修改建议', exact: true })
      await expect.element(proposeChip).not.toBeInTheDocument()

      const explainChip = page.getByRole('button', { name: '📖 解释此步骤', exact: true })
      await expect.element(explainChip).toBeVisible()
    })
  })

  describe('反例 4：Studio 未选中任何步骤', () => {
    it('不展示单步相关 Chips，回退至场景全貌与完整性检查推荐', async () => {
      useAssistantStore.setState({
        boundContext: {
          page: 'studio',
          scenarioId: 'sc-order',
          selectedStepId: undefined,
        },
      })

      render(<AssistantHost />)

      const proposeChip = page.getByRole('button', { name: '✏️ 修改建议', exact: true })
      await expect.element(proposeChip).not.toBeInTheDocument()

      const scenarioExplainChip = page.getByRole('button', { name: '💡 解释场景全貌', exact: true })
      const inspectChip = page.getByRole('button', { name: '🔍 检查逻辑完整性', exact: true })
      await expect.element(scenarioExplainChip).toBeVisible()
      await expect.element(inspectChip).toBeVisible()
    })
  })
})
