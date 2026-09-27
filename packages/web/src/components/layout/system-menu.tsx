import { useState, useRef, useMemo } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { SlidersHorizontal, ChevronRight, Activity } from 'lucide-react'
import { filterNavItems } from '@/lib/rbac'
import { useAuthStore } from '@/stores/auth-store'
import { useSidebar } from '@/components/ui/sidebar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { systemNavGroups } from './data/sidebar-data'
import { PlatformHealthIndicator } from './platform-health-indicator'
import { usePlatformHealth } from '@/hooks/use-platform-health'
import { cn } from '@/lib/utils'

export function SystemMenu() {
  const user = useAuthStore((s) => s.auth.user)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { state, isMobile, setOpenMobile } = useSidebar()
  const isCollapsed = state === 'collapsed'
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { data: healthData } = usePlatformHealth()

  // 权限裁剪
  const visibleGroups = useMemo(() => {
    return systemNavGroups
      .map((group) => ({
        title: group.title,
        items: filterNavItems(group.items, user),
      }))
      .filter((group) => group.items.length > 0)
  }, [user])

  // 一项权限都没有时整个入口不渲染
  if (visibleGroups.length === 0) return null

  // 判断是否属于管理路由
  const isActive = visibleGroups.some((group) =>
    group.items.some((item) => {
      if ('url' in item) {
        return pathname === item.url || pathname.startsWith(item.url + '/')
      }
      return false
    }),
  )

  const handleLinkClick = () => {
    setOpen(false)
    if (isMobile) setOpenMobile(false)
  }

  const triggerButton = (
    <button
      ref={triggerRef}
      type='button'
      aria-label='系统与管理'
      aria-haspopup='dialog'
      aria-expanded={open}
      data-active={isActive ? 'true' : undefined}
      className={cn(
        'group/sys-menu relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-label font-medium transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-primary',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        isActive
          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold'
          : 'text-muted-foreground',
        isCollapsed && 'justify-center px-0 size-9 mx-auto',
      )}
    >
      <SlidersHorizontal className='size-4 shrink-0' aria-hidden='true' />
      {!isCollapsed ? (
        <>
          <span className='truncate flex-1 text-start'>系统与管理</span>
          <PlatformHealthIndicator variant='compact' />
          <ChevronRight
            className={cn('size-3.5 shrink-0 transition-transform duration-200', open && 'rotate-90')}
            aria-hidden='true'
          />
        </>
      ) : (
        <span className='absolute top-1.5 right-1.5'>
          <PlatformHealthIndicator variant='compact' />
        </span>
      )}
    </button>
  )

  return (
    <div className='relative w-full'>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) {
            triggerRef.current?.focus({ preventScroll: true })
          }
        }}
      >
        {isCollapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side='right'>系统与管理</TooltipContent>
          </Tooltip>
        ) : (
          <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
        )}

        <PopoverContent
          side={isMobile ? 'bottom' : 'right'}
          align='end'
          sideOffset={8}
          className='w-72 p-3 text-popover-foreground shadow-xl border border-border-default'
        >
          {/* 顶部平台健康概况卡片 */}
          <div className='rounded-md border border-border-divider bg-muted/40 p-2.5 mb-3'>
            <div className='flex items-center justify-between'>
              <div className='flex items-center gap-1.5 text-small font-semibold text-foreground'>
                <Activity className='size-3.5 text-primary' />
                <span>平台运行概况</span>
              </div>
              <PlatformHealthIndicator variant='compact' />
            </div>
            <div className='mt-1 text-caption text-muted-foreground'>
              {healthData?.overall === 'healthy'
                ? `所有核心能力正常 (${healthData.checks.worker.healthyNodes} 个执行节点在服)`
                : healthData?.overall === 'degraded'
                  ? '平台处于部分降级状态'
                  : healthData?.overall === 'critical'
                    ? '平台存在关键服务故障'
                    : '平台健康状态检查中'}
            </div>
          </div>

          {/* 管理分组段落 */}
          <div className='space-y-3'>
            {visibleGroups.map((group) => (
              <div key={group.title} className='space-y-1'>
                <div className='px-1.5 text-caption font-semibold text-muted-foreground uppercase tracking-wider'>
                  {group.title}
                </div>
                <div className='space-y-0.5'>
                  {group.items.map((item) => {
                    const isItemActive = 'url' in item && (pathname === item.url || pathname.startsWith(item.url + '/'))
                    const Icon = 'icon' in item && item.icon ? item.icon : null
                    return (
                      <Link
                        key={item.title}
                        to={'url' in item ? item.url : '#'}
                        onClick={handleLinkClick}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-small transition-colors',
                          isItemActive
                            ? 'bg-primary/10 text-primary font-medium'
                            : 'text-foreground hover:bg-accent hover:text-accent-foreground',
                        )}
                      >
                        {Icon ? <Icon className='size-3.5 shrink-0 text-muted-foreground' /> : null}
                        <span className='truncate'>{item.title}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
