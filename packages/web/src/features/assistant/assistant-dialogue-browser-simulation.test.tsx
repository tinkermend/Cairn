import '@/styles/index.css'
import type { AssistantProposal, AssistantTurn } from '@cairn/shared'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { ApiRequestError } from '@/lib/api-client'
import {
  cancelAssistantTurn,
  createAssistantTurn,
  fetchAssistantTurn,
  observeAssistantTurn,
} from '@/lib/assistant-api'
import { AssistantHost } from './host'
import { useAssistantContextBinding } from './use-assistant-context-binding'

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    useRouterState: () => ({ location: { pathname: '/runs/r-1' } }),
  }
})

let nextTurnToDeliver: AssistantTurn | null = null
let latestObservationHandlers: Parameters<typeof observeAssistantTurn>[2] | null = null
const observationCleanup = vi.fn()

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
          id: 'run.compare',
          label: '对比两次运行',
          available: true,
          missingPermissions: [],
          requiredContext: ['baseRunId', 'targetRunId'],
        },
        {
          id: 'scenario.discover',
          label: '场景发现',
          available: true,
          missingPermissions: [],
          requiredContext: [],
        },
        {
          id: 'scenario.explain',
          label: '解释场景',
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
      ],
      modelEnabled: true,
    })),
    createAssistantConversation: vi.fn(async () => ({
      id: 'conv-browser-sim-1',
      title: '测试对话',
      createdAt: '2026-09-23T00:00:00.000Z',
      updatedAt: '2026-09-23T00:00:00.000Z',
    })),
    createAssistantTurn: vi.fn(async (_cid: string, body: { question: string }) => {
      if (body.question === '__TRIGGER_CONFLICT__') {
        throw new ApiRequestError(409, {
          code: 'ASSISTANT_CONCURRENCY_CONFLICT',
          message: '任务版本已更新，请重新加载后再试',
          requestId: 'req-conflict-1',
        })
      }
      return {
        turnId: 'turn-sim-100',
        taskId: 'turn-sim-100',
        state: 'RUNNING',
        stage: 'accepted',
        eventSeq: 1,
        queuePosition: null,
      }
    }),
    cancelAssistantTurn: vi.fn(async () => ({ canceled: true })),
    deleteAssistantConversation: vi.fn(async () => ({ id: 'mock', deleted: true })),
    fetchAssistantConversations: vi.fn(async () => ({ items: [], nextCursor: null })),
    fetchAssistantTurns: vi.fn(async () => ({ items: [] })),
    fetchAssistantTurn: vi.fn(async () => nextTurnToDeliver),
    observeAssistantTurn: vi.fn(
      (_cid: string, _tid: string, callbacks: Parameters<typeof actual.observeAssistantTurn>[2]) => {
        latestObservationHandlers = callbacks
        if (nextTurnToDeliver) {
          const toSend = nextTurnToDeliver
          setTimeout(() => {
            callbacks.onTurn?.(toSend)
          }, 10)
        }
        return observationCleanup
      },
    ),
  }
})

function makeTurn(result: unknown, question = '测试提问'): AssistantTurn {
  return {
    id: `turn-id-${Math.random().toString(36).slice(2, 8)}`,
    conversationId: 'conv-browser-sim-1',
    clientTurnId: `client-turn-${Math.random().toString(36).slice(2, 8)}`,
    parentTurnId: null,
    question,
    capabilityId: 'scenario.discover',
    status: 'COMPLETED',
    deadlineAt: '2026-09-23T00:05:00.000Z',
    result: result as AssistantTurn['result'],
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  }
}

function makeObservedTurn(status: AssistantTurn['status']): AssistantTurn {
  return {
    ...makeTurn(null, '查询运行状态'),
    id: 'turn-sim-100',
    status,
    stage: status === 'RUNNING' ? 'generating' : 'persisting',
    result: status === 'COMPLETED' ? { kind: 'guide', items: [] } : null,
  }
}

