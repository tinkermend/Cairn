import { Link } from '@tanstack/react-router'
import { Logo } from '@/assets/logo'
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'

export function AppTitle() {
  const { state, setOpenMobile } = useSidebar()
  const isCollapsed = state === 'collapsed'

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className='flex items-center justify-between w-full min-h-10 px-1 py-1'>
          <Link
            to='/'
            onClick={() => setOpenMobile(false)}
            className='flex items-center gap-2.5 min-w-0 text-start group/logo outline-hidden rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-subtle'
            aria-label='返回控制台总览'
          >
            <Logo className='size-9 shrink-0' alt='' />
            {!isCollapsed ? (
              <span className='flex flex-col justify-center min-w-0 leading-tight'>
                <span className='truncate text-section font-bold tracking-tight text-foreground'>
                  识途
                </span>
                <span className='whitespace-nowrap text-label text-text-muted tracking-tight mt-0.5'>
                  智能场景执行平台
                </span>
              </span>
            ) : null}
          </Link>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
