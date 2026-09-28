import '@/styles/index.css'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import type { AssistantConversation, AssistantTurn } from '@cairn/shared'
import {
  useAssistantStore,
  summarizeConversationTitle,
} from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { deleteAssistantConversation, fetchAssistantConversations } from '@/lib/assistant-api'
import { AssistantHost } from './host'

vi.mock('@/features/runs/use-run-observation', () => ({
  useRunObservation: () => ({
    run: null,
    timeline: { stages: [] },
    view: null,
    isStreaming: false,
    error: null,
  }),
}))

const mockConversations: AssistantConversation[] = [
  {
    id: 'conv-today',
    title: '今天调试的步骤超时问题',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'conv-yesterday',
    title: '昨天排查的免登凭据过期',
    createdAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
  },
  {
    id: 'conv-3days',
    title: '三天前的场景编排入门',
    createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
  },
  {
    id: 'conv-6days',
    title: '六天前的超限历史记录',
    createdAt: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString(),
  },
]

let serverConversations: AssistantConversation[] = [...mockConversations]

const mockHistoryTurns: AssistantTurn[] = [
  {
    id: 'turn-old-1',
    conversationId: 'conv-today',
    clientTurnId: 'client-1',
    parentTurnId: null,
    question: '今天调试的步骤超时问题',
    capabilityId: 'run.diagnose',
    status: 'COMPLETED',
    stage: 'persisting',
    deadlineAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    result: {
      kind: 'unsupported',
      reasonCode: 'TASK_UNSUPPORTED',
      message: '历史诊断记录：超时已恢复',
    },
  },
]

