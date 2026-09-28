import '@/styles/index.css'
import type { AssistantTurn } from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { createAssistantConversation, fetchAssistantCapabilities } from '@/lib/assistant-api'
import { AssistantHost } from './host'
import { HeaderAssistantTrigger } from './header-assistant-trigger'

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
}))

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
        id: 'run.diagnose',
        label: '运行诊断',
        available: true,
        missingPermissions: [],
        requiredContext: ['runId'],
      },
    ],
    modelEnabled: true,
  })),
  createAssistantConversation: vi.fn(),
  createAssistantTurn: vi.fn(),
  fetchAssistantConversations: vi.fn(async () => ({
    items: [],
    nextCursor: null,
  })),
  deleteAssistantConversation: vi.fn(async () => ({ id: 'mock', deleted: true })),
  fetchAssistantTurns: vi.fn(async () => ({ items: useAssistantStore.getState().turns, nextCursor: undefined })),
  fetchAssistantTurn: vi.fn(),
  cancelAssistantTurn: vi.fn(async () => ({ canceled: true })),
  observeAssistantTurn: vi.fn(() => () => {}),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    useRouterState: () => ({ location: { pathname: '/runs/r-1' } }),
  }
})

function turn(
  result: AssistantTurn['result'],
  question = '目标账号在哪里配置？'
): AssistantTurn {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    conversationId: '11111111-1111-4111-8111-111111111111',
    clientTurnId: 'client-turn-1',
    parentTurnId: null,
    question,
    capabilityId: 'platform.guide',
    status: 'COMPLETED',
    deadlineAt: '2026-09-14T00:01:00.000Z',
    result,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  }
}

async function openAssistant() {
  const screen = await render(<AssistantHost />)
  await screen.getByRole('button', { name: '打开识途助手' }).click()
  await expect
    .element(page.getByRole('dialog', { name: '识途助手' }))
    .toBeVisible()
  await expect
    .element(page.getByRole('textbox', { name: '向助手提问' }))
    .toHaveFocus()
  return screen
}

