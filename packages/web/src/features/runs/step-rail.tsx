import { useMemo, useState } from 'react'
import {
  type EvidenceMetadata,
  type RunDetailDto,
} from '@cairn/shared'
import {
  CheckCircle2,
  Clock,
  Filter,
  Flame,
  LayoutDashboard,
  MinusCircle,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { StepTimeline } from './step-timeline'

type Props = {
  run: RunDetailDto
  evidenceItems: EvidenceMetadata[]
  selectedMode: 'overview' | 'step' | 'video'
  selectedStepRunId: string | null
  selectedAttemptId: string | null
  currentPlayingStepRunId: string | null
  focusInvocationId?: string
  focusStepRunId?: string
  focusAttemptId?: string
  focusEvidenceId?: string
  onSelectOverview: () => void
  onSelectStep: (stepRunId: string, attemptId?: string) => void
}

export function StepRail({
  run,
  evidenceItems,
  selectedMode,
  selectedStepRunId,
  selectedAttemptId,
  currentPlayingStepRunId,
  focusInvocationId,
  focusStepRunId,
  focusAttemptId,
  focusEvidenceId,
  onSelectOverview,
  onSelectStep,
}: Props) {
  const hasModuleManifest = Boolean(run.snapshot?.moduleManifest?.entries?.length)
  // 如果有动作模块快照，默认详细以呈现分组；否则默认极简高密度
  const [railMode, setRailMode] = useState<'compact' | 'timeline'>(
    hasModuleManifest ? 'timeline' : 'compact'
  )
  const [filterFailedOnly, setFilterFailedOnly] = useState(false)

  // 统计指标
  const totalSteps = run.stepRuns.length
  const failedCount = run.stepRuns.filter((s) => s.status === 'FAILED').length

  // 计算每步耗时和最大耗时用于极简导轨的微型进度条
  const { stepDurations, maxDurationMs } = useMemo(() => {
    let max = 0
    const map = new Map<string, { ms: number; formatted: string }>()

    run.stepRuns.forEach((step) => {
      let ms = 0
      const lastAtt = step.attempts[step.attempts.length - 1]
      if (lastAtt && lastAtt.startedAt && lastAtt.finishedAt) {
        ms = Math.max(0, Date.parse(lastAtt.finishedAt) - Date.parse(lastAtt.startedAt))
      } else if (step.startedAt && step.finishedAt) {
        ms = Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt))
      }
      if (ms > max) max = ms
      const formatted = ms > 0 ? (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`) : '0s'
      map.set(step.id, { ms, formatted })
    })

    return { stepDurations: map, maxDurationMs: max > 0 ? max : 1 }
  }, [run.stepRuns])

  const visibleSteps = useMemo(() => {
    if (!filterFailedOnly) return run.stepRuns
    return run.stepRuns.filter((s) => s.status === 'FAILED')
  }, [run.stepRuns, filterFailedOnly])

  return (
    <nav
      aria-label='执行步骤流水导轨'
      tabIndex={0}
      className='flex h-full flex-col overflow-hidden rounded-lg border border-border-card bg-card shadow-card focus:outline-none focus:ring-1 focus:ring-primary/40'
    >
      {/* 0. 固顶主入口：🎯 运行总览与最终结果 */}
      <div className='p-2 border-b border-border-divider bg-surface-header shrink-0'>
        <button
          type='button'
          onClick={onSelectOverview}
          className={cn(
            'flex w-full items-center justify-between rounded-md px-3 py-2 text-label transition-all',
            selectedMode === 'overview'
              ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
              : 'text-foreground hover:bg-muted font-medium'
          )}
        >
          <div className='flex items-center gap-2 min-w-0'>
            <LayoutDashboard className='size-4 shrink-0' />
            <span className='truncate'>🎯 运行总览与最终结果</span>
          </div>
          <span
            className={cn(
              'font-mono text-3xs px-1.5 py-0.5 rounded-full',
              selectedMode === 'overview'
                ? 'bg-primary-foreground/20 text-primary-foreground'
                : 'bg-muted text-muted-foreground'
            )}
          >
            {run.status}
          </span>
        </button>
      </div>

      {/* 1. 顶部导轨工具带：统计、模式切换与快速过滤 */}
      <div className='border-b border-border-divider px-3 py-2 shrink-0 bg-muted/20'>
        <div className='flex items-center justify-between gap-1'>
          <span className='text-caption text-muted-foreground font-medium'>
            流水清单 ({totalSteps})
          </span>

          <div className='flex items-center gap-1.5'>
            {/* 模式切换：极简 / 详细 */}
            <div className='flex items-center bg-muted/80 rounded p-0.5 text-3xs'>
              <button
                type='button'
                onClick={() => setRailMode('compact')}
                className={cn(
                  'px-1.5 py-0.5 rounded transition-colors',
                  railMode === 'compact'
                    ? 'bg-card text-foreground font-semibold shadow-2xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                title='极简高密度视图（一屏尽览）'
              >
                极简
              </button>
              <button
                type='button'
                onClick={() => setRailMode('timeline')}
                className={cn(
                  'px-1.5 py-0.5 rounded transition-colors',
                  railMode === 'timeline'
                    ? 'bg-card text-foreground font-semibold shadow-2xs'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                title='详细时间线视图'
              >
                详细
              </button>
            </div>

            {/* 快捷失败过滤胶囊 */}
            {failedCount > 0 ? (
              <button
                type='button'
                onClick={() => setFilterFailedOnly((prev) => !prev)}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs font-medium transition-colors',
                  filterFailedOnly
                    ? 'bg-status-error-background text-status-error-foreground border border-status-error-foreground/30 font-semibold'
                    : 'bg-muted text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <Filter className='size-2.5' />
                <span>{filterFailedOnly ? '全量' : `失败 (${failedCount})`}</span>
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* 2A. 极简单行高密度导轨 (Compact Mode - 默认) */}
      <div className={cn('flex-1 overflow-y-auto p-1.5 space-y-0.5', railMode !== 'compact' && 'hidden')}>
        {visibleSteps.length === 0 ? (
          <div className='py-8 text-center text-label text-muted-foreground'>
            无匹配步骤
          </div>
        ) : (
          visibleSteps.map((step) => {
            const isSelected = selectedMode === 'step' && selectedStepRunId === step.id
            const durInfo = stepDurations.get(step.id) ?? { ms: 0, formatted: '0s' }
            const barWidthPercent = Math.round((durInfo.ms / maxDurationMs) * 100)
            const isLongest = durInfo.ms >= 2000 && barWidthPercent >= 40

            return (
              <button
                key={step.id}
                type='button'
                onClick={() => onSelectStep(step.id)}
                className={cn(
                  'group flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left transition-all',
                  isSelected
                    ? 'bg-primary/15 text-primary font-semibold ring-1 ring-primary/40'
                    : 'text-foreground hover:bg-muted/60'
                )}
              >
                {/* 序号与状态 */}
                <div className='flex items-center gap-2 min-w-0 flex-1 mr-2'>
                  <span className='font-mono text-caption text-muted-foreground w-5 shrink-0 text-right'>
                    #{step.ordinal + 1}
                  </span>

                  <span className='shrink-0'>
                    {step.status === 'SUCCEEDED' ? (
                      <CheckCircle2 className='size-3.5 text-status-success-foreground' />
                    ) : step.status === 'FAILED' ? (
                      <XCircle className='size-3.5 text-status-error-foreground' />
                    ) : step.status === 'RUNNING' ? (
                      <Clock className='size-3.5 text-status-warning-foreground animate-spin' />
                    ) : (
                      <MinusCircle className='size-3.5 text-muted-foreground/60' />
                    )}
                  </span>

                  <span
                    className={cn(
                      'truncate text-label',
                      step.status === 'FAILED' && 'text-status-error-foreground font-semibold'
                    )}
                    title={step.name}
                  >
                    {step.name}
                  </span>
                </div>

                {/* 耗时与微型柱状图 */}
                <div className='flex items-center gap-2 shrink-0'>
                  {isLongest ? (
                    <span title='耗时相对较长' className='inline-flex shrink-0'>
                      <Flame className='size-3 text-status-warning-foreground' />
                    </span>
                  ) : null}

                  <span className='font-mono text-3xs text-muted-foreground w-11 text-right'>
                    {durInfo.formatted}
                  </span>

                  {/* 微型进度条 */}
                  <div className='w-8 h-1 rounded-full bg-muted/60 overflow-hidden shrink-0'>
                    <div
                      className={cn(
                        'h-full rounded-full',
                        step.status === 'FAILED'
                          ? 'bg-status-error-foreground'
                          : barWidthPercent >= 50
                            ? 'bg-status-warning-foreground'
                            : 'bg-primary/50'
                      )}
                      style={{ width: `${Math.max(4, barWidthPercent)}%` }}
                    />
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>

      {/* 2B. 完整时间线视图 (Timeline Mode - 保留 DOM 挂载以兼容模块分组与单测) */}
      <div
        role='region'
        aria-label='步骤时间线列表'
        className={cn(
          'flex-1 overflow-y-auto p-3 space-y-2',
          railMode !== 'timeline' && 'hidden',
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
    </nav>
  )
}
