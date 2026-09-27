import '@/styles/index.css'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { HeaderAssistantTrigger } from './header-assistant-trigger'

describe('HeaderAssistantTrigger (顶栏协同触发位)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    useAuthStore.getState().auth.reset()
    useAuthStore.getState().auth.setUser({
      id: 'u1',
      displayName: '测试用户',
      email: null,
      roles: ['admin'],
      permissions: ['ai:assist'],
    })
    useAssistantStore.setState({ open: false, busy: false })
  })

  afterEach(() => {
    useAuthStore.getState().auth.reset()
    useAssistantStore.setState({ open: false, busy: false })
  })

  it('具有 ai:assist 权限时渲染顶栏入口并能切换开闭状态', async () => {
    await render(
      <TooltipProvider>
        <HeaderAssistantTrigger />
      </TooltipProvider>
    )

    const btn = page.getByRole('button', { name: '打开识途助手' })
    await expect.element(btn).toBeVisible()
    expect(useAssistantStore.getState().open).toBe(false)

    await btn.click()
    expect(useAssistantStore.getState().open).toBe(true)

    await btn.click()
    expect(useAssistantStore.getState().open).toBe(false)
  })

  it('无权限时不渲染顶栏入口', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u2',
      displayName: '无AI权限',
      email: null,
      roles: ['viewer'],
      permissions: ['run:read'],
    })

    const screen = await render(
      <TooltipProvider>
        <HeaderAssistantTrigger />
      </TooltipProvider>
    )

    expect(screen.getByRole('button', { name: '打开识途助手' }).elements()).toHaveLength(0)
  })
})
