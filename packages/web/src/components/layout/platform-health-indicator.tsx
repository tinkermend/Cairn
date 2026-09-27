import { Link } from '@tanstack/react-router'
import { ArrowRight, Loader2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { usePlatformHealth } from '@/hooks/use-platform-health'
import { useAuthStore } from '@/stores/auth-store'
import { can } from '@/lib/rbac'
import { cn } from '@/lib/utils'
import type { PlatformHealthStatus, ChangeHintHealthStatus } from '@cairn/shared'

const STATUS_DOT_CLASSES: Record<PlatformHealthStatus | ChangeHintHealthStatus, string> = {
  healthy: 'bg-status-success-accent',
  degraded: 'bg-status-warning-accent',
  critical: 'bg-status-error-accent',
  unknown: 'bg-status-waiting-foreground',
  unused: 'bg-muted-foreground/40',
}

const STATUS_TEXT_CLASSES: Record<PlatformHealthStatus | ChangeHintHealthStatus, string> = {
  healthy: 'text-status-success-accent',
  degraded: 'text-status-warning-accent',
  critical: 'text-status-error-accent',
  unknown: 'text-muted-foreground',
  unused: 'text-muted-foreground/60',
}

export function PlatformHealthIndicator({
  variant = 'topbar',
  className,
}: {
  variant?: 'topbar' | 'compact'
  className?: string
}) {
  const user = useAuthStore((s) => s.auth.user)
  const { data, isChecking, isStale } = usePlatformHealth()
  const canMonitor = can(user, 'monitor:read')

  if (isChecking && !data) {
    if (variant === 'compact') {
      return (
        <span
          className={cn('size-2 shrink-0 rounded-full bg-status-waiting-foreground animate-pulse', className)}
          title='平台健康：正在检查'
        />
      )
    }
    return (
      <div
        className={cn(
          'flex h-8 items-center gap-1.5 px-2 text-label text-muted-foreground select-none',
          className,
        )}
        aria-label='平台健康：正在检查'
      >
        <Loader2 className='size-3.5 animate-spin' aria-hidden='true' />
        <span className='hidden sm:inline'>正在检查</span>
      </div>
    )
  }

  if (!data) return null

  const overall = data.overall

  // 顶栏正常时默认不常驻显示，异常或未知时展示；compact 模式（侧栏）显示状态圆点
  if (variant === 'topbar' && overall === 'healthy') {
    return null
  }

  const label =
    overall === 'healthy'
      ? '平台正常'
      : overall === 'degraded'
        ? '平台降级'
        : overall === 'critical'
          ? '关键故障'
          : '状态未确认'

  const dotClass = STATUS_DOT_CLASSES[overall]

  if (variant === 'compact') {
    return (
      <span
        className={cn('size-2 shrink-0 rounded-full', dotClass, className)}
        title={`平台健康：${label}`}
        aria-label={`平台健康：${label}`}
      />
    )
  }

  const formattedTime = new Date(data.asOf).toLocaleTimeString()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant='ghost'
          size='sm'
          className={cn(
            'flex h-8 items-center gap-1.5 px-2 text-label font-medium transition-colors hover:bg-muted',
            overall === 'critical' && 'text-status-error-accent hover:text-status-error-accent',
            overall === 'degraded' && 'text-status-warning-accent hover:text-status-warning-accent',
            overall === 'unknown' && 'text-muted-foreground',
            className,
          )}
          aria-label={`平台健康状态：${label}`}
        >
          <span className={cn('size-2 shrink-0 rounded-full', dotClass)} aria-hidden='true' />
          <span className='hidden sm:inline'>{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-80 p-3' align='end' sideOffset={6}>
        <div className='flex items-center justify-between border-b border-border-divider pb-2'>
          <div className='flex items-center gap-1.5'>
            <span className={cn('size-2 rounded-full', dotClass)} />
            <span className='text-small font-semibold text-foreground'>平台健康详情</span>
          </div>
          <span className='text-caption text-muted-foreground'>{isStale ? '结果已过期' : formattedTime}</span>
        </div>

        <div className='mt-2.5 space-y-2.5 text-label'>
          {/* API */}
          <div className='flex items-start justify-between gap-2'>
            <div className='flex items-center gap-1.5'>
              <span className={cn('size-1.5 rounded-full shrink-0', STATUS_DOT_CLASSES[data.checks.api.status])} />
              <span className='text-foreground font-medium'>API 服务</span>
            </div>
            <span className={cn('text-end truncate max-w-[170px]', STATUS_TEXT_CLASSES[data.checks.api.status])}>
              {data.checks.api.message}
            </span>
          </div>

          {/* 数据库 */}
          <div className='flex items-start justify-between gap-2'>
            <div className='flex items-center gap-1.5'>
              <span className={cn('size-1.5 rounded-full shrink-0', STATUS_DOT_CLASSES[data.checks.database.status])} />
              <span className='text-foreground font-medium'>数据库</span>
            </div>
            <span className={cn('text-end truncate max-w-[170px]', STATUS_TEXT_CLASSES[data.checks.database.status])}>
              {data.checks.database.message}
            </span>
          </div>

          {/* 执行节点 */}
          <div className='flex items-start justify-between gap-2'>
            <div className='flex items-center gap-1.5'>
              <span className={cn('size-1.5 rounded-full shrink-0', STATUS_DOT_CLASSES[data.checks.worker.status])} />
              <span className='text-foreground font-medium'>执行节点</span>
            </div>
            <div className='text-end max-w-[170px]'>
              <div className={cn('truncate', STATUS_TEXT_CLASSES[data.checks.worker.status])}>
                {data.checks.worker.message}
              </div>
              {data.checks.worker.healthyNodes > 0 ? (
                <div className='text-caption text-muted-foreground'>
                  在服健康节点: {data.checks.worker.healthyNodes}
                </div>
              ) : null}
            </div>
          </div>

          {/* 变更提示 */}
          <div className='flex items-start justify-between gap-2'>
            <div className='flex items-center gap-1.5'>
              <span className={cn('size-1.5 rounded-full shrink-0', STATUS_DOT_CLASSES[data.checks.changeHint.status])} />
              <span className='text-foreground font-medium'>变更提示</span>
            </div>
            <span className={cn('text-end truncate max-w-[170px]', STATUS_TEXT_CLASSES[data.checks.changeHint.status])}>
              {data.checks.changeHint.message}
            </span>
          </div>
        </div>

        {canMonitor ? (
          <div className='mt-3 border-t border-border-divider pt-2 flex justify-end'>
            <Button variant='ghost' size='sm' className='h-7 text-caption gap-1 px-2 text-primary hover:text-primary' asChild>
              <Link to='/monitoring'>
                进入监控中心
                <ArrowRight className='size-3' />
              </Link>
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
