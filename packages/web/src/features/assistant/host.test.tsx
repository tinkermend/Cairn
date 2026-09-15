import '@/styles/index.css'
import type { AssistantTurn } from '@cairn/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { createAssistantConversation } from '@/lib/assistant-api'
import { AssistantHost } from './host'

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
    ],
    modelEnabled: false,
  })),
  createAssistantConversation: vi.fn(),
  createAssistantTurn: vi.fn(),
  fetchAssistantTurns: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => navigate }
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
            {
              topic: 'accounts',
              availability: 'available',
              title: '目标账号',
              steps: '先打开目标系统，选择目标后管理账号。'.repeat(160),
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
    await expect.element(page.getByRole('status')).toHaveTextContent('正在分析')
    await expect
      .element(page.getByRole('button', { name: '发送', exact: true }))
      .toBeDisabled()
    await page.getByRole('button', { name: '关闭识途助手' }).click()
    expect(useAssistantStore.getState().busy).toBe(true)
    await page.getByRole('button', { name: '打开识途助手' }).click()
    await expect.element(page.getByRole('dialog')).toHaveFocus()
    await page.getByRole('button', { name: '停止', exact: true }).click()
    expect(useAssistantStore.getState().busy).toBe(false)
    await page.getByRole('button', { name: '功能导览', exact: true }).click()
    expect(useAssistantStore.getState().capabilityHint).toBe('platform.guide')
  })
})
