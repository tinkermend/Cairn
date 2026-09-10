import { cn } from '@/lib/utils'
import { useHealth } from '@/hooks/use-health'
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'

/**
 * 后端连通状态。
 *
 * 它同时是前后端契约的运行时验证：响应由 @cairn/shared 的
 * healthResponseSchema 解析，与 api 序列化时用的是同一个 schema 对象。
 * 契约漂移会让这里直接变红，而不是等到某个页面渲染出 undefined。
 */
export function ApiStatus() {
  const { data, isPending, isError } = useHealth()

  const tone = isPending
        ? { dot: 'bg-status-waiting-foreground', label: '连接中…' }
      : isError
        ? { dot: 'bg-status-error-accent', label: '后端不可达' }
        : data?.status === 'ok'
          ? { dot: 'bg-status-success-accent', label: '后端正常' }
          : { dot: 'bg-status-warning-accent', label: '后端降级' }

  const detail = data ? `数据库 ${data.checks.database === 'up' ? '正常' : '不可用'}` : undefined

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size='sm' className='cursor-default' tooltip={tone.label}>
          <span className={cn('size-2 shrink-0 rounded-full', tone.dot)} aria-hidden />
          <span className='truncate text-label'>
            {tone.label}
            {detail ? <span className='text-muted-foreground'> · {detail}</span> : null}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
