import { useState, useRef, useMemo, useId } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { SlidersHorizontal, ChevronRight, Activity, ArrowRight } from 'lucide-react'
import { can, filterNavItems } from '@/lib/rbac'
import { useAuthStore } from '@/stores/auth-store'
import { useSidebar } from '@/components/ui/sidebar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { systemNavGroups } from './data/sidebar-data'
import { usePlatformHealth } from '@/hooks/use-platform-health'
import { cn } from '@/lib/utils'

export function SystemMenu({ healthOnly = false }: { healthOnly?: boolean }) {
  const user = useAuthStore((s) => s.auth.user)
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { state, isMobile, setOpenMobile } = useSidebar()
  const isCollapsed = !isMobile && state === 'collapsed'
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const detailsId = useId()
  const { data: healthData, isChecking } = usePlatformHealth()
  const canMonitor = can(user, 'monitor:read')

  // 权限裁剪
  const visibleGroups = useMemo(() => {
    return healthOnly ? [] : systemNavGroups
      .map((group) => ({
        title: group.title,
        items: filterNavItems(group.items, user),
      }))
      .filter((group) => group.items.length > 0)
  }, [healthOnly, user])

  const triggerLabel = healthOnly || visibleGroups.length === 0 ? '平台运行概况' : '系统管理'
  const healthState = !healthData
    ? isChecking ? 'checking' : 'unknown'
    : healthData.overall === 'healthy'
      ? 'healthy'
      : healthData.overall === 'unknown'
        ? 'unknown'
        : 'abnormal'
  const healthLabel = healthState === 'healthy' ? '正常' : healthState === 'abnormal' ? '异常' : healthState === 'checking' ? '检查中' : '待确认'
  const healthClasses = healthState === 'healthy'
    ? 'text-status-success-foreground bg-status-success-background'
    : healthState === 'abnormal'
      ? 'text-status-error-foreground bg-status-error-background'
      : 'text-status-waiting-foreground bg-status-waiting-background'
  const dotClasses = healthState === 'healthy'
    ? 'bg-status-success-accent'
    : healthState === 'abnormal'
      ? 'bg-status-error-accent'
      : 'bg-status-waiting-foreground'
  const issueRows = healthData
    ? [
        { label: 'API 服务', item: healthData.checks.api },
        { label: '数据库', item: healthData.checks.database },
        { label: '执行节点', item: healthData.checks.worker },
        { label: '变更提示', item: healthData.checks.changeHint },
      ].filter(({ item }) => item.status !== 'healthy' && item.status !== 'unused')
    : []

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

  const healthOverview = (
    <div className='rounded-md border border-border-divider bg-muted/40 p-2.5'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-1.5 text-small font-semibold text-foreground'>
          <Activity className='size-3.5 text-primary' />
          <span>平台运行概况</span>
        </div>
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-label font-medium border border-border/30', healthClasses)} role='status'>
          <span className='relative flex size-1.5'>
            {healthState === 'healthy' && (
              <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-status-success-accent opacity-75' />
            )}
            <span className={cn('relative inline-flex size-1.5 rounded-full', dotClasses)} />
          </span>
          {healthLabel}
        </span>
      </div>
      {healthState === 'healthy' ? (
        <p className='mt-1 text-label text-muted-foreground'>核心能力正常，{healthData?.checks.worker.healthyNodes} 个执行节点在服</p>
      ) : healthState === 'checking' ? (
        <p className='mt-1 text-label text-muted-foreground'>正在检查核心能力…</p>
      ) : (
        <div className='mt-2 space-y-2 border-t border-border-divider pt-2'>
          {issueRows.length > 0 ? issueRows.map(({ label, item }) => (
            <div key={label} className='text-label'>
              <div className='font-medium text-foreground'>{label}</div>
              <div className={cn('mt-0.5 break-words', item.status === 'unknown' ? 'text-muted-foreground' : 'text-status-error-foreground')}>
                {item.message}
              </div>
            </div>
          )) : <p className='text-label text-muted-foreground'>组件状态尚未确认</p>}
          {canMonitor ? (
            <Link to='/monitoring' onClick={handleLinkClick} className='inline-flex items-center gap-1 text-label font-medium text-primary hover:underline'>
              查看监控详情
              <ArrowRight className='size-3' aria-hidden='true' />
            </Link>
          ) : null}
        </div>
      )}
    </div>
  )

  const triggerButton = (
    <button
      ref={triggerRef}
      type='button'
      aria-label={`${triggerLabel}，平台状态：${healthLabel}`}
      aria-haspopup={isMobile ? undefined : 'dialog'}
      aria-controls={isMobile ? detailsId : undefined}
      aria-expanded={open}
      onClick={isMobile ? () => setOpen((current) => !current) : undefined}
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
          <span className='truncate flex-1 text-start'>{triggerLabel}</span>
          <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-label font-medium border border-border/30', healthClasses)} aria-hidden='true'>
            <span className='relative flex size-1.5'>
              {healthState === 'healthy' && (
                <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-status-success-accent opacity-75' />
              )}
              <span className={cn('relative inline-flex size-1.5 rounded-full', dotClasses)} />
            </span>
            {healthLabel}
          </span>
          <ChevronRight
            className={cn('size-3.5 shrink-0 transition-transform duration-200', open && 'rotate-90')}
            aria-hidden='true'
          />
        </>
      ) : (
        <span className='absolute top-1.5 right-1.5 flex size-2' aria-hidden='true'>
          {healthState === 'healthy' && (
            <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-status-success-accent opacity-75' />
          )}
          <span className={cn('relative inline-flex size-2 rounded-full', dotClasses)} />
        </span>
      )}
    </button>
  )

  if (isMobile) {
    // Sheet 本身是模态 Dialog，明细留在 Sheet 内，避免嵌套 Popover Portal 被关闭。
    return (
      <div className='relative w-full'>
        {triggerButton}
        {open ? (
          <div id={detailsId} role='region' aria-label='平台运行概况明细' className='mt-1 max-h-[50dvh] overflow-y-auto'>
            {healthOverview}
          </div>
        ) : null}
      </div>
    )
  }

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
            <TooltipContent side='right'>{triggerLabel} · {healthLabel}</TooltipContent>
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
          {/* 平台健康概况留在侧栏入口内，所有已登录用户可见。 */}
          <div className='mb-3'>{healthOverview}</div>

          {/* 管理分组段落 */}
          {visibleGroups.length > 0 ? <div className='space-y-3'>
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
          </div> : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}
