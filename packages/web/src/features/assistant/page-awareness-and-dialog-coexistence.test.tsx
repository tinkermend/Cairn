import '@/styles/index.css'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { scheduleDefinitionSchema, type ScheduleDto } from '@cairn/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { resolveRouteContext } from './route-context'
import { useAssistantContextBinding } from './use-assistant-context-binding'
import { AssistantHost } from './host'
import { HeaderAssistantTrigger } from './header-assistant-trigger'
import { ScheduleDetailDialog } from '@/features/schedules/detail'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

vi.mock('@/lib/assistant-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assistant-api')>()
  return {
    ...actual,
    fetchAssistantCapabilities: vi.fn(async () => ({
      modelEnabled: true,
      items: [
        { id: 'platform.guide', label: '功能导览', available: true, missingPermissions: [], requiredContext: [] },
        { id: 'scenario.explain', label: '场景解释', available: true, missingPermissions: [], requiredContext: [] },
      ],
    })),
    fetchAssistantConversations: vi.fn(async () => ({ items: [] })),
    createAssistantConversation: vi.fn(async () => ({
      id: 'conv-1',
      title: '新对话',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    createAssistantTurn: vi.fn(async () => ({
      turnId: 'turn-test-1',
      stage: 'accepted',
      queuePosition: null,
    })),
    observeAssistantTurn: vi.fn(() => () => {}),
    cancelAssistantTurn: vi.fn(),
    fetchAssistantTurn: vi.fn(),
    fetchAssistantTurns: vi.fn(async () => ({ items: [] })),
  }
})

vi.mock('@/lib/schedules-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/schedules-api')>()
  return {
    ...actual,
    fetchScheduleOccurrences: vi.fn(async () => ({ items: [] })),
    fetchScheduleEvents: vi.fn(async () => ({ items: [] })),
  }
})

vi.mock('@/lib/observation-stream', () => ({
  subscribeObservation: vi.fn(async () => {}),
}))

let currentMockPath = '/scenarios'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useRouterState: (opts?: { select?: (state: any) => any }) => {
      const state = { location: { pathname: currentMockPath } }
      return opts?.select ? opts.select(state) : state
    },
  }
})

const mockSchedule: ScheduleDto = {
  scheduleId: '11111111-1111-4111-8111-111111111111',
  name: '每日核心场景回归',
  consumerKey: 'scenario_run',
  revision: 1,
  enabled: true,
  objectLabel: '用户主流程场景',
  targetId: '22222222-2222-4222-8222-222222222222',
  targetAccountId: null,
  currentVersionId: '33333333-3333-4333-8333-333333333333',
  definition: scheduleDefinitionSchema.parse({
    consumer: {
      type: 'scenario_run',
      targetId: '22222222-2222-4222-8222-222222222222',
      scenarioId: '44444444-4444-4444-8444-444444444444',
      scenarioVersionId: '55555555-5555-4555-8555-555555555555',
      accountBinding: { resolved: false },
      input: {},
    },
    timeRule: {
      kind: 'interval',
      intervalMs: 3600000,
      anchorUtc: '2026-09-27T00:00:00.000Z',
      misfire: 'skip',
    },
  }),
  nextDueAt: null,
  lastOccurrence: null,
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
}