describe('识途助手：浏览器端仿真验证与全交互逻辑测试 (Browser Simulation Verification)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    nextTurnToDeliver = null
    latestObservationHandlers = null
    await page.viewport(1440, 900)
    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({
      id: 'tester-1',
      displayName: '测试工程师',
      email: 'tester@cairn.io',
      roles: ['admin'],
      permissions: ['ai:assist', 'run:read', 'target:read', 'workflow:read', 'workflow:write'],
    })
    useAssistantStore.setState({
      open: true,
      mode: 'floating',
      conversationId: 'conv-browser-sim-1',
      turns: [],
      question: '',
      busy: false,
      error: null,
      pageContext: null,
      boundContext: null,
      capabilityHint: undefined,
      capabilities: null,
      adoptHandler: null,
      lastAdoptedProposalId: null,
    })
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
    useAssistantStore.getState().cancel()
    useAssistantStore.getState().newConversation()
    useAssistantStore.getState().closePanel()
  })

  // --------------------------------------------------------------------------
  // 正例 1: 场景发现候选列表防撑开与单行截断、Tooltip 及下一页翻页交互 (PD-01, PD-03)
  // --------------------------------------------------------------------------
  it('正例 1 (PD-01, PD-03): 场景发现结果容器具备滚动上限 (max-h-60)，长名称文本单行截断并支持 Tooltip，提供下一页按钮', async () => {
    const veryLongName =
      '超长ERP供应链财务对账系统每日自动批量处理发票与银行电子对账单流水多层核验并自动告警上报场景'
    const candidates = [
      {
        id: 'sc-1',
        name: veryLongName,
        targetId: 't-erp',
        targetName: 'ERP财务系统',
        kind: 'scenario',
        versionOrRevision: 3,
        status: 'active',
      },
      {
        id: 'sc-2',
        name: '[模块] 智能表单填写公共子模块',
        targetId: 't-oa',
        targetName: 'OA办公平台',
        kind: 'scenario',
        versionOrRevision: 1,
        status: 'active',
      },
    ]

    const turn = makeTurn(
      {
        kind: 'discovery',
        message: '已检索到 2 个可用场景候选（还有更多）：',
        candidates,
        scope: {
          entityType: 'scenario',
          filter: '对账',
        },
        coverage: {
          totalVisible: 2,
          hasMore: true,
          nextCursor: 'cur-page-2',
          observedAt: '2026-09-23T00:00:00.000Z',
        },
      },
      '找对账相关的场景',
    )
    useAssistantStore.setState({ turns: [turn] })

    render(<AssistantHost />)

    // 1. 验证候选项容器存在 max-h-60 与 overflow-y-auto，防止超长列表撑爆伴随窗口
    const scrollContainer = page.getByRole('list', { name: '场景发现候选列表' })
    await expect.element(scrollContainer).toBeVisible()
    const containerClasses = (await scrollContainer.element()).className
    expect(containerClasses).toContain('max-h-60')
    expect(containerClasses).toContain('overflow-y-auto')

    // 2. 验证长名称具有 title 悬停提示和 truncate 截断样式
    const longNameElem = page.getByText(veryLongName)
    await expect.element(longNameElem).toBeVisible()
    await expect.element(longNameElem).toHaveAttribute('title', veryLongName)
    const nameClasses = (await longNameElem.element()).className
    expect(nameClasses).toContain('truncate')

    // 3. 验证模块标签正常渲染
    const moduleElem = page.getByText('[模块] 智能表单填写公共子模块')
    await expect.element(moduleElem).toBeVisible()

    // 4. 下一页明确关联上一轮，服务端才能沿用筛选条件和游标
    const nextPageBtn = page.getByRole('button', { name: '下一页 / 继续找' })
    await expect.element(nextPageBtn).toBeVisible()
    await userEvent.click(nextPageBtn)
    expect(createAssistantTurn).toHaveBeenCalledWith(
      'conv-browser-sim-1',
      expect.objectContaining({ question: '下一页', replyToTurnId: turn.id }),
    )
  })

  // --------------------------------------------------------------------------
  // 正例 2A: 提示词卡片在全局页面中自动隐藏运行对比卡片 (PD-08)
  // --------------------------------------------------------------------------
  it('正例 2A (PD-08): 运行对比卡片在全局或目标页面自动隐藏', async () => {
    useAssistantStore.setState({
      turns: [],
      pageContext: { page: 'target', targetId: 't-1' },
    })

    render(<AssistantHost />)
    const compareCardGlobal = page.getByRole('button', { name: /对比上一次运行/ })
    await expect.element(compareCardGlobal).not.toBeInTheDocument()
  })

  // --------------------------------------------------------------------------
  // 正例 2B: 提示词卡片在运行页正常呈现，点击直接提交并携带 capabilityHint (PD-08)
  // --------------------------------------------------------------------------
  it('正例 2B (PD-08): 运行对比卡片在运行页呈现，点击直接提交并携带 capabilityHint', async () => {
    useAssistantStore.setState({
      turns: [],
      pageContext: { page: 'run', runId: 'run-12345678' },
    })

    render(<AssistantHost />)
    const compareCardRun = page.getByRole('button', { name: /对比上一次运行/ })
    await expect.element(compareCardRun).toBeVisible()

    await userEvent.click(compareCardRun)
    expect(createAssistantTurn).toHaveBeenCalledWith(
      'conv-browser-sim-1',
      expect.objectContaining({
        capabilityHint: 'run.compare',
        question: '这次运行和上一次相比有什么变化？',
      }),
    )
  })

  // --------------------------------------------------------------------------
  // 正例 2C: 用户手动修改输入内容时，立即清空先前设置的 capabilityHint (PD-06)
  // --------------------------------------------------------------------------
  it('正例 2C (PD-06): 用户手动修改输入框内容时，立即清空先前设置的 capabilityHint', async () => {
    useAssistantStore.setState({
      turns: [],
      question: '如何对比两次运行？',
      capabilityHint: 'run.compare',
      busy: false,
    })

    render(<AssistantHost />)
    const textarea = page.getByRole('textbox', { name: '向助手提问' })
    await userEvent.fill(textarea, '帮我对比昨天和今天的执行情况')
    expect(useAssistantStore.getState().capabilityHint).toBeUndefined()
  })

  // --------------------------------------------------------------------------
  // 正例 3: 澄清等待态显式展示取消任务按钮并支持优雅逃生 (PD-11, PD-14)
  // --------------------------------------------------------------------------
  it('正例 3 (PD-11, PD-14): 助手澄清等待态显式展示“取消本次任务”按钮，点击后立即触发取消并重置会话', async () => {
    const turn = makeTurn(
      {
        kind: 'clarify',
        question: '识别到多个可能的操作，请选择一项继续。',
        missingFields: ['capabilityId'],
        options: [
          { id: 'run.diagnose', label: '运行诊断' },
          { id: 'run.compare', label: '对比两次运行' },
        ],
      },
      '分析一下',
    )
    useAssistantStore.setState({ turns: [turn] })

    render(<AssistantHost />)

    // 验证待选澄清选项
    const optDiagnose = page.getByRole('button', { name: '运行诊断' })
    await expect.element(optDiagnose).toBeVisible()

    // 验证显式的“取消本次任务”按钮
    const cancelBtn = page.getByRole('button', { name: '取消本次任务' })
    await expect.element(cancelBtn).toBeVisible()

    // 点击取消任务，触发 cancelCurrentTask，会话中止并退出等待态
    await userEvent.click(cancelBtn)
    expect(cancelAssistantTurn).toHaveBeenCalledWith('conv-browser-sim-1', turn.id)
  })

  // --------------------------------------------------------------------------
  // 正例 4: Studio 未保存草稿提醒与用户问题分离
  // --------------------------------------------------------------------------
  it('Studio 画布存在未保存修改时，单独提醒版本来源且不改写用户问题', async () => {
    useAssistantStore.setState({
      turns: [],
      pageContext: { page: 'studio', scenarioId: 'sc-123' },
      boundContext: {
        page: 'studio',
        scenarioId: 'sc-123',
        statusLabel: '当前场景 · sc-123…',
        statusTone: 'warning',
        isDirty: true,
      },
    })

    render(<AssistantHost />)

    // 1. 验证上下文胶囊中存在黄色“存在未保存草稿”徽标
    const dirtyBadge = page.getByTestId('dirty-draft-badge')
    await expect.element(dirtyBadge).toBeVisible()
    await expect.element(dirtyBadge).toHaveTextContent('存在未保存草稿')

    // 2. 模拟用户输入问题并提交
    const textarea = page.getByRole('textbox', { name: '向助手提问' })
    await userEvent.fill(textarea, '解释第三步为什么校验失败')
    const submitBtn = page.getByRole('button', { name: '发送' })
    await userEvent.click(submitBtn)

    await expect.element(page.getByText(/助手会依据已保存版本回答/)).toBeVisible()

    // 3. 用户原话保持原样，草稿状态随 pageContext 独立传递
    expect(createAssistantTurn).toHaveBeenCalledWith(
      'conv-browser-sim-1',
      expect.objectContaining({
        question: '解释第三步为什么校验失败',
      }),
    )
  })

  it('停止请求失败时保留运行状态并提示重试', async () => {
    vi.mocked(cancelAssistantTurn).mockRejectedValueOnce(new Error('网络断开'))
    useAssistantStore.setState({
      conversationId: 'conv-browser-sim-1',
      activeTurnId: 'turn-running-1',
      busy: true,
      activeStage: 'generating',
    })

    render(<AssistantHost />)
    await userEvent.click(page.getByRole('button', { name: '停止' }))

    await expect.element(page.getByRole('alert')).toHaveTextContent('停止请求未成功')
    expect(useAssistantStore.getState().busy).toBe(true)
    expect(useAssistantStore.getState().activeTurnId).toBe('turn-running-1')
    useAssistantStore.setState({ activeTurnId: null, busy: false })
  })

  it('SSE 断线补读到运行中状态时保持任务，并退避重连', async () => {
    render(<AssistantHost />)
    useAssistantStore.setState({ question: '查询运行状态' })
    await useAssistantStore.getState().submit()
    const runningTurn = makeObservedTurn('RUNNING')
    vi.mocked(fetchAssistantTurn).mockResolvedValueOnce(runningTurn)

    latestObservationHandlers?.onError?.(new Error('connection lost'))
    await vi.waitFor(() => expect(fetchAssistantTurn).toHaveBeenCalledWith('conv-browser-sim-1', 'turn-sim-100'))
    await vi.waitFor(() => expect(useAssistantStore.getState().turns[0]?.status).toBe('RUNNING'))
    expect(useAssistantStore.getState()).toMatchObject({
      busy: true,
      activeTurnId: 'turn-sim-100',
    })
    expect(useAssistantStore.getState().error).toContain('连接中断')
    await expect.element(page.getByRole('alert')).toHaveTextContent('连接中断')
    await expect.element(page.getByText('答复已完成')).not.toBeInTheDocument()

    await vi.waitFor(() => expect(observeAssistantTurn).toHaveBeenCalledTimes(2), { timeout: 2_000 })
    latestObservationHandlers?.onReady?.({ realtime: true, thinkingStream: false })
    expect(useAssistantStore.getState().error).toBeNull()
    latestObservationHandlers?.onTurn?.(makeObservedTurn('COMPLETED'))
    expect(useAssistantStore.getState()).toMatchObject({ busy: false, activeTurnId: null })
  })

  it('SSE 断线补读到终态时完成任务，不再重连', async () => {
    useAssistantStore.setState({ question: '查询运行状态' })
    await useAssistantStore.getState().submit()
    vi.mocked(fetchAssistantTurn).mockResolvedValueOnce(makeObservedTurn('COMPLETED'))

    latestObservationHandlers?.onError?.(new Error('connection lost'))
    await vi.waitFor(() => expect(useAssistantStore.getState().busy).toBe(false))
    expect(useAssistantStore.getState().activeTurnId).toBeNull()
    expect(useAssistantStore.getState().turns[0]?.status).toBe('COMPLETED')
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(observeAssistantTurn).toHaveBeenCalledTimes(1)
  })

  it('观察流无终态就结束时报告断线，主动关闭不会误报', async () => {
    const actual = await vi.importActual<typeof import('@/lib/assistant-api')>('@/lib/assistant-api')
    const makeStream = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"realtime":true,"thinkingStream":false}\n\n'))
        controller.close()
      },
    })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      fetchSpy.mockResolvedValueOnce(new Response(makeStream(), { status: 200 }))
      const onDisconnected = vi.fn()
      actual.observeAssistantTurn('conv-1', 'turn-1', { onError: onDisconnected })
      await vi.waitFor(() => expect(onDisconnected).toHaveBeenCalledTimes(1))

      fetchSpy.mockResolvedValueOnce(new Response(makeStream(), { status: 200 }))
      const onAborted = vi.fn()
      const close = actual.observeAssistantTurn('conv-1', 'turn-2', { onError: onAborted })
      close()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(onAborted).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it.each(['cancel', 'switch'] as const)('%s 清理已排程的断线重连', async (action) => {
    useAssistantStore.setState({ question: '查询运行状态' })
    await useAssistantStore.getState().submit()
    vi.mocked(fetchAssistantTurn).mockResolvedValueOnce(makeObservedTurn('RUNNING'))

    latestObservationHandlers?.onError?.(new Error('connection lost'))
    await vi.waitFor(() => expect(useAssistantStore.getState().turns[0]?.status).toBe('RUNNING'))
    if (action === 'cancel') await useAssistantStore.getState().cancel()
    else await useAssistantStore.getState().switchConversation('conv-other')

    await new Promise((resolve) => setTimeout(resolve, 1_100))
    expect(observeAssistantTurn).toHaveBeenCalledTimes(1)
    expect(useAssistantStore.getState().activeTurnId).toBeNull()
    if (action === 'switch') {
      expect(useAssistantStore.getState().conversationId).toBe('conv-other')
      expect(useAssistantStore.getState().turns).toEqual([])
    }
  })

  it('切换会话后忽略迟到的断线补读', async () => {
    useAssistantStore.setState({ question: '查询运行状态' })
    await useAssistantStore.getState().submit()
    let resolveFetch: (turn: AssistantTurn) => void = () => undefined
    vi.mocked(fetchAssistantTurn).mockImplementationOnce(() => new Promise<AssistantTurn>((resolve) => {
      resolveFetch = resolve
    }))

    latestObservationHandlers?.onError?.(new Error('connection lost'))
    await vi.waitFor(() => expect(fetchAssistantTurn).toHaveBeenCalledTimes(1))
    await useAssistantStore.getState().switchConversation('conv-other')
    resolveFetch(makeObservedTurn('RUNNING'))
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(useAssistantStore.getState().conversationId).toBe('conv-other')
    expect(useAssistantStore.getState().turns).toEqual([])
    expect(observeAssistantTurn).toHaveBeenCalledTimes(1)
  })

  it('补读失败时仍保持运行中并继续尝试恢复观察流', async () => {
    useAssistantStore.setState({ question: '查询运行状态' })
    await useAssistantStore.getState().submit()
    vi.mocked(fetchAssistantTurn).mockRejectedValueOnce(new Error('network unavailable'))

    latestObservationHandlers?.onError?.(new Error('connection lost'))
    await vi.waitFor(() => expect(useAssistantStore.getState().error).toContain('暂时无法读取已保存进度'))
    expect(useAssistantStore.getState()).toMatchObject({ busy: true, activeTurnId: 'turn-sim-100' })
    await vi.waitFor(() => expect(observeAssistantTurn).toHaveBeenCalledTimes(2), { timeout: 2_000 })
  })

  it('后续提问带上最近一轮的 replyToTurnId', async () => {
    const previousId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    useAssistantStore.setState({
      conversationId: 'conv-browser-sim-1',
      turns: [
        {
          ...makeTurn(
            {
              kind: 'clarify',
              question: '请选择一项继续。',
              missingFields: ['capabilityId'],
              options: [{ id: 'run.diagnose', label: '运行诊断' }],
            },
            '上一问',
          ),
          id: previousId,
        },
      ],
      question: '',
    })

    render(<AssistantHost />)
    const textarea = page.getByRole('textbox', { name: '向助手提问' })
    await userEvent.fill(textarea, '第 2 个')
    await userEvent.click(page.getByRole('button', { name: '发送' }))

    expect(createAssistantTurn).toHaveBeenCalledWith(
      'conv-browser-sim-1',
      expect.objectContaining({ replyToTurnId: previousId }),
    )
  })

  it('页面绑定按字段更新，离开页面后清空 pageContext', async () => {
    const scenarioId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const stepId = '11111111-1111-4111-8111-111111111111'

    function BindingProbe() {
      const [tick, setTick] = useState(0)
      useAssistantContextBinding({
        page: 'studio',
        scenarioId,
        draftRevision: 2,
        statusSummary: '场景',
      })
      return (
        <button type='button' onClick={() => setTick((value) => value + 1)}>
          重渲染 {tick}
        </button>
      )
    }

    const screen = await render(<BindingProbe />)
    expect(useAssistantStore.getState().pageContext).toMatchObject({
      page: 'studio',
      scenarioId,
      draftRevision: 2,
    })

    useAssistantStore.getState().setPageContext({
      page: 'studio',
      scenarioId,
      draftRevision: 2,
      stepId,
    })
    await userEvent.click(screen.getByRole('button', { name: /重渲染/ }))
    expect(useAssistantStore.getState().pageContext).toMatchObject({
      draftRevision: 2,
      stepId,
    })

    screen.unmount()
    expect(useAssistantStore.getState().pageContext).toBeNull()
    expect(useAssistantStore.getState().boundContext).toBeNull()
  })

  // --------------------------------------------------------------------------
  // 正例 5: 跨页面步骤跳转（在 Run 页面点击定位步骤触发导航至 Studio）(PD-13)
  // --------------------------------------------------------------------------
  it('正例 5 (PD-13): 在非 Studio 页面（如 Run 页）点击“在 Studio 中定位”，受控路由跳转至 Studio 并携带 inspect-step 参数', async () => {
    const proposalTurn = makeTurn(
      {
        kind: 'proposal',
        stepId: 'step-target-99',
        reason: '修正表单输入定位器以适配新版 DOM 结构',
        executable: true,
        diffs: [
          {
            fieldPath: ['selector'],
            from: '#old-btn',
            to: '#new-submit-btn',
            changeType: 'modify',
          },
        ],
        draftRevision: 2,
        documentDigest: 'a'.repeat(64),
        document: {} as unknown as AssistantProposal['document'],
        diagnostics: [],
      },
      '修复表单输入步骤',
    )
    useAssistantStore.setState({
      turns: [proposalTurn],
      pageContext: { page: 'run', runId: 'run-999' },
      boundContext: { page: 'run', runId: 'run-999', scenarioId: 'scenario-erp-01' },
    })

    render(<AssistantHost />)

    // 点击在 Studio 中定位
    const locateBtn = page.getByRole('button', { name: '在 Studio 中定位' })
    await expect.element(locateBtn).toBeVisible()
    await userEvent.click(locateBtn)

    // 验证触发受控路由跳转回 Studio
    expect(navigate).toHaveBeenCalledWith({
      to: '/scenarios/$scenarioId',
      params: { scenarioId: 'scenario-erp-01' },
      search: { action: 'inspect-step', step_id: 'step-target-99' },
    })
  })

  // --------------------------------------------------------------------------
  // 正例 6: 步骤建议提案采纳后就地置灰与防重复点击 (PD-15)
  // --------------------------------------------------------------------------
  it('正例 6 (PD-15): 采纳步骤建议后卡片就地显示“已放入草稿”成功状态并禁用采纳按钮', async () => {
    const mockAdopt = vi.fn(async () => ({ ok: true as const, digest: 'b'.repeat(64) }))
    const proposalTurn = makeTurn(
      {
        kind: 'proposal',
        stepId: 'step-adopted-01',
        reason: '添加点击后的显式等待',
        executable: true,
        diffs: [
          {
            fieldPath: ['waitAfter'],
            from: 0,
            to: 1000,
            changeType: 'modify',
          },
        ],
        draftRevision: 1,
        documentDigest: 'c'.repeat(64),
        document: {} as unknown as AssistantProposal['document'],
        diagnostics: [],
      },
      '优化步骤等待',
    )

    useAssistantStore.setState({
      turns: [proposalTurn],
      pageContext: { page: 'studio', scenarioId: 'sc-1' },
      adoptHandler: mockAdopt,
    })

    render(<AssistantHost />)

    // 点击采纳到本地草稿
    const adoptBtn = page.getByRole('button', { name: '采纳到本地草稿' })
    await expect.element(adoptBtn).toBeVisible()
    await userEvent.click(adoptBtn)

    expect(mockAdopt).toHaveBeenCalled()

    // 验证卡片就地切换为已采纳状态，原采纳按钮消失
    const adoptedBadge = page.getByText('已放入草稿')
    await expect.element(adoptedBadge).toBeVisible()
    await expect.element(adoptBtn).not.toBeInTheDocument()
  })

  // --------------------------------------------------------------------------
  // 反例 1: 缺少业务数据源时友好指引，不造假数据，不出现未捕获异常 (PD-09)
  // --------------------------------------------------------------------------
  it('反例 1 (PD-09): 询问厂家但无数据源时，呈现建设性配置指引，不造名单也不生硬拒答', async () => {
    const turn = makeTurn(
      {
        kind: 'discovery',
        summary: '当前目标尚未配置或同步业务数据源。您可以在「目标配置 - 数据集」中录入或通过外部集成同步。',
        message: '当前目标尚未配置或同步业务数据源。您可以在「目标配置 - 数据集」中录入或通过外部集成同步，配置后即可在此直接查询。',
        candidates: [],
        scope: {
          entityType: 'business_records',
        },
        coverage: {
          totalVisible: 0,
          hasMore: false,
          observedAt: '2026-09-23T00:00:00.000Z',
        },
      },
      '现在都有哪些厂家？',
    )
    useAssistantStore.setState({ turns: [turn] })

    render(<AssistantHost />)

    // 验证渲染指引消息，不报内部错误，不造假数据
    const guideMsg = page.getByText('当前目标尚未配置或同步业务数据源。您可以在「目标配置 - 数据集」中录入或通过外部集成同步')
    await expect.element(guideMsg).toBeVisible()
  })

  // --------------------------------------------------------------------------
  // 反例 2: 7 天无失败运行的空诊断状态 (PD-07)
  // --------------------------------------------------------------------------
  it('反例 2 (PD-07): 7 天窗口内无失败运行返回明确空态事实，并附带前往全量运行列表的操作入口', async () => {
    const turn = makeTurn(
      {
        kind: 'diagnosis',
        observedAt: '2026-09-23T00:00:00.000Z',
        eventSeq: 1,
        focus: 'failure',
        facts: [
          {
            id: 'fact-recent-failed',
            text: '近 7 天内当前可见范围内未发现处于 FAILED、TIMED_OUT 或 ERROR 的失败运行（已排除用户主动取消的运行）',
            citations: [],
          },
        ],
        hypotheses: [],
        missingInformation: ['近 7 天内无异常运行记录'],
        nextActions: [
          {
            kind: 'run.detail',
            label: '前往运行列表查看全部历史',
            href: '/runs',
            citations: [],
          },
        ],
      },
      '分析最近失败运行',
    )
    useAssistantStore.setState({ turns: [turn] })

    render(<AssistantHost />)

    // 验证排障事实文本清晰说明近 7 天无异常
    const factElem = page.getByText('近 7 天内当前可见范围内未发现处于 FAILED、TIMED_OUT 或 ERROR 的失败运行')
    await expect.element(factElem).toBeVisible()

    // 验证具备前往运行列表的操作按钮
    const goRunsBtn = page.getByRole('button', { name: '前往运行列表查看全部历史' })
    await expect.element(goRunsBtn).toBeVisible()
  })

  // --------------------------------------------------------------------------
  // 反例 3: 目标撤权或跨目标不可见时，统一降级为 inaccessible 卡片 (PD-04)
  // --------------------------------------------------------------------------
  it('反例 3 (PD-04): 目标撤权或跨租户访问被拦截时，统一降级为安全提示，不泄露私有目标或场景名称', async () => {
    const turn = makeTurn(
      {
        kind: 'inaccessible',
        message: '相关运行或目标已不可访问',
      },
      '解释场景细节',
    )
    useAssistantStore.setState({ turns: [turn] })

    render(<AssistantHost />)

    const inaccessibleMsg = page.getByText('相关运行或目标已不可访问')
    await expect.element(inaccessibleMsg).toBeVisible()
  })

  // --------------------------------------------------------------------------
  // 反例 4: OCC 任务版本冲突并发防御 (PD-14)
  // --------------------------------------------------------------------------
  it('反例 4 (PD-14): 发生乐观并发冲突 (409) 时友好展示错误提示，不崩溃并保留输入内容', async () => {
    useAssistantStore.setState({
      turns: [],
      question: '__TRIGGER_CONFLICT__',
    })

    render(<AssistantHost />)

    const submitBtn = page.getByRole('button', { name: '发送' })
    await userEvent.click(submitBtn)

    // 验证错误提示浮现
    const errorAlert = page.getByText('任务版本已更新，请重新加载后再试')
    await expect.element(errorAlert).toBeVisible()
  })

  // --------------------------------------------------------------------------
  // 正例 7: 思考中展开展示流式思考过程，且绝不出现两个挨在一起的“识途助手”标题；完成后自动折叠
  // --------------------------------------------------------------------------
  it('正例 7: 运行中单回合绝不出现重复助手标题，思考中展开思考文本，完成后自动折叠', async () => {
    useAssistantStore.setState({
      turns: [
        {
          id: 'turn-running-1',
          conversationId: 'conv-browser-sim-1',
          clientTurnId: 'ct-12345678',
          parentTurnId: null,
          question: '请分析当前步骤选择器的健壮性并提供加固候选。',
          capabilityId: 'scenario.explain',
          status: 'RUNNING',
          stage: 'generating',
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          result: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      activeTurnId: 'turn-running-1',
      busy: true,
      activeStage: 'generating',
      thinkingText: '正在分析 XPath 与 CSS 选择器的特征...',
    })

    render(<AssistantHost />)

    // 1. 验证对话流中只有一个“识途助手”标签，绝不出现两个重复挨着
    const authorLabel = page.getByTestId('turn-assistant-author')
    await expect.element(authorLabel).toBeVisible()
    expect(authorLabel.elements()).toHaveLength(1)

    // 2. 验证思考中默认展开并展示思考分析内容
    await expect.element(page.getByText('大模型正在思考分析…')).toBeVisible()
    await expect.element(page.getByText('正在分析 XPath 与 CSS 选择器的特征...')).toBeVisible()

    // 3. 模拟任务完成：切换为 COMPLETED 终态，耗时 3200ms
    useAssistantStore.setState({
      turns: [
        {
          id: 'turn-running-1',
          conversationId: 'conv-browser-sim-1',
          clientTurnId: 'ct-12345678',
          parentTurnId: null,
          question: '请分析当前步骤选择器的健壮性并提供加固候选。',
          capabilityId: 'scenario.explain',
          status: 'COMPLETED',
          stage: 'persisting',
          thinkingText: '正在分析 XPath 与 CSS 选择器的特征...',
          thinkingDurationMs: 3200,
          deadlineAt: new Date(Date.now() + 60000).toISOString(),
          result: {
            kind: 'explanation',
            summary: '选择器加固候选已生成',
            references: [],
            diagnostics: [],
            executable: false,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      activeTurnId: null,
      busy: false,
      thinkingText: '',
    })

    // 4. 验证思考完成后自动折叠（显示“已深度思考 (用时 3 秒)”与“点击展开”）
    await expect.element(page.getByText('已深度思考 (用时 3 秒)')).toBeVisible()
    await expect.element(page.getByText('点击展开')).toBeVisible()

    // 5. 点击展开，验证完整思考内容与复制按钮
    await page.getByRole('button', { name: '展开思考过程' }).click()
    await expect.element(page.getByText('点击折叠')).toBeVisible()
    await expect.element(page.getByText('正在分析 XPath 与 CSS 选择器的特征...')).toBeVisible()
    await expect.element(page.getByRole('button', { name: '复制思考过程' })).toBeVisible()
  })
})