vi.mock('@/lib/assistant-api', () => ({
  fetchAssistantCapabilities: vi.fn(async () => ({
    items: [
      { id: 'scenario.explain', label: '场景解释', available: true, missingPermissions: [], requiredContext: [] },
      { id: 'run.diagnose', label: '运行诊断', available: true, missingPermissions: [], requiredContext: [] },
      { id: 'platform.guide', label: '功能导览', available: true, missingPermissions: [], requiredContext: [] },
    ],
    modelEnabled: true,
  })),
  fetchAssistantConversations: vi.fn(async () => ({
    items: serverConversations,
    nextCursor: null,
  })),
  deleteAssistantConversation: vi.fn(async (id: string) => {
    serverConversations = serverConversations.filter((c) => c.id !== id)
    return { id, deleted: true }
  }),
  fetchAssistantTurns: vi.fn(async (convId: string) => ({
    items: convId === 'conv-today' ? mockHistoryTurns : [],
    nextCursor: null,
  })),
  fetchAssistantTurn: vi.fn(),
  createAssistantConversation: vi.fn(async (body?: { title?: string; question?: string }) => ({
    id: 'conv-brand-new',
    title: body?.title || (body?.question ? summarizeConversationTitle(body.question) : '新对话'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })),
  createAssistantTurn: vi.fn(async () => ({
    turnId: 'turn-new-1',
    stage: 'loading_facts' as const,
    queuePosition: null,
  })),
  cancelAssistantTurn: vi.fn(async () => ({ canceled: true })),
  observeAssistantTurn: vi.fn(() => () => {}),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useRouterState: () => ({ location: { pathname: '/scenarios/sc-1' } }),
  }
})

describe('识途助手：新建会话、可继续加载的历史与分类引导卡片', () => {
  beforeEach(() => {
    localStorage.clear()
    serverConversations = [...mockConversations]
    vi.clearAllMocks()
    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({
      id: 'usr-tester',
      displayName: 'Tester',
      email: 'tester@example.com',
      roles: ['admin'],
      permissions: ['ai:assist'],
    })
    useAssistantStore.setState({
      open: false,
      conversationId: null,
      turns: [],
      question: '',
      busy: false,
      cancelling: false,
      error: null,
      activeTurnId: null,
      activeStage: null,
      activeQueuePosition: null,
      thinkingText: '',
      thinkingStream: false,
      mode: 'floating',
      dockWidth: 400,
      activeQuote: null,
      boundContext: null,
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

  describe('1. 服务端历史分页', () => {
    it('展示服务端返回的更早会话，不把五天前的记录当成已归档', async () => {
      await useAssistantStore.getState().fetchRecentConversations()
      const convs = useAssistantStore.getState().conversations
      expect(convs.some((c) => c.id === 'conv-today')).toBe(true)
      expect(convs.some((c) => c.id === 'conv-yesterday')).toBe(true)
      expect(convs.some((c) => c.id === 'conv-3days')).toBe(true)
      expect(convs.some((c) => c.id === 'conv-6days')).toBe(true)
    })

    it('用服务端游标加载下一页会话', async () => {
      vi.mocked(fetchAssistantConversations)
        .mockResolvedValueOnce({ items: [mockConversations[0]!], nextCursor: 'older-page' })
        .mockResolvedValueOnce({ items: [mockConversations[3]!], nextCursor: undefined })

      await useAssistantStore.getState().fetchRecentConversations()
      expect(useAssistantStore.getState().historyNextCursor).toBe('older-page')
      await useAssistantStore.getState().fetchMoreConversations()
      expect(fetchAssistantConversations).toHaveBeenCalledWith({ cursor: 'older-page', limit: 50 })
      expect(useAssistantStore.getState().conversations.map((item) => item.id)).toEqual(['conv-today', 'conv-6days'])
      expect(useAssistantStore.getState().historyNextCursor).toBeNull()
    })
  })

  describe('2. 新建会话（New Chat）全链路', () => {
    it('正例：对话进行中点击新建会话，清空 turns 与输入，重回分类引导卡片态', async () => {
      useAssistantStore.setState({
        open: true,
        conversationId: 'conv-active-1',
        turns: [mockHistoryTurns[0]!],
        question: '输入到一半的内容',
        activeQuote: {
          type: 'scenario_step',
          title: '步骤 3',
          summary: '点击提交订单',
          objectRef: { kind: 'step', id: 'step-99' },
        },
      })

      render(<AssistantHost />)
      await expect.element(page.getByText('历史诊断记录：超时已恢复')).toBeVisible()

      // 点击顶栏新建会话按钮
      const newChatBtn = page.getByTestId('assistant-new-chat-btn')
      await expect.element(newChatBtn).toBeVisible()
      await newChatBtn.click()

      // 验证状态彻底重置
      const state = useAssistantStore.getState()
      expect(state.conversationId).toBeNull()
      expect(state.turns).toEqual([])
      expect(state.question).toBe('')
      expect(state.activeQuote).toBeNull()

      // 验证页面展示 PromptCards 推荐矩阵
      await expect.element(page.getByTestId('assistant-prompt-cards')).toBeVisible()
      await expect.element(page.getByText('有什么可以帮你？')).toBeVisible()
    })
  })

  describe('3. 会话历史抽屉（HistoryDrawer）展开与切换', () => {
    it('展开历史抽屉，呈现时间分组（今天、昨天、更早），点击项目切换会话并加载轮次', async () => {
      useAssistantStore.setState({
        open: true,
        conversations: mockConversations,
      })

      render(<AssistantHost />)

      // 点击顶栏“会话历史”按钮
      const historyBtn = page.getByTestId('assistant-history-btn')
      await historyBtn.click()

      // 抽屉展示实际可读取的历史，不承诺前端没有实施的归档行为
      await expect.element(page.getByTestId('assistant-history-drawer')).toBeVisible()
      await expect.element(page.getByText('按最近活动排序', { exact: true })).toBeVisible()
      await expect.element(page.getByText('今天调试的步骤超时问题')).toBeVisible()
      await expect.element(page.getByText('昨天排查的免登凭据过期')).toBeVisible()
      await expect.element(page.getByText('三天前的场景编排入门')).toBeVisible()
      await expect.element(page.getByText('六天前的超限历史记录')).toBeVisible()

      // 点击“今天调试的步骤超时问题”项
      const todayItem = page.getByTestId('history-item-conv-today')
      await todayItem.click()

      // 验证抽屉自动关闭，且加载了该会话的 turns
      await expect.element(page.getByTestId('assistant-history-drawer')).not.toBeInTheDocument()
      expect(useAssistantStore.getState().conversationId).toBe('conv-today')
      await expect.element(page.getByText('历史诊断记录：超时已恢复')).toBeVisible()
    })

    it('正例：支持在历史列表中点击垃圾桶真删除单项会话，调用 API 并在重新拉取历史后不再出现', async () => {
      serverConversations = [
        {
          id: 'conv-today',
          title: '需要被删除的会话',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]
      useAssistantStore.setState({
        open: true,
        conversationId: 'conv-today',
        historyOpen: true,
        conversations: [...serverConversations],
      })

      render(<AssistantHost />)
      await expect.element(page.getByTestId('assistant-history-drawer')).toBeVisible()

      // 点击删除按钮
      const deleteBtn = page.getByTestId('delete-conv-conv-today')
      await deleteBtn.click()

      // 验证会话被移除，API 被调用，且由于被删的是当前激活项，自动重置为新会话
      expect(useAssistantStore.getState().conversations).toHaveLength(0)
      expect(useAssistantStore.getState().conversationId).toBeNull()
      expect(deleteAssistantConversation).toHaveBeenCalledWith('conv-today')

      // 模拟重新打开历史抽屉时触发 fetchRecentConversations 从服务端重新拉取
      await useAssistantStore.getState().fetchRecentConversations()

      // 验证被删除的会话不会死灰复燃
      expect(useAssistantStore.getState().conversations).toHaveLength(0)
      await expect.element(page.getByText('暂无会话记录')).toBeVisible()
    })
  })

  describe('4. 前沿 AI 分类小卡片推荐矩阵（PromptCards）', () => {
    it('正例：支持点击不同场景分类 Tab，卡片内容平滑切换，点击卡片一键提问', async () => {
      useAssistantStore.setState({
        open: true,
        turns: [],
        busy: false,
      })

      render(<AssistantHost />)
      const promptCards = page.getByTestId('assistant-prompt-cards')
      await expect.element(promptCards).toBeVisible()

      // 默认在“场景编排”分类
      await expect.element(page.getByRole('tab', { name: '场景编排' })).toHaveAttribute('aria-selected', 'true')
      await expect.element(page.getByTestId('prompt-card-auth-create')).toBeVisible()
      await expect.element(page.getByText('找到场景编排入口')).toBeVisible()

      // 切换到“会话与凭据”分类
      const sessionTab = page.getByRole('tab', { name: '会话与凭据' })
      await sessionTab.click()
      await expect.element(sessionTab).toHaveAttribute('aria-selected', 'true')
      await expect.element(page.getByTestId('prompt-card-sess-totp')).toBeVisible()
      await expect.element(page.getByText('找到目标账号入口')).toBeVisible()

      // 点击卡片，自动派发提问
      const totpCard = page.getByTestId('prompt-card-sess-totp')
      await totpCard.click()

      // 验证助手状态进入 busy，且发出了对应问题
      expect(useAssistantStore.getState().busy).toBe(true)
      expect(useAssistantStore.getState().question).toBe('')
    })
  })

  describe('5. 首问描述提炼会话标题与受控截断', () => {
    it('纯函数：短文本完整保留、超长受控截断并补省略号、多余空白归一化', () => {
      // 空白情况
      expect(summarizeConversationTitle('')).toBe('新对话')
      expect(summarizeConversationTitle('   \n  \t ')).toBe('新对话')

      // 短文本直接作为完整标题
      const shortQ = '排查任务运行失败原因'
      expect(summarizeConversationTitle(shortQ)).toBe(shortQ)
      expect(summarizeConversationTitle(shortQ).length).toBeLessThanOrEqual(30)

      // 超长文本截断至 30 字，第 30 字为 …
      const longQ = '这是一个超过三十个字符的非常非常长的用户提问描述，用于测试截断逻辑是否正确生效'
      const summarized = summarizeConversationTitle(longQ)
      expect(summarized).toHaveLength(30)
      expect(summarized.endsWith('…')).toBe(true)
      expect(summarized.slice(0, 29)).toBe(longQ.slice(0, 29))

      // 换行与多空格折叠
      const multiline = '请帮我排查下   这个运行\n为什么一直报错'
      expect(summarizeConversationTitle(multiline)).toBe('请帮我排查下 这个运行 为什么一直报错')
    })

    it('正例：新建会话并发出首问后，会话标题自动更新为首问截断摘要而非“新对话”', async () => {
      useAssistantStore.setState({
        open: true,
        conversationId: null,
        conversations: [],
        turns: [],
        question: '请帮我编写一个淘宝自动搜索并加购商品的脚本，并且需要检查登录态是否有效',
        busy: false,
      })

      render(<AssistantHost />)

      // 点击发送按钮提交首问
      const sendBtn = page.getByRole('button', { name: '发送' })
      await sendBtn.click()

      // 验证 conversation 已经被创建且标题为首问摘要，而非默认的“新对话”
      const currentConversations = useAssistantStore.getState().conversations
      expect(currentConversations.length).toBeGreaterThanOrEqual(1)
      const conv = currentConversations[0]
      expect(conv.title).not.toBe('新对话')
      expect(conv.title).not.toBe('新会话')
      expect(conv.title).toBe('请帮我编写一个淘宝自动搜索并加购商品的脚本，并且需要检查登…')
      expect(conv.title).toHaveLength(30)

      // 打开会话历史抽屉，确认列表中显示的标题就是首问摘要
      const historyBtn = page.getByTitle('会话历史')
      await historyBtn.click()

      await expect.element(page.getByTestId('assistant-history-drawer')).toBeVisible()
      await expect.element(page.getByText('请帮我编写一个淘宝自动搜索并加购商品的脚本，并且需要检查登…')).toBeVisible()
    })
  })
})
