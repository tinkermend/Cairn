import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { useAuthStore } from '@/stores/auth-store'
import { AccountMenuItems } from './account-menu-items'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './ui/dropdown-menu'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, ...props }: ComponentProps<'a'> & { to: string }) => (
    <a {...props} href={to} onClick={(event) => { event.preventDefault(); props.onClick?.(event) }} />
  ),
}))

async function renderMenu(permissions: string[]) {
  useAuthStore.getState().auth.setUser({ id: 'user', displayName: '测试', email: null, roles: [], permissions })
  const onSignOut = vi.fn()
  const onNavigate = vi.fn()
  const screen = await render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>账户</DropdownMenuTrigger>
      <DropdownMenuContent>
        <AccountMenuItems onSignOut={onSignOut} onNavigate={onNavigate} />
      </DropdownMenuContent>
    </DropdownMenu>,
  )
  return { screen, onNavigate, onSignOut }
}

describe('账户菜单', () => {
  beforeEach(() => useAuthStore.getState().auth.reset())

  it('个人入口保留权限门槛，无设置权限时仍可退出登录', async () => {
    const { screen, onSignOut } = await renderMenu([])
    expect(screen.getByRole('menuitem', { name: '个人资料' }).elements()).toHaveLength(0)
    expect(screen.getByRole('menuitem', { name: '修改密码' }).elements()).toHaveLength(0)
    await screen.getByRole('menuitem', { name: '退出登录' }).click()
    expect(onSignOut).toHaveBeenCalledOnce()
  })

  it('个人设置使用原有路径，选择后通知移动侧栏关闭', async () => {
    const { screen, onNavigate, onSignOut } = await renderMenu(['settings:read'])
    await expect.element(screen.getByRole('menuitem', { name: '个人资料' })).toHaveAttribute('href', '/settings')
    await expect.element(screen.getByRole('menuitem', { name: '修改密码' })).toHaveAttribute('href', '/settings/account')
    expect(screen.getByRole('menuitem', { name: '外观' }).elements()).toHaveLength(0)
    await screen.getByRole('menuitem', { name: '修改密码' }).click()
    expect(onNavigate).toHaveBeenCalledOnce()
    expect(onSignOut).not.toHaveBeenCalled()
  })
})
