import { Link } from '@tanstack/react-router'
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { Logo } from '@/assets/logo'
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useKeybindingsStore } from '@/stores/keybindings-store'
import { formatShortcut } from '@/lib/platform'
import { cn } from '@/lib/utils'

export function AppTitle() {
  const { state, toggleSidebar, setOpenMobile, isMobile } = useSidebar()
  const isCollapsed = state === 'collapsed'
  const toggleKey = useKeybindingsStore((s) => s.getEffectiveKey('sidebar.toggle'))
  const shortcutHint = formatShortcut(toggleKey)

  const toggleTooltip = isCollapsed
    ? `展开侧栏 (${shortcutHint})`
    : `收起侧栏 (${shortcutHint})`

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className='flex items-center justify-between w-full min-h-10 px-1 py-1'>
          <Link
            to='/'
            onClick={() => setOpenMobile(false)}
            className='flex items-center gap-2 min-w-0 text-start group/logo outline-hidden'
            aria-label='返回控制台总览'
          >
            <Logo className='size-8 shrink-0' alt='' />
            {!isCollapsed ? (
              <span className='grid min-w-0'>
                <span className='truncate text-section leading-5 font-semibold text-foreground'>
                  识途
                </span>
                <span className='whitespace-nowrap text-small leading-4 text-text-secondary'>
                  可观测场景执行平台
                </span>
              </span>
            ) : null}
          </Link>

          {!isMobile ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  onClick={toggleSidebar}
                  aria-label={toggleTooltip}
                  className={cn(
                    'flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-primary',
                    isCollapsed ? 'mx-auto mt-1' : 'shrink-0',
                  )}
                >
                  {isCollapsed ? (
                    <PanelLeftOpen className='size-4' aria-hidden='true' />
                  ) : (
                    <PanelLeftClose className='size-4' aria-hidden='true' />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side={isCollapsed ? 'right' : 'bottom'}>
                {toggleTooltip}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
