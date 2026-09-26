import { useState } from 'react'
import {
  type EvidenceMetadata,
  type RunDetailDto,
} from '@cairn/shared'
import {
  CheckCircle2,
  Filter,
  Layers,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { StepTimeline } from './step-timeline'

type Props = {
  run: RunDetailDto
  evidenceItems: EvidenceMetadata[]
  selectedStepRunId: string | null
  selectedAttemptId: string | null
  currentPlayingStepRunId: string | null
  focusInvocationId?: string
  focusStepRunId?: string
  focusAttemptId?: string
  focusEvidenceId?: string
  onSelectStep: (stepRunId: string, attemptId?: string) => void
}

export function StepRail({
  run,
  evidenceItems,
  selectedStepRunId,
  selectedAttemptId,
  currentPlayingStepRunId,
  focusInvocationId,
  focusStepRunId,
  focusAttemptId,
  focusEvidenceId,
  onSelectStep,
}: Props) {
  const [filterFailedOnly, setFilterFailedOnly] = useState(false)

  // 统计指标
  const totalSteps = run.stepRuns.length
  const failedCount = run.stepRuns.filter((s) => s.status === 'FAILED').length

  return (
    <nav
      aria-label='执行步骤流水导轨'
      tabIndex={0}
      className='flex h-full flex-col overflow-hidden rounded-lg border border-border-card bg-card shadow-card focus:outline-none focus:ring-1 focus:ring-primary/40'
    >
      {/* 1. 顶部导轨工具带：统计与快速过滤 */}
      <div className='border-b border-border-divider p-3 shrink-0 bg-surface-header'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-1.5'>
            <Layers className='size-4 text-primary' />
            <span className='text-label font-semibold text-foreground'>步骤流水</span>
            <span className='text-caption text-muted-foreground'>({totalSteps})</span>
          </div>

          {/* 快捷失败过滤胶囊 */}
          {failedCount > 0 ? (
            <button
              type='button'
              onClick={() => setFilterFailedOnly((prev) => !prev)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption font-medium transition-colors',
                filterFailedOnly
                  ? 'bg-status-error-background text-status-error-foreground border border-status-error-foreground/30'
                  : 'bg-muted/80 text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <Filter className='size-3' />
              <span>{filterFailedOnly ? '显示全部' : `仅看失败 (${failedCount})`}</span>
            </button>
          ) : (
            <span className='text-caption text-status-success-foreground font-medium flex items-center gap-1'>
              <CheckCircle2 className='size-3' /> 全部成功
            </span>
          )}
        </div>
      </div>

      {/* 2. 步骤时间线独立滚动区 */}
      <div
        role='region'
        aria-label='步骤时间线列表'
        className={cn(
          'flex-1 overflow-y-auto p-3 space-y-2',
          filterFailedOnly && '[&_li[data-step-status]:not([data-step-status="FAILED"])]:hidden'
        )}
      >
        <StepTimeline
          run={run}
          evidenceItems={evidenceItems}
          focusInvocationId={focusInvocationId}
          focusStepRunId={focusStepRunId ?? selectedStepRunId ?? undefined}
          focusAttemptId={focusAttemptId ?? selectedAttemptId ?? undefined}
          focusEvidenceId={focusEvidenceId}
          currentStepRunId={currentPlayingStepRunId ?? selectedStepRunId}
          onSelectStep={onSelectStep}
        />
      </div>

      {/* 底部小提示 */}
      <div className='border-t border-border-divider px-3 py-1.5 text-3xs text-muted-foreground flex justify-between items-center bg-surface-header'>
        <span>独立内部滚动</span>
        <span>共 {totalSteps} 步</span>
      </div>
    </nav>
  )
}
