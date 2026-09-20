import { Outlet } from '@tanstack/react-router'
import { KeyRound, UserCog } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { SidebarNav } from './components/sidebar-nav'

const sidebarNavItems = [
  {
    title: '个人资料',
    href: '/settings',
    icon: <UserCog size={18} />,
  },
  {
    title: '修改密码',
    href: '/settings/account',
    icon: <KeyRound size={18} />,
  },
]

export function Settings() {
  return (
    <Main fixed>
        <PageHeader title='个人设置' description='管理个人资料与登录密码。' />
        <Separator className='my-4 lg:my-6' />
        <div className='flex flex-1 flex-col space-y-2 overflow-hidden md:space-y-2 lg:flex-row lg:space-y-0 lg:space-x-12'>
          <aside className='top-0 lg:sticky lg:w-1/5'>
            <SidebarNav items={sidebarNavItems} />
          </aside>
          <div className='flex w-full overflow-y-hidden p-1'>
            <Outlet />
          </div>
        </div>
    </Main>
  )
}
