import '@/styles/index.css'
import type { AssistantProposal, AssistantTurn } from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import {
  createAssistantTurn,
  fetchAssistantCapabilities,
} from '@/lib/assistant-api'
import { cancelRun } from '@/lib/runs-api'
import { AssistantHost } from './host'

const { navigate, mockRunObservation } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  mockRunObservation: {
    run: {
      id: 'run-active-12345678',
      status: 'RUNNING',
      stepRuns: [
        {
          id: 'sr-1',
          ordinal: 0,
          status: 'RUNNING',
          name: '打开商品页面',
          startedAt: '2026-09-23T00:00:00.000Z',
        },
      ],
    },
    view: null,
    isStreaming: true,
    error: null,
  },
}))

vi.mock('@/features/runs/use-run-observation', () => ({
  useRunObservation: () => mockRunObservation,
}))

let nextTurnToDeliver: AssistantTurn | null = null

function queueAssistantTurn(turn: AssistantTurn) {
  nextTurnToDeliver = turn
}

vi.mock('@/lib/assistant-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assistant-api')>()
  return {
    ...actual,
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
          id: 'run.diagnose',
          label: '运行诊断',
          available: true,
          missingPermissions: [],
          requiredContext: ['runId'],
        },
        {
          id: 'scenario.explain',
          label: '场景解释',
          available: true,
          missingPermissions: [],
          requiredContext: ['scenarioId'],
        },
      ],
      modelEnabled: true,
    })),
    createAssistantConversation: vi.fn(async () => ({
      id: 'conv-test-1111',
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    })),
    createAssistantTurn: vi.fn(async () => ({
      turnId: nextTurnToDeliver?.id ?? 'turn-mock-1',
      stage: 'queued',
      queuePosition: 1,
    })),
    cancelAssistantTurn: vi.fn(async () => ({ ok: true })),
    fetchAssistantTurns: vi.fn(async () => []),
    observeAssistantTurn: vi.fn((_convId, _turnId, handlers) => {
      if (nextTurnToDeliver) {
        const turn = nextTurnToDeliver
        nextTurnToDeliver = null
        setTimeout(() => {
          handlers.onReady?.({ realtime: true, thinkingStream: false })
          handlers.onTurn?.(turn)
        }, 10)
      }
      return () => {}
    }),
  }
})

vi.mock('@/lib/runs-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runs-api')>()
  return {
    ...actual,
    cancelRun: vi.fn(async () => undefined),
  }
})

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    useRouterState: () => ({
      location: { pathname: '/runs/run-test-111' },
    }),
  }
})

function buildTurn(
  result: AssistantTurn['result'],
  question: string,
  capabilityId: AssistantTurn['capabilityId'] = 'platform.guide',
): AssistantTurn {
  return {
    id: `turn-${Math.random().toString(36).slice(2, 9)}`,
    conversationId: 'conv-test-1111',
    clientTurnId: `client-${Math.random().toString(36).slice(2, 9)}`,
    parentTurnId: null,
    question,
    capabilityId,
    status: 'COMPLETED',
    deadlineAt: '2026-09-23T00:01:00.000Z',
    result,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  }
}

async function openAssistant() {
  const screen = await render(<AssistantHost />)
  const openBtn = screen.getByRole('button', { name: '打开识途助手' })
  await openBtn.click()
  return screen
}