describe('AssistantHost', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await page.viewport(1440, 900)
    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '只读',
      email: null,
      roles: ['viewer'],
      permissions: ['ai:assist', 'run:read', 'target:read'],
    })
    useAssistantStore.setState({
      open: false,
      conversationId: null,
      turns: [],
      question: '',
      busy: false,
      error: null,
      pageContext: null,
      capabilityHint: undefined,
      capabilities: null,
      adoptHandler: null,
    })
  })

  afterEach(() => {
    useAuthStore.getState().auth.setUser(null)
    useAssistantStore.getState().cancel()
    useAssistantStore.getState().closePanel()
  })

  it('没有 ai:assist 时不出现助手入口', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '自定义',
      email: null,
      roles: [],
      permissions: ['run:read'],
    })
    const screen = await render(<AssistantHost />)
    expect(
      screen.getByRole('button', { name: '打开识途助手' }).elements()
    ).toHaveLength(0)
  })

  it('默认右下角长方形浮窗，Escape 关闭后保留输入并返回入口焦点', async () => {
    const screen = await openAssistant()
    await expect.element(page.getByText('仅使用你已有的访问权限')).toBeVisible()
    const dialog = page.getByRole('dialog', { name: '识途助手' }).element()
    await expect
      .poll(() => Math.round(dialog.getBoundingClientRect().width))
      .toBe(400)
    const bounds = dialog.getBoundingClientRect()
    expect(bounds.right).toBe(1416)
    expect(bounds.bottom).toBe(876)
    expect(bounds.height).toBe(600)
    expect(dialog.getAttribute('aria-modal')).toBe('false')
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
    await page
      .getByRole('textbox', { name: '向助手提问' })
      .fill('保留这条尚未发送的问题')
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await expect
      .element(screen.getByRole('button', { name: '打开识途助手' }))
      .toHaveFocus()
    await screen.getByRole('button', { name: '打开识途助手' }).click()
    await expect
      .element(page.getByRole('textbox', { name: '向助手提问' }))
      .toHaveValue('保留这条尚未发送的问题')
  })

  it('窄屏和矮屏仍为有四周留白的弹窗，输入与关闭始终可达', async () => {
    await page.viewport(390, 844)
    await openAssistant()
    const dialog = page.getByRole('dialog', { name: '识途助手' }).element()
    await expect
      .poll(() => Math.round(dialog.getBoundingClientRect().width))
      .toBe(366)
    let bounds = dialog.getBoundingClientRect()
    expect(bounds.x).toBeGreaterThanOrEqual(12)
    expect(bounds.y).toBeGreaterThan(12)
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth)
    await page.viewport(390, 480)
    await expect
      .poll(() => Math.round(dialog.getBoundingClientRect().height))
      .toBeLessThanOrEqual(456)
    bounds = dialog.getBoundingClientRect()
    const send = page
      .getByRole('button', { name: '发送', exact: true })
      .element()
      .getBoundingClientRect()
    const close = page
      .getByRole('button', { name: '关闭识途助手' })
      .element()
      .getBoundingClientRect()
    expect(send.bottom).toBeLessThanOrEqual(bounds.bottom)
    expect(close.top).toBeGreaterThanOrEqual(bounds.top)
    await page.getByRole('button', { name: '关闭识途助手' }).click()
    await expect
      .element(page.getByRole('button', { name: '打开识途助手' }))
      .toHaveFocus()
  })

  it('主页面可以点击且浮窗保持打开，键盘可以离开浮窗', async () => {
    const action = vi.fn()
    const screen = await render(
      <>
        <button onClick={() => useAssistantStore.getState().openPanel()}>
          分析本次运行
        </button>
        <button onClick={action}>页面操作</button>
        <AssistantHost />
      </>
    )
    const opener = screen.getByRole('button', { name: '分析本次运行' })
    const background = screen.getByRole('button', { name: '页面操作' })
    await opener.click()
    await expect
      .element(page.getByRole('textbox', { name: '向助手提问' }))
      .toHaveFocus()
    await background.click()
    expect(action).toHaveBeenCalledOnce()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('dialog')).toBeVisible()
    expect(document.body.style.pointerEvents).not.toBe('none')
    expect(document.body.style.overflow).not.toBe('hidden')
    page.getByRole('group', { name: '移动助手窗口' }).element().focus()
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    await expect.element(background).toHaveFocus()
    await page.getByRole('button', { name: '关闭识途助手' }).click()
    await expect.element(opener).toHaveFocus()
  })

  it('拖动标题栏移动浮窗，重开保留位置，双击回到右下角', async () => {
    await openAssistant()
    const dialog = page.getByRole('dialog').element()
    const handle = page
      .getByRole('group', { name: '移动助手窗口' })
      .element() as HTMLElement
    const pointer = (type: string, x: number, y: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 31,
          button: 0,
          clientX: x,
          clientY: y,
        })
      )
    vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => {})
    vi.spyOn(handle, 'hasPointerCapture').mockReturnValue(false)
    const start = dialog.getBoundingClientRect()
    pointer('pointerdown', start.x + 100, start.y + 30)
    pointer('pointermove', start.x - 180, start.y - 130)
    pointer('pointerup', start.x - 180, start.y - 130)
    await expect
      .poll(() => dialog.getBoundingClientRect().x)
      .toBeCloseTo(start.x - 280, 0)
    expect(dialog.getBoundingClientRect().y).toBeCloseTo(start.y - 160, 0)
    const moved = dialog.getBoundingClientRect()
    await page.getByRole('button', { name: '关闭识途助手' }).click()
    await page.getByRole('button', { name: '打开识途助手' }).click()
    const reopened = page.getByRole('dialog').element()
    expect(reopened.getBoundingClientRect().x).toBeCloseTo(moved.x, 0)
    expect(reopened.getBoundingClientRect().y).toBeCloseTo(moved.y, 0)
    await userEvent.dblClick(
      page.getByRole('heading', { name: '识途助手', exact: true })
    )
    expect(reopened.getBoundingClientRect().right).toBe(1416)
    expect(reopened.getBoundingClientRect().bottom).toBe(876)
  })

  it('触摸拖动不出界，取消恢复原位，键盘可移动与复位，缩小视口后仍可见', async () => {
    await openAssistant()
    const dialog = page.getByRole('dialog').element()
    const handle = page
      .getByRole('group', { name: '移动助手窗口' })
      .element() as HTMLElement
    vi.spyOn(handle, 'setPointerCapture').mockImplementation(() => {})
    vi.spyOn(handle, 'hasPointerCapture').mockReturnValue(false)
    const pointer = (type: string, x: number, y: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 32,
          pointerType: 'touch',
          button: 0,
          clientX: x,
          clientY: y,
        })
      )
    const start = dialog.getBoundingClientRect()
    pointer('pointerdown', start.x + 100, start.y + 30)
    pointer('pointermove', -2000, -2000)
    await expect.poll(() => dialog.getBoundingClientRect().x).toBe(24)
    expect(dialog.getBoundingClientRect().y).toBe(24)
    pointer('pointercancel', -2000, -2000)
    await expect.poll(() => dialog.getBoundingClientRect().x).toBe(start.x)
    handle.focus()
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}')
    expect(dialog.getBoundingClientRect().x).toBeCloseTo(start.x - 12, 0)
    expect(dialog.getBoundingClientRect().y).toBeCloseTo(start.y - 12, 0)
    await userEvent.keyboard('{Home}')
    expect(dialog.getBoundingClientRect().x).toBe(start.x)
    await page.viewport(390, 480)
    await expect.poll(() => dialog.getBoundingClientRect().right).toBe(378)
    expect(dialog.getBoundingClientRect().bottom).toBe(468)
  })

  it('Enter 提交、Shift+Enter 换行，失败后保留问题并允许重试', async () => {
    vi.mocked(createAssistantConversation).mockRejectedValue(
      new Error('offline')
    )
    await openAssistant()
    await expect
      .element(page.getByRole('button', { name: '发送', exact: true }))
      .toBeDisabled()
    await page.getByRole('textbox', { name: '向助手提问' }).fill('如何配置')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}目标账号')
    expect(createAssistantConversation).not.toHaveBeenCalled()
    await expect
      .element(page.getByRole('textbox', { name: '向助手提问' }))
      .toHaveValue('如何配置\n目标账号')
    await userEvent.keyboard('{Enter}')
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('助手请求失败')
    await expect
      .element(page.getByRole('textbox', { name: '向助手提问' }))
      .toHaveValue('如何配置\n目标账号')
    await expect
      .element(page.getByRole('button', { name: '发送', exact: true }))
      .toBeEnabled()
    expect(createAssistantConversation).toHaveBeenCalledOnce()
  })

  it('长结果只在对话区滚动，跳转后关闭弹窗并保留历史', async () => {
    useAssistantStore.setState({
      turns: [
        turn({
          kind: 'guide',
          items: [
            ...(
              ['browser', 'scenarios', 'runs', 'evidence', 'studio'] as const
            ).map((topic, idx) => ({
              topic,
              availability: 'available' as const,
              title: `导览条目 ${idx + 1}`,
              steps: '这是导览测试条目说明文本。',
              href: null,
            })),
            {
              topic: 'accounts',
              availability: 'available',
              title: '目标账号',
              steps: '先打开目标系统，选择目标后管理账号。',
              href: '/targets',
            },
          ],
        }),
      ],
    })
    await openAssistant()
    const dialog = page.getByRole('dialog').element()
    const conversation = document.querySelector('[aria-label="助手对话"]')!
    expect(conversation.scrollHeight).toBeGreaterThan(conversation.clientHeight)
    expect(dialog.scrollHeight).toBeLessThanOrEqual(dialog.clientHeight)
    await page.getByRole('button', { name: '打开入口' }).click()
    expect(navigate).toHaveBeenCalledWith({ to: '/targets' })
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    expect(useAssistantStore.getState().turns).toHaveLength(1)
  })

  it('关闭弹窗不取消在途请求，重新打开仍可停止并继续澄清', async () => {
    await openAssistant()
    useAssistantStore.setState({
      busy: true,
      conversationId: '11111111-1111-4111-8111-111111111111',
      activeTurnId: '22222222-2222-4222-8222-222222222222',
      question: '目标账号在哪里配置？',
      turns: [
        turn({
          kind: 'clarify',
          question: '本次要做运行诊断，还是查找功能入口？',
          missingFields: ['capabilityId'],
          options: [
            { id: 'run.diagnose', label: '运行诊断' },
            { id: 'platform.guide', label: '功能导览' },
          ],
        }),
      ],
    })
    await expect.element(page.getByRole('status')).toHaveTextContent('正在处理，请稍候')
    await expect
      .element(page.getByRole('button', { name: '发送', exact: true }))
      .toBeDisabled()
    await page.getByRole('button', { name: '关闭识途助手' }).click()
    expect(useAssistantStore.getState().busy).toBe(true)
    await page.getByRole('button', { name: '打开识途助手' }).click()
    await expect.element(page.getByRole('dialog')).toHaveFocus()
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await vi.waitFor(() => expect(useAssistantStore.getState().busy).toBe(false))
    await page.getByRole('button', { name: '功能导览', exact: true }).click()
    expect(useAssistantStore.getState().capabilityHint).toBe('platform.guide')
  })

  it('支持切换至右侧伴随侧栏停靠模式，并保持偏好', async () => {
    await openAssistant()
    // 点击停靠按钮
    const dockBtn = page.getByRole('button', { name: '停靠到右侧边栏' })
    await dockBtn.click()

    expect(useAssistantStore.getState().mode).toBe('docked')
    expect(localStorage.getItem('cairn:assistant:window_mode')).toBe('docked')

    // 验证侧栏区域呈现
    await expect
      .element(page.getByRole('region', { name: '识途助手伴随侧栏' }))
      .toBeVisible()

    // 点击恢复悬浮
    const floatBtn = page.getByRole('button', { name: '恢复悬浮窗' })
    await floatBtn.click()

    expect(useAssistantStore.getState().mode).toBe('floating')
    expect(localStorage.getItem('cairn:assistant:window_mode')).toBe('floating')
  })

  it('展示深度上下文状态胶囊并支持点击推荐 Chip', async () => {
    useAssistantStore.setState({
      boundContext: {
        page: 'run',
        entityId: '8a2f1111-2222-3333-4444-555566667777',
        statusLabel: '运行失败 · 第 4 步网络超时',
        statusTone: 'error',
        summaryText: '由于目标系统未在限定时间内响应，执行中断。',
        chips: [
          {
            label: '为什么第 4 步会超时？',
            question: '请诊断第 4 步超时的根本原因',
            capabilityHint: 'run.diagnose',
          },
        ],
      },
    })

    await openAssistant()
    await expect
      .element(page.getByText('运行失败 · 第 4 步网络超时'))
      .toBeVisible()
    await expect
      .element(page.getByText('由于目标系统未在限定时间内响应，执行中断。'))
      .toBeVisible()

    const chipBtn = page.getByRole('button', { name: '为什么第 4 步会超时？' })
    await expect.element(chipBtn).toBeVisible()
  })

  it('展示 Quote Pill 并支持 Backspace 移除', async () => {
    useAssistantStore.setState({
      activeQuote: {
        type: 'step_failure',
        targetId: 'step-4',
        title: '步骤 #4: 点击提交订单',
        summary: 'locator.click: Timeout 5000ms',
      },
    })

    await openAssistant()
    await expect.element(page.getByText('步骤 #4: 点击提交订单')).toBeVisible()

    const input = page.getByRole('textbox', { name: '向助手提问' })
    await input.click()
    await userEvent.keyboard('{Backspace}')

    expect(useAssistantStore.getState().activeQuote).toBeNull()
  })

  it('当平台 AI 未启用时呈现警示胶囊并禁用输入区', async () => {
    vi.mocked(fetchAssistantCapabilities).mockResolvedValueOnce({
      items: [],
      modelEnabled: false,
    })
    await render(<AssistantHost />)
    await page.getByRole('button', { name: '打开识途助手' }).click()
    await expect.element(page.getByTestId('model-disabled-banner')).toBeVisible()
    await expect
      .element(page.getByRole('textbox', { name: '向助手提问' }))
      .toBeDisabled()
    await expect
      .element(page.getByRole('button', { name: '发送', exact: true }))
      .toBeDisabled()
  })

  it('覆盖式停靠助手获得初始焦点、约束 Tab，Escape 和遮罩关闭后回到入口', async () => {
    await page.viewport(390, 844)
    useAssistantStore.setState({ mode: 'docked', dockWidth: 400 })
    const screen = await render(
      <>
        <button type='button'>页面操作</button>
        <AssistantHost />
      </>
    )
    const opener = screen.getByRole('button', { name: '打开识途助手' })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: '识途助手伴随侧栏' })
    await expect.element(dialog).toBeVisible()
    await expect.element(dialog).toHaveAttribute('aria-modal', 'true')
    await expect.element(page.getByRole('textbox', { name: '向助手提问' })).toHaveFocus()

    const focusable = Array.from(dialog.element().querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ))
    expect(focusable.length).toBeGreaterThan(1)
    focusable[focusable.length - 1]!.focus()
    await userEvent.keyboard('{Tab}')
    expect(dialog.element().contains(document.activeElement)).toBe(true)
    focusable[0]!.focus()
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    expect(dialog.element().contains(document.activeElement)).toBe(true)

    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    await expect.element(opener).toHaveFocus()

    await opener.click()
    await expect.element(dialog).toBeVisible()
    const backdrop = document.querySelector<HTMLElement>('[data-assistant-sidebar="true"][data-state="open"]')
    expect(backdrop).not.toBeNull()
    backdrop!.click()
    await expect.element(dialog).not.toBeInTheDocument()
    await expect.element(opener).toHaveFocus()
  })

  it('覆盖式停靠助手随视口变宽回到非模态停靠栏时保留面板焦点', async () => {
    await page.viewport(390, 844)
    useAssistantStore.setState({ mode: 'docked', dockWidth: 400 })
    await render(<AssistantHost />)
    await page.getByRole('button', { name: '打开识途助手' }).click()
    await expect.element(page.getByRole('dialog', { name: '识途助手伴随侧栏' })).toBeVisible()

    await page.viewport(1600, 900)
    const region = page.getByRole('region', { name: '识途助手伴随侧栏' })
    await expect.element(region).toBeVisible()
    await expect.element(page.getByRole('dialog', { name: '识途助手伴随侧栏' })).not.toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: '向助手提问' })).toHaveFocus()
    expect(region.element().contains(document.activeElement)).toBe(true)
  })

  it('覆盖式停靠助手切换回悬浮窗时由新面板接管焦点', async () => {
    await page.viewport(390, 844)
    useAssistantStore.setState({ mode: 'docked', dockWidth: 400 })
    await render(<AssistantHost />)
    await page.getByRole('button', { name: '打开识途助手' }).click()
    await expect.element(page.getByRole('dialog', { name: '识途助手伴随侧栏' })).toBeVisible()

    await page.getByRole('button', { name: '恢复悬浮窗' }).click()
    await expect.element(page.getByRole('dialog', { name: '识途助手' })).toBeVisible()
    await expect.element(page.getByRole('textbox', { name: '向助手提问' })).toHaveFocus()
    await page.getByRole('button', { name: '关闭识途助手' }).click()
    await expect.element(page.getByRole('button', { name: '打开识途助手' })).toHaveFocus()
  })

  it('从顶栏打开浮窗再切为窄屏覆盖层，Escape 关闭后回到顶栏入口', async () => {
    await page.viewport(1024, 768)
    useAssistantStore.setState({ mode: 'floating', dockWidth: 400 })
    const screen = await render(
      <TooltipProvider>
        <HeaderAssistantTrigger />
        <AssistantHost showFloatingLauncher={false} />
      </TooltipProvider>
    )
    const headerTrigger = screen.getByRole('button', { name: '打开识途助手' })
    await headerTrigger.click()
    await expect.element(page.getByRole('dialog', { name: '识途助手' })).toBeVisible()

    await page.getByRole('button', { name: '停靠到右侧边栏' }).click()
    const overlay = page.getByRole('dialog', { name: '识途助手伴随侧栏' })
    await expect.element(overlay).toBeVisible()
    await expect.element(page.getByRole('textbox', { name: '向助手提问' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')

    await expect.element(overlay).not.toBeInTheDocument()
    await expect.element(headerTrigger).toHaveFocus()
  })
})
