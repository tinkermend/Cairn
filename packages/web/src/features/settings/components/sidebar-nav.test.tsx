import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { SidebarNav } from './sidebar-nav'

const route = vi.hoisted(() => ({ pathname: '/settings', navigate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: route.pathname }),
  useNavigate: () => route.navigate,
  Link: ({ to, ...props }: ComponentProps<'a'> & { to: string }) => <a {...props} href={to} />,
}))

describe('个人设置导航', () => {
  it('外部入口切换路由后，窄屏选择器跟随实际页面', async () => {
    const items = [
      { href: '/settings', title: '个人资料', icon: <span /> },
      { href: '/settings/account', title: '修改密码', icon: <span /> },
    ]
    route.pathname = '/settings'
    const screen = await render(<SidebarNav items={items} />)
    await expect.element(screen.getByRole('combobox', { name: '个人设置页面' })).toHaveTextContent('个人资料')
    route.pathname = '/settings/account'
    await screen.rerender(<SidebarNav items={items} />)
    await expect.element(screen.getByRole('combobox', { name: '个人设置页面' })).toHaveTextContent('修改密码')
  })
})