describe('识途助手：正反例综合场景、页面布局与核心能力全链路测试', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    localStorage.clear()
    await page.viewport(1440, 900)

    vi.mocked(fetchAssistantCapabilities).mockResolvedValue({
      items: [
        {
          id: 'platform.guide',
          label: '功能导览',
          available: true,
          missingPermissions: [],
          requiredContext: [],
        },
        {
          id: 'run.diagnose',
          label: '运行诊断',
          available: true,
          missingPermissions: [],
          requiredContext: ['runId'],
        },
        {
          id: 'scenario.explain',
          label: '场景解释',
          available: true,
          missingPermissions: [],
          requiredContext: ['scenarioId'],
        },
      ],
      modelEnabled: true,
    })

    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({
      id: 'tester-admin',
      displayName: '测试工程师',
      email: 'tester@cairn.local',
      roles: ['admin'],
      permissions: ['ai:assist', 'run:read', 'run:write', 'run:cancel', 'workflow:read', 'workflow:write', 'target:read'],
    })

    useAssistantStore.setState({
      open: false,
      mode: 'floating',
      conversationId: null,
      turns: [],
      question: '',
      busy: false,
      error: null,
      pageContext: null,
      boundContext: null,
      activeQuote: null,
      activeStage: null,
      thinkingText: undefined,
      trackedRunId: null,
      capabilityHint: undefined,
      capabilities: null,
      adoptHandler: null,
      rollbackHandler: null,
      lastAdoptedProposalId: null,
      previewStepId: null,
    })
  })

  afterEach(() => {
    useAssistantStore.getState().cancel()
    useAssistantStore.getState().closePanel()
    useAuthStore.getState().auth.setUser(null)
  })

  /* ========================================================================
   * 1. 页面布局与视口自适应 (Layout & Viewport Adaptability)
   * ======================================================================== */
  describe('维度 1: 页面布局与视口自适应', () => {
    it('正例：悬浮模式默认 400x600，支持拖动与双击标题栏复原', async () => {
      await openAssistant()
      const dialog = page.getByRole('dialog', { name: '识途助手' }).element()
      expect(Math.round(dialog.getBoundingClientRect().width)).toBe(400)
      expect(Math.round(dialog.getBoundingClientRect().height)).toBe(600)

      // 双击标题栏确保复原在右下角
      const headerTitle = page.getByRole('heading', { name: '识途助手', exact: true })
      await userEvent.dblClick(headerTitle)
      const bounds = dialog.getBoundingClientRect()
      expect(bounds.right).toBe(1416)
      expect(bounds.bottom).toBe(876)
    })

    it('正例：支持平滑切换至 Docked 停靠模式并在本地持久化', async () => {
      await openAssistant()
      const dockBtn = page.getByRole('button', { name: '停靠到右侧边栏' })
      await dockBtn.click()

      expect(useAssistantStore.getState().mode).toBe('docked')
      expect(localStorage.getItem('cairn:assistant:window_mode')).toBe('docked')

      // 验证渲染为右侧伴随区域
      const sidebarRegion = page.getByRole('region', { name: '识途助手伴随侧栏' })
      await expect.element(sidebarRegion).toBeVisible()

      // 点击恢复悬浮
      const floatBtn = page.getByRole('button', { name: '恢复悬浮窗' })
      await floatBtn.click()
      expect(useAssistantStore.getState().mode).toBe('floating')
    })

    it('正例：窄屏（小于 1280px）停靠模式自适应转为右侧滑出抽屉 Overlay', async () => {
      await page.viewport(1024, 768)
      useAssistantStore.setState({ mode: 'docked' })
      await openAssistant()

      // 窄屏下作为带遮罩的 dialog 呈现
      const drawerDialog = page.getByRole('dialog', { name: '识途助手伴随侧栏' })
      await expect.element(drawerDialog).toBeVisible()

      // 点击关闭按钮可正常关闭
      await page.getByRole('button', { name: '关闭识途助手' }).click()
      expect(useAssistantStore.getState().open).toBe(false)
    })

    it('反例与极端视口：高度仅 400px 矮屏下，输入框与关闭按钮依然完整可达无截断', async () => {
      await page.viewport(390, 400)
      await openAssistant()

      const dialog = page.getByRole('dialog', { name: '识途助手' }).element()
      const sendBtn = page.getByRole('button', { name: '发送', exact: true }).element()
      const closeBtn = page.getByRole('button', { name: '关闭识途助手' }).element()

      expect(sendBtn.getBoundingClientRect().bottom).toBeLessThanOrEqual(dialog.getBoundingClientRect().bottom)
      expect(closeBtn.getBoundingClientRect().top).toBeGreaterThanOrEqual(dialog.getBoundingClientRect().top)
    })

    it('正例：支持键盘快捷键 Cmd/Ctrl + J 快速切换助手展开与收起', async () => {
      await render(<AssistantHost />)
      expect(useAssistantStore.getState().open).toBe(false)

      // 按下 Cmd+J 呼出
      await userEvent.keyboard('{Meta>}j{/Meta}')
      expect(useAssistantStore.getState().open).toBe(true)

      // 再次按下 Cmd+J 收起
      await userEvent.keyboard('{Meta>}j{/Meta}')
      expect(useAssistantStore.getState().open).toBe(false)
    })
  })

  /* ========================================================================
   * 2. 深度上下文感知与引导 Chips (Context Capsule & Prompt Guidance)
   * ======================================================================== */
  describe('维度 2: 深度上下文感知与引导 Chips', () => {
    it('正例：Run 页面错误态上下文胶囊呈现与点击推荐 Chip 自动提交', async () => {
      useAssistantStore.setState({
        boundContext: {
          page: 'run',
          entityId: 'run-999-fail',
          statusLabel: '运行失败 · 第 4 步网络超时',
          statusTone: 'error',
          summaryText: '步骤 4 在等待 selector 时超过 5000ms 预算。',
          chips: [
            {
              label: '诊断超时原因',
              question: '请结合日志分析第 4 步超时的根本原因',
              capabilityHint: 'run.diagnose',
            },
          ],
        },
      })

      queueAssistantTurn(
        buildTurn(
          {
            kind: 'diagnosis',
            observedAt: new Date().toISOString(),
            eventSeq: 1,
            facts: [{ id: 'f1', text: '页面未能加载目标商品列表', citations: [] }],
            hypotheses: [{ text: '后端接口响应超时导致 DOM 渲染延迟', citations: [] }],
            missingInformation: [],
            nextActions: [{ kind: 'run.evidence', label: '查看失败截图', href: '/runs/run-999-fail?tab=evidence', citations: [] }],
          },
          '请结合日志分析第 4 步超时的根本原因',
          'run.diagnose',
        ),
      )

      await openAssistant()

      // 验证上下文胶囊展示
      await expect.element(page.getByText('运行失败 · 第 4 步网络超时')).toBeVisible()
      await expect.element(page.getByText('步骤 4 在等待 selector 时超过 5000ms 预算。')).toBeVisible()

      // 点击推荐 Chip
      const chipBtn = page.getByRole('button', { name: '诊断超时原因' })
      await chipBtn.click()

      // 验证自动触发提问并渲染诊断事实
      await expect.element(page.getByText('已确认事实')).toBeVisible()
      await expect.element(page.getByText('页面未能加载目标商品列表')).toBeVisible()
      await expect.element(page.getByText('查看失败截图')).toBeVisible()
    })

    it('正例：空态下呈现开箱即用的通用推荐引导列表，点击一键提问', async () => {
      await openAssistant()
      await expect.element(page.getByText('有什么可以帮你？')).toBeVisible()

      const guideShortcut = page.getByRole('button', { name: /找到场景编排入口/ })
      await expect.element(guideShortcut).toBeVisible()

      queueAssistantTurn(
        buildTurn(
          {
            kind: 'guide',
            items: [
              {
                topic: 'studio',
                title: '从零编排自动化流程指南',
                steps: '进入场景工作室，在画布中添加并配置自动化步骤与断言。',
                href: '/scenarios/sc-1',
                availability: 'available',
              },
            ],
          },
          '如何在场景工作室中从零编排一个自动化流程？请介绍步骤类型与最佳实践。',
        ),
      )

      await guideShortcut.click()
      await expect.element(page.getByText('从零编排自动化流程指南')).toBeVisible()
      await expect.element(page.getByRole('button', { name: '打开入口' })).toBeVisible()
    })

    it('反例：当未配置大模型时，展示明确停用警示胶囊并禁用提问输入区', async () => {
      vi.mocked(fetchAssistantCapabilities).mockResolvedValue({
        items: [
          {
            id: 'platform.guide',
            label: '功能导览',
            available: true,
            missingPermissions: [],
            requiredContext: [],
          },
        ],
        modelEnabled: false,
      })

      await openAssistant()
      await expect
        .element(page.getByTestId('model-disabled-banner'))
        .toBeVisible()
      await expect
        .element(page.getByText('平台 AI 尚未启用或未配置模型。请在平台配置中接入模型提供商后使用助手。'))
        .toBeVisible()
      await expect
        .element(page.getByRole('textbox', { name: '向助手提问' }))
        .toBeDisabled()
      await expect.element(page.getByTestId('assistant-prompt-cards')).not.toBeInTheDocument()
    })
  })

  /* ========================================================================
   * 3. 对象选区与步骤引用 (@Quote to Assistant)
   * ======================================================================== */
  describe('维度 3: 对象选区与步骤引用', () => {
    it('正例：展示 Quote Pill 药丸标签与针对性 Placeholder', async () => {
      useAssistantStore.setState({
        activeQuote: {
          type: 'step_failure',
          targetId: 'step-click-pay',
          title: '步骤 #5: 点击支付按钮',
          summary: 'locator.click: Element is disabled',
        },
      })

      await openAssistant()

      // 验证 Quote Pill 呈现
      const quotePill = page.getByTestId('quote-pill')
      await expect.element(quotePill).toBeVisible()
      await expect.element(page.getByText('步骤 #5: 点击支付按钮')).toBeVisible()

      // 验证输入框针对性占位提示
      const textarea = page.getByRole('textbox', { name: '向助手提问' })
      expect(textarea.element().getAttribute('placeholder')).toContain('针对选中的对象提问')
    })

    it('正例与反例：支持通过点击关闭按钮或空输入时 Backspace 清除引用，非空不误删', async () => {
      useAssistantStore.setState({
        activeQuote: {
          type: 'scenario_step',
          targetId: 'step-1',
          title: '步骤 #1: 打开登录页',
          summary: 'goto https://example.com/login',
        },
      })

      await openAssistant()
      const textarea = page.getByRole('textbox', { name: '向助手提问' })

      // 反例保护：输入框有文本时，按 Backspace 仅删文本，不清除 Quote
      await textarea.fill('测试文字')
      await userEvent.keyboard('{Backspace}')
      expect(useAssistantStore.getState().activeQuote).not.toBeNull()

      // 清空文本后再按 Backspace，成功清除 Quote
      await textarea.fill('')
      await userEvent.keyboard('{Backspace}')
      expect(useAssistantStore.getState().activeQuote).toBeNull()
    })
  })

  /* ========================================================================
   * 4. 问答意图分派与输出结果渲染 (Intent Routing & Results)
   * ======================================================================== */
  describe('维度 4: 问答意图分派与输出结果渲染', () => {
    it('正例：功能导览 Guide 输出，点击“打开入口”执行深链跳转并关闭面板', async () => {
      useAssistantStore.setState({
        turns: [
          buildTurn(
            {
              kind: 'guide',
              items: [
                {
                  topic: 'accounts',
                  title: '配置免登凭据',
                  steps: '在目标配置中导入 StorageState 或账号口令。',
                  href: '/targets/tgt-111?action=create-account',
                  availability: 'available',
                },
              ],
            },
            '如何配置免登？',
          ),
        ],
      })

      await openAssistant()
      const openEntranceBtn = page.getByRole('button', { name: '打开入口' })
      await openEntranceBtn.click()

      expect(navigate).toHaveBeenCalledWith({
        to: '/targets/$targetId',
        params: { targetId: 'tgt-111' },
        search: { action: 'create-account' },
      })
      expect(useAssistantStore.getState().open).toBe(false)
    })

    it('正例：结构化提案 Proposal 与 In-situ Diff 渲染、在 Studio 中定位与采纳/撤回闭环', async () => {
      const mockAdopt = vi.fn(async () => ({ ok: true as const }))
      const mockRollback = vi.fn(async () => ({ ok: true as const }))

      const proposalResult: AssistantProposal = {
        kind: 'proposal',
        change: { kind: 'ai_instruction', instruction: '修正提交按钮定位器' },
        document: { steps: [] } as unknown as AssistantProposal['document'],
        stepId: 'step-submit',
        draftRevision: 1,
        documentDigest: '0'.repeat(64),
        reason: '修正提交按钮定位器并增加 8000ms 容错超时',
        executable: true,
        diffs: [
          {
            fieldPath: ['selector', 'value'],
            from: '#btn-submit-old',
            to: 'button[type="submit"]',
            changeType: 'modify',
          },
          {
            fieldPath: ['timeoutMs'],
            from: undefined,
            to: 8000,
            changeType: 'add',
          },
        ],
        diagnostics: [],
      }

      useAssistantStore.setState({
        adoptHandler: mockAdopt,
        rollbackHandler: mockRollback,
        pageContext: { page: 'studio', scenarioId: 'scenario-1' },
        turns: [buildTurn(proposalResult, '修复提交按钮定位失败问题')],
      })

      await openAssistant()

      // 验证 Diff 区域结构与高亮类
      await expect.element(page.getByText('变更比对')).toBeVisible()
      await expect.element(page.getByText('- #btn-submit-old')).toBeVisible()
      await expect.element(page.getByText('+ button[type="submit"]')).toBeVisible()
      await expect.element(page.getByText('+ 8000')).toBeVisible()
      await expect.element(page.getByText(/静态预检：语法有效/)).toBeVisible()

      // 点击“在 Studio 中定位”
      const locateBtn = page.getByRole('button', { name: '在 Studio 中定位' })
      await locateBtn.click()
      expect(useAssistantStore.getState().previewStepId).toBe('step-submit')

      // 点击“采纳到本地草稿”
      const adoptBtn = page.getByRole('button', { name: '采纳到本地草稿' })
      await adoptBtn.click()
      expect(mockAdopt).toHaveBeenCalledWith(proposalResult)

      // 验证采纳后状态切换
      useAssistantStore.setState({ lastAdoptedProposalId: 'step-submit' })
      await expect.element(page.getByText('已放入草稿')).toBeVisible()

      // 点击“撤销采纳”
      const rollbackBtn = page.getByRole('button', { name: '撤销采纳' })
      await rollbackBtn.click()
      expect(mockRollback).toHaveBeenCalledWith(proposalResult)
    })

    it('流式分析只展示阶段，不公开模型原始推理文本', async () => {
      useAssistantStore.setState({
        busy: true,
        activeStage: 'generating',
        thinkingText: '正在分析网页 DOM 树结构中的表单元素...',
      })

      await openAssistant()
      await expect.element(page.getByText('正在生成答复…')).toBeVisible()
      await expect.element(page.getByText('正在分析网页 DOM 树结构中的表单元素...')).not.toBeInTheDocument()
    })

    it('反例：模糊问句触发 Clarify 澄清选项，点击选项继续分派', async () => {
      useAssistantStore.setState({
        turns: [
          buildTurn(
            {
              kind: 'clarify',
              question: '请问您需要诊断当前的失败运行，还是了解平台功能入口？',
              missingFields: ['capabilityId'],
              options: [
                { id: 'run.diagnose', label: '运行排障诊断' },
                { id: 'platform.guide', label: '查找功能入口' },
              ],
            },
            '帮我看看',
          ),
        ],
      })

      await openAssistant()
      await expect.element(page.getByText('请问您需要诊断当前的失败运行，还是了解平台功能入口？')).toBeVisible()

      const optionBtn = page.getByRole('button', { name: '运行排障诊断' })
      await optionBtn.click()
      expect(createAssistantTurn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ capabilityHint: 'run.diagnose' }),
      )
    })

    it('反例：超出能力边界 Unsupported 诚实说明，不伪造回答', async () => {
      useAssistantStore.setState({
        turns: [
          buildTurn(
            {
              kind: 'unsupported',
              reasonCode: 'TASK_UNSUPPORTED',
              message: '抱歉，预订机票属于外部消费级服务，不在识途平台自动化受管能力范围内。',
            },
            '帮我买张明天的机票',
          ),
        ],
      })

      await openAssistant()
      await expect.element(page.getByText(/预订机票属于外部消费级服务/)).toBeVisible()
    })

    it('反例与异常恢复：网络或服务端异常时弹出错误提示，且输入框内容完好保留支持重试', async () => {
      vi.mocked(createAssistantTurn).mockRejectedValueOnce(new Error('Gateway Timeout (504)'))
      await openAssistant()

      const input = page.getByRole('textbox', { name: '向助手提问' })
      await input.fill('分析这次批量运行的结果')

      const sendBtn = page.getByRole('button', { name: '发送', exact: true })
      await sendBtn.click()

      // 验证 Alert 错误反馈
      await expect.element(page.getByRole('alert')).toHaveTextContent('助手请求失败')

      // 验证重要输入未被清空丢弃，用户可重试
      await expect.element(input).toHaveValue('分析这次批量运行的结果')
      expect(sendBtn.element().getAttribute('disabled')).toBeNull()
    })

    it('反例防护：空输入或纯空格时发送按钮禁用，按 Enter 键不发请求', async () => {
      await openAssistant()
      const sendBtn = page.getByRole('button', { name: '发送', exact: true })
      expect(sendBtn.element().getAttribute('disabled')).not.toBeNull()

      const input = page.getByRole('textbox', { name: '向助手提问' })
      await input.fill('    ')
      expect(sendBtn.element().getAttribute('disabled')).not.toBeNull()

      await userEvent.keyboard('{Enter}')
      expect(createAssistantTurn).not.toHaveBeenCalled()
    })
  })

  /* ========================================================================
   * 5. 微型运行监控坞 (Mini Run Tracker)
   * ======================================================================== */
  describe('维度 5: 微型运行监控坞', () => {
    it('正例：活跃 Run 展示步进进度，支持一键发送中止请求', async () => {
      useAssistantStore.setState({
        trackedRunId: 'run-active-12345678',
      })

      await openAssistant()
      const tracker = page.getByTestId('mini-run-tracker')
      await expect.element(tracker).toBeVisible()
      await expect.element(page.getByText('运行监控 · run-acti…')).toBeVisible()

      // 点击中止按钮
      const abortBtn = page.getByRole('button', { name: '中止运行' })
      await abortBtn.click()
      expect(cancelRun).toHaveBeenCalledWith('run-active-12345678')

      // 点击关闭监控坞
      const closeTrackerBtn = page.getByRole('button', { name: '关闭运行监控坞' })
      await closeTrackerBtn.click()
      expect(useAssistantStore.getState().trackedRunId).toBeNull()
    })
  })
})
