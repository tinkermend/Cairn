import { Link } from '@tanstack/react-router'
import { Logo } from '@/assets/logo'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'

export function AppTitle() {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size='lg'
          className='h-auto min-h-12 items-center gap-2 px-1.5 py-1.5 hover:bg-transparent active:bg-transparent [&>span:last-child]:overflow-visible [&>span:last-child]:whitespace-normal'
          asChild
        >
          <Link
            to='/'
            onClick={() => setOpenMobile(false)}
            className='text-start'
          >
            <Logo className='size-10' alt='' />
            <span className='grid min-w-0'>
              <span className='truncate text-section leading-5 font-semibold'>
                识途
              </span>
              <span className='whitespace-nowrap text-small leading-4 text-text-secondary'>
                可观测场景执行平台
              </span>
            </span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
