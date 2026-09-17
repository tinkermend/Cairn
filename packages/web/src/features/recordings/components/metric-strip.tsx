import type { RecordingDraftDetailDto, RecordingItemStatus } from '@cairn/shared'
import { AlertCircle, AlertTriangle, CheckCircle2, FileText, KeyRound } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { cn } from '@/lib/utils'

type Props = {
  draft: RecordingDraftDetailDto
  activeFilter: 'all' | RecordingItemStatus | 'sensitive'
  onFilterChange: (filter: 'all' | RecordingItemStatus | 'sensitive') => void
}

export function RecordingMetricStrip({ draft, activeFilter, onFilterChange }: Props) {
  const mappedCount = draft.items.filter((i) => i.status === 'mapped').length
  const parameterizedCount = draft.items.filter((i) => i.status === 'parameterized').length
  const sensitiveCount = draft.items.filter((i) => i.sensitive).length

  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4'>
        {/* 全部步骤 */}
        <button
          type='button'
          onClick={() => onFilterChange('all')}
          className={cn(
            'flex flex-col rounded-lg border bg-card p-3.5 text-left shadow-card transition-colors',
            activeFilter === 'all'
              ? 'border-primary ring-1 ring-primary/30'
              : 'border-border-card hover:border-border-card-hover',
          )}
        >
          <div className='flex items-center justify-between text-muted-foreground'>
            <span className='text-label font-medium'>总操作步骤</span>
            <FileText className='size-4 text-primary' />
          </div>
          <div className='mt-2 flex items-baseline gap-2'>
            <span className='text-title font-semibold tracking-tight text-foreground'>{draft.itemCount}</span>
            <span className='text-label text-muted-foreground'>步</span>
          </div>
          <p className='mt-1 text-label text-muted-foreground truncate'>
            包含 {draft.eventCount} 条原始事件
          </p>
        </button>

        {/* 已就绪 */}
        <button
          type='button'
          onClick={() => onFilterChange(activeFilter === 'mapped' ? 'all' : 'mapped')}
          className={cn(
            'flex flex-col rounded-lg border bg-card p-3.5 text-left shadow-card transition-colors',
            activeFilter === 'mapped'
              ? 'border-status-success-foreground ring-1 ring-status-success-foreground/30'
              : 'border-border-card hover:border-border-card-hover',
          )}
        >
          <div className='flex items-center justify-between text-muted-foreground'>
            <span className='text-label font-medium'>已就绪</span>
            <CheckCircle2 className='size-4 text-status-success-foreground' />
          </div>
          <div className='mt-2 flex items-baseline gap-2'>
            <span className='text-title font-semibold tracking-tight text-foreground'>{mappedCount}</span>
            <span className='text-label text-muted-foreground'>步</span>
          </div>
          <p className='mt-1 text-label text-status-success-foreground truncate'>
            可直接转为确定性步骤
          </p>
        </button>

        {/* 待补参数 / 敏感项 */}
        <button
          type='button'
          onClick={() => onFilterChange(activeFilter === 'parameterized' ? 'all' : 'parameterized')}
          className={cn(
            'flex flex-col rounded-lg border bg-card p-3.5 text-left shadow-card transition-colors',
            activeFilter === 'parameterized'
              ? 'border-status-warning-foreground ring-1 ring-status-warning-foreground/30'
              : 'border-border-card hover:border-border-card-hover',
          )}
        >
          <div className='flex items-center justify-between text-muted-foreground'>
            <span className='text-label font-medium'>待补参数</span>
            {sensitiveCount > 0 ? (
              <KeyRound className='size-4 text-status-warning-foreground' />
            ) : (
              <AlertTriangle className='size-4 text-status-warning-foreground' />
            )}
          </div>
          <div className='mt-2 flex items-baseline gap-2'>
            <span className='text-title font-semibold tracking-tight text-foreground'>{parameterizedCount}</span>
            <span className='text-label text-muted-foreground'>步</span>
          </div>
          <p className='mt-1 text-label text-status-warning-foreground truncate'>
            {sensitiveCount > 0 ? `含 ${sensitiveCount} 项敏感脱敏值` : '需绑定输入变量'}
          </p>
        </button>

        {/* 待处理 */}
        <button
          type='button'
          onClick={() => onFilterChange(activeFilter === 'unresolved' ? 'all' : 'unresolved')}
          className={cn(
            'flex flex-col rounded-lg border bg-card p-3.5 text-left shadow-card transition-colors',
            activeFilter === 'unresolved'
              ? 'border-destructive ring-1 ring-destructive/30'
              : 'border-border-card hover:border-border-card-hover',
          )}
        >
          <div className='flex items-center justify-between text-muted-foreground'>
            <span className='text-label font-medium'>待处理项</span>
            <AlertCircle className='size-4 text-destructive' />
          </div>
          <div className='mt-2 flex items-baseline gap-2'>
            <span className='text-title font-semibold tracking-tight text-foreground'>{draft.unresolvedCount}</span>
            <span className='text-label text-muted-foreground'>项</span>
          </div>
          <p className='mt-1 text-label text-muted-foreground truncate'>
            {draft.unresolvedCount > 0 ? '回填时需替换或舍弃' : '无未决项'}
          </p>
        </button>
      </div>

      {/* 全局诊断信息横幅 */}
      {draft.diagnostics.length > 0 ? (
        <Alert className='border-status-warning-foreground/40 bg-status-warning-background text-status-warning-foreground'>
          <AlertTriangle className='size-4 text-status-warning-foreground' />
          <AlertTitle className='text-body font-medium'>草稿规整诊断提示</AlertTitle>
          <AlertDescription className='mt-1 text-label'>
            <ul className='list-disc space-y-0.5 pl-4'>
              {draft.diagnostics.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