describe('识途助手排查 01 验收：页面感知底座与弹窗共存 (Criterion 2 & 4)', () => {
  beforeEach(async () => {
    await page.viewport(1440, 900)
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试工程师',
      email: null,
      roles: [],
      permissions: ['ai:assist', 'schedule:read', 'workflow:read', 'workflow:write', 'run:read', 'target:read'],
    })
    useAssistantStore.setState({
      open: false,
      boundContext: null,
      routeContext: null,
      pageContext: null,
      question: '',
      busy: false,
    })
  })

  it('随页切换：场景详情 → 返回场景编排列表 → 定时任务 → 运行记录 (Acceptance Criterion 2)', async () => {
    function StudioDetailPage() {
      useAssistantContextBinding({
        page: 'studio',
        scenarioId: 'sc-123',
        statusLabel: '当前场景 · 登录对账',
        summaryText: '正在编辑核心业务对账场景流程。',
        statusTone: 'info',
      })
      return <div>场景详情页</div>
    }

    currentMockPath = '/scenarios/sc-123'
    useAssistantStore.getState().setRouteContext(resolveRouteContext('/scenarios/sc-123'))

    const screen = await render(
      <div>
        <StudioDetailPage />
        <AssistantHost showFloatingLauncher={false} />
      </div>,
    )

    // 打开助手浮窗
    useAssistantStore.getState().openPanel({ mode: 'floating' })

    // 1. 处于场景详情时：优先展示页面级 boundContext
    await expect.element(page.getByText('当前场景 · 登录对账')).toBeVisible()
    expect(useAssistantStore.getState().boundContext?.page).toBe('studio')
    expect(useAssistantStore.getState().pageContext?.page).toBe('studio')

    // 2. 返回场景编排列表页：卸载 StudioDetailPage，回退至 routeContext（场景编排），绝不回落为全局！
    currentMockPath = '/scenarios'
    useAssistantStore.getState().setRouteContext(resolveRouteContext('/scenarios'))
    await screen.rerender(
      <div>
        <div data-testid='current-page'>scenario_list</div>
        <AssistantHost showFloatingLauncher={false} />
      </div>,
    )

    await expect.element(page.getByTestId('context-capsule')).toHaveTextContent('场景编排')
    expect(useAssistantStore.getState().boundContext).toBeNull()
    expect(useAssistantStore.getState().routeContext?.page).toBe('scenario')
    expect(useAssistantStore.getState().pageContext?.page).toBe('scenario')
    expect(useAssistantStore.getState().routeContext?.title).toBe('场景编排')

    // 3. 切换到定时任务列表页
    currentMockPath = '/schedules'
    useAssistantStore.getState().setRouteContext(resolveRouteContext('/schedules'))
    await screen.rerender(
      <div>
        <div data-testid='current-page'>schedule_list</div>
        <AssistantHost showFloatingLauncher={false} />
      </div>,
    )

    await expect.element(page.getByTestId('context-capsule')).toHaveTextContent('定时任务')
    expect(useAssistantStore.getState().routeContext?.page).toBe('schedule')
    expect(useAssistantStore.getState().pageContext?.page).toBe('schedule')

    // 4. 切换到运行记录列表页
    currentMockPath = '/runs'
    useAssistantStore.getState().setRouteContext(resolveRouteContext('/runs'))
    await screen.rerender(
      <div>
        <div data-testid='current-page'>run_list</div>
        <AssistantHost showFloatingLauncher={false} />
      </div>,
    )

    await expect.element(page.getByTestId('context-capsule')).toHaveTextContent('运行记录')
    expect(useAssistantStore.getState().routeContext?.page).toBe('run')
    expect(useAssistantStore.getState().pageContext?.page).toBe('run')
  })

  it('弹窗共存：打开调度详情查看弹窗时，助手浮窗层级更高且交互不关闭弹窗 (Acceptance Criterion 4)', async () => {
    const onOpenChange = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    // 处于定时任务列表路由
    currentMockPath = '/schedules'
    useAssistantStore.getState().setRouteContext(resolveRouteContext('/schedules'))
    // 打开助手浮窗
    useAssistantStore.getState().openPanel({ mode: 'floating' })

    await render(
      <QueryClientProvider client={client}>
        <ScheduleDetailDialog schedule={mockSchedule} onOpenChange={onOpenChange} />
        <AssistantHost showFloatingLauncher={true} />
      </QueryClientProvider>,
    )

    // 验证调度详情弹窗可见，且标题正确
    await expect.element(page.getByRole('heading', { name: '每日核心场景回归' })).toBeVisible()

    // 验证层级：非模态查看弹窗为 z-[35]，助手浮窗为 z-40
    const dialogContent = document.querySelector('[data-slot="dialog-content"]')
    const assistantWindow = document.querySelector('[data-assistant-window="true"]')

    expect(dialogContent?.className).toContain('z-[35]')
    expect(assistantWindow?.className).toContain('z-40')

    // 在助手输入框中输入问题
    const assistantInput = page.getByRole('textbox', { name: '向助手提问' })
    await expect.element(assistantInput).toBeVisible()
    await assistantInput.click()
    await userEvent.fill(assistantInput, '为什么这个定时任务没有被调度？')

    // 验证与助手交互过程中，调度详情弹窗始终保持打开，onOpenChange(false) 未被触发！
    expect(onOpenChange).not.toHaveBeenCalled()
    await expect.element(page.getByRole('heading', { name: '每日核心场景回归' })).toBeVisible()

    // 点击助手发送按钮
    const submitBtn = page.getByRole('button', { name: '发送' })
    await submitBtn.click()

    // 验证提交后弹窗依然保持打开
    expect(onOpenChange).not.toHaveBeenCalled()
    await expect.element(page.getByRole('heading', { name: '每日核心场景回归' })).toBeVisible()
  })

  it('弹窗共存：调度详情打开时点击顶栏「识途助手」入口，弹窗与调度上下文都保留', async () => {
    const onOpenChange = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    currentMockPath = '/schedules'
    useAssistantStore.getState().setRouteContext(resolveRouteContext('/schedules'))

    await render(
      <QueryClientProvider client={client}>
        <HeaderAssistantTrigger />
        <ScheduleDetailDialog schedule={mockSchedule} onOpenChange={onOpenChange} />
        <AssistantHost showFloatingLauncher={false} />
      </QueryClientProvider>,
    )
    await expect.element(page.getByRole('heading', { name: '每日核心场景回归' })).toBeVisible()

    await page.getByRole('button', { name: '打开识途助手' }).click()

    expect(useAssistantStore.getState().open).toBe(true)
    expect(onOpenChange).not.toHaveBeenCalled()
    await expect.element(page.getByRole('heading', { name: '每日核心场景回归' })).toBeVisible()
    expect(useAssistantStore.getState().boundContext?.page).toBe('schedule')
  })

  it('弹窗共存：窄屏停靠侧栏（挂到 body）中输入问题时不关闭调度详情', async () => {
    await page.viewport(1100, 800)
    const onOpenChange = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    currentMockPath = '/schedules'
    useAssistantStore.getState().setRouteContext(resolveRouteContext('/schedules'))
    useAssistantStore.getState().openPanel({ mode: 'docked' })

    await render(
      <QueryClientProvider client={client}>
        <ScheduleDetailDialog schedule={mockSchedule} onOpenChange={onOpenChange} />
        <AssistantHost showFloatingLauncher={false} />
      </QueryClientProvider>,
    )
    const input = page.getByRole('textbox', { name: '向助手提问' })
    await expect.element(input).toBeVisible()
    await input.click()
    await userEvent.fill(input, '为什么没按时运行？')

    expect(onOpenChange).not.toHaveBeenCalled()
    await expect.element(page.getByRole('heading', { name: '每日核心场景回归' })).toBeVisible()
  })

  it('编辑与确认类模态弹窗保持默认 z-50 模态，高于助手层级 (Acceptance Criterion 4 防误触)', async () => {
    render(
      <div>
        <Dialog open variant='default'>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>删除确认</DialogTitle>
            </DialogHeader>
            <p>确定要删除此项吗？</p>
          </DialogContent>
        </Dialog>
      </div>,
    )

    await expect.element(page.getByRole('heading', { name: '删除确认' })).toBeVisible()

    const modalContent = document.querySelector('[data-slot="dialog-content"]')
    const modalOverlay = document.querySelector('[data-slot="dialog-overlay"]')

    expect(modalContent?.className).toContain('z-50')
    expect(modalOverlay?.className).toContain('z-50')
  })
})
