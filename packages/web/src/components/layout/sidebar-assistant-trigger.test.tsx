import '@/styles/index.css'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { SidebarProvider } from '@/components/ui/sidebar'
import { SidebarAssistantTrigger } from './sidebar-assistant-trigger'

describe('SidebarAssistantTrigger (系统外围侧栏底栏助手入口)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await page.viewport(1280, 800)
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

  it('具有 ai:assist 权限时渲染伴随入口，并显示 ⌘J 快捷键', async () => {
    await render(
      <SidebarProvider>
        <SidebarAssistantTrigger />
      </SidebarProvider>
    )

    const btn = page.getByRole('button', { name: '打开识途助手' })
    await expect.element(btn).toBeVisible()
    await expect.element(page.getByText('识途助手')).toBeVisible()
    await expect.element(page.getByText('⌘J')).toBeVisible()
  })

  it('点击可触发助手面板的打开与关闭切换', async () => {
    await render(
      <SidebarProvider>
        <SidebarAssistantTrigger />
      </SidebarProvider>
    )

    const btn = page.getByRole('button', { name: '打开识途助手' })
    expect(useAssistantStore.getState().open).toBe(false)

    await btn.click()
    expect(useAssistantStore.getState().open).toBe(true)

    await btn.click()
    expect(useAssistantStore.getState().open).toBe(false)
  })

  it('没有 ai:assist 权限时不渲染任何入口', async () => {
    useAuthStore.getState().auth.setUser({
      id: 'u2',
      displayName: '无AI权限',
      email: null,
      roles: ['viewer'],
      permissions: ['run:read'],
    })

    const screen = await render(
      <SidebarProvider>
        <SidebarAssistantTrigger />
      </SidebarProvider>
    )

    expect(screen.getByRole('button', { name: '打开识途助手' }).elements()).toHaveLength(0)
  })
})
