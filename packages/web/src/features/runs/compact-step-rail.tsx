import { useMemo, useState } from 'react'
import { type RunDetailDto, type EvidenceMetadata } from '@cairn/shared'
import { isStepHealed } from './healed-helper'
import {
  CheckCircle2,
  Clock,
  Flame,
  LayoutDashboard,
  MinusCircle,
  Sparkles,
  XCircle,
} from 'lucide-react'

export type CompactStepRailProps = {
  run: RunDetailDto
  evidenceItems: EvidenceMetadata[]
  selectedMode: 'overview' | 'step'
  selectedStepRunId: string | null
  onSelectOverview: () => void
  onSelectStep: (stepRunId: string) => void
}

export function CompactStepRail({
  run,
  evidenceItems,
  selectedMode,
  selectedStepRunId,
  onSelectOverview,
  onSelectStep,
}: CompactStepRailProps) {
  const [filterFailedOnly, setFilterFailedOnly] = useState(false)

  // 计算每步耗时和最大耗时用于微型耗时条
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

  const failedCount = useMemo(() => {
    return run.stepRuns.filter((s) => s.status === 'FAILED').length
  }, [run.stepRuns])

  const visibleSteps = useMemo(() => {
    if (!filterFailedOnly) return run.stepRuns
    return run.stepRuns.filter((s) => s.status === 'FAILED')
  }, [run.stepRuns, filterFailedOnly])

  return (
    <nav
      aria-label='步骤导航与总览导轨'
      className='flex size-full flex-col overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
    >
      {/* 1. 固顶主入口：🎯 运行总览与最终结果 */}
      <div className='p-2 border-b border-border-card bg-surface-header shrink-0'>
        <button
          type='button'
          onClick={onSelectOverview}
          className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-label transition-[background-color,color,box-shadow] motion-reduce:transition-none ${
            selectedMode === 'overview'
              ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
              : 'text-foreground hover:bg-muted font-medium'
          }`}
        >
          <div className='flex items-center gap-2 min-w-0'>
            <LayoutDashboard className='size-4 shrink-0' />
            <span className='truncate'>🎯 运行总览与指标</span>
          </div>
          <span
            className={`font-mono text-3xs px-1.5 py-0.5 rounded-full font-semibold ${
              selectedMode === 'overview'
                ? 'bg-primary-foreground/20 text-primary-foreground'
                : run.status === 'SUCCEEDED'
                  ? 'bg-status-success-background text-status-success-foreground'
                  : run.status === 'FAILED'
                    ? 'bg-status-error-background text-status-error-foreground'
                    : run.status === 'RUNNING'
                      ? 'bg-status-info-background text-status-info-foreground'
                      : 'bg-muted text-muted-foreground'
            }`}
          >
            {run.status}
          </span>
        </button>
      </div>

      {/* 2. 快捷过滤工具条 */}
      <div className='flex items-center justify-between px-3 py-2 border-b border-border-card/60 bg-muted/20 shrink-0 text-caption'>
        <span className='text-muted-foreground font-medium'>
          流水线清单 ({run.stepRuns.length})
        </span>

        <div className='flex items-center gap-1'>
          <button
            type='button'
            onClick={() => setFilterFailedOnly(false)}
            className={`px-1.5 py-0.5 rounded text-3xs transition-colors ${
              !filterFailedOnly
                ? 'bg-primary/15 text-primary font-medium'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            全部
          </button>

          {failedCount > 0 ? (
            <button
              type='button'
              onClick={() => setFilterFailedOnly(true)}
              className={`px-1.5 py-0.5 rounded text-3xs transition-colors flex items-center gap-1 ${
                filterFailedOnly
                  ? 'bg-status-error-background text-status-error-foreground font-semibold'
                  : 'text-status-error-foreground hover:bg-status-error-background/20'
              }`}
            >
              <span>仅看失败</span>
              <span className='font-mono'>({failedCount})</span>
            </button>
          ) : null}
        </div>
      </div>

      {/* 3. 高密度极简单行步骤列表 (36px 级单行) */}
      <div className='flex-1 overflow-y-auto p-1.5 space-y-0.5'>
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
                className={`group flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left transition-[background-color,color,box-shadow] motion-reduce:transition-none ${
                  isSelected
                    ? 'bg-primary/15 text-primary font-semibold ring-1 ring-primary/40'
                    : 'text-foreground hover:bg-muted/60'
                }`}
              >
                {/* 序号与状态 */}
                <div className='flex items-center gap-2 min-w-0 flex-1 mr-2'>
                  <span className='font-mono text-caption text-muted-foreground w-5 shrink-0 text-right'>
                    #{step.ordinal + 1}
                  </span>

                  <span className='shrink-0'>
                    {step.status === 'SUCCEEDED' ? (
                      <CheckCircle2 className='size-3.5 text-status-success' />
                    ) : step.status === 'FAILED' ? (
                      <XCircle className='size-3.5 text-status-error' />
                    ) : step.status === 'RUNNING' ? (
                      <Clock className='size-3.5 text-status-warning animate-spin' />
                    ) : (
                      <MinusCircle className='size-3.5 text-muted-foreground/60' />
                    )}
                  </span>

                  <span
                    className={`truncate text-label ${
                      step.status === 'FAILED' ? 'text-status-error font-semibold' : ''
                    }`}
                    title={step.name}
                  >
                    {step.name}
                  </span>
                  {isStepHealed(step, evidenceItems) && (
                    <span title='AI 自愈救活' className='inline-flex shrink-0'>
                      <Sparkles className='size-3 text-primary' />
                    </span>
                  )}
                </div>

                {/* 耗时与微型柱状图 */}
                <div className='flex items-center gap-2 shrink-0'>
                  {isLongest ? (
                    <span title='耗时相对较长' className='inline-flex shrink-0'>
                      <Flame className='size-3 text-status-warning' />
                    </span>
                  ) : null}

                  <span className='font-mono text-3xs text-muted-foreground w-11 text-right'>
                    {durInfo.formatted}
                  </span>

                  {/* 微型进度条 */}
                  <div className='w-8 h-1 rounded-full bg-muted/60 overflow-hidden shrink-0'>
                    <div
                      className={`h-full rounded-full ${
                        step.status === 'FAILED'
                          ? 'bg-status-error'
                          : barWidthPercent >= 50
                            ? 'bg-status-warning'
                            : 'bg-primary/50'
                      }`}
                      style={{ width: `${Math.max(4, barWidthPercent)}%` }}
                    />
                  </div>
                </div>
              </button>
            )
          })
        )}
      </div>
    </nav>
  )
}
