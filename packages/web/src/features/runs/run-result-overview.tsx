import { useMemo } from 'react'
import {
  type RunDetailDto,
  type EvidenceMetadata,
  type StepRunDto,
} from '@cairn/shared'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Flame,
  MinusCircle,
  Sparkles,
  Target,
  TrendingUp,
  XCircle,
} from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Can } from '@/components/rbac/can'
import { useAssistantStore } from '@/stores/assistant-store'
import { buildStepQuote } from '@/features/assistant/quote-helper'
import { RunOutputCard } from './run-output-card'
import { OutcomeAxisSummary, OutcomeConditionList, RUN_EXECUTION_AXIS_LABELS } from './outcome-axis'
import { translateStepError } from './error-translator'
import { formatDuration } from './labels'

export type StepPerformanceItem = {
  step: StepRunDto
  durationMs: number
  durationFormatted: string
  percentage: number
  isBottleneck: boolean
}

export type RunResultOverviewProps = {
  run: RunDetailDto
  evidenceItems: EvidenceMetadata[]
  onSelectStep: (stepRunId: string) => void
  onFocusEvidence?: (evidenceId: string) => void
}

function elapsedMs(startedAt: string | null | undefined, finishedAt: string | null | undefined): number | null {
  if (!startedAt || !finishedAt) return null
  const duration = Date.parse(finishedAt) - Date.parse(startedAt)
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

function formatElapsedMs(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`
  if (durationMs < 10_000) return `${(durationMs / 1000).toFixed(1)}s`
  return `${Math.round(durationMs / 1000)}s`
}

export function RunResultOverview({
  run,
  evidenceItems,
  onSelectStep,
  onFocusEvidence,
}: RunResultOverviewProps) {
  const openAssistant = useAssistantStore((state) => state.openPanel)
  const setQuote = useAssistantStore((state) => state.setQuote)

  // 1. 提取异常步骤（首个失败步骤）
  const failedStep = useMemo(() => {
    return run.stepRuns.find((s) => s.status === 'FAILED')
  }, [run.stepRuns])

  const failedAttempt = failedStep?.attempts[failedStep.attempts.length - 1]
  const failedDiagnosis = failedAttempt?.error ? translateStepError(failedAttempt.error) : null

  // 2. 计算步骤耗时分析与性能分布
  const { recordedStepDurationMs, performanceItems, topBottlenecks } = useMemo(() => {
    const items = run.stepRuns.filter((step) => step.startedAt || step.attempts.length > 0).map((step) => {
      const lastAtt = step.attempts[step.attempts.length - 1]
      const stepElapsedMs = elapsedMs(step.startedAt, step.finishedAt) ??
        elapsedMs(step.attempts[0]?.startedAt, lastAtt?.finishedAt)
      const ms = stepElapsedMs ?? 0

      return {
        step,
        durationMs: ms,
        durationFormatted: stepElapsedMs !== null ? formatElapsedMs(ms) : step.status === 'RUNNING' ? '进行中' : '时间未记录',
        percentage: 0,
        isBottleneck: false,
      }
    })

    // 计算占比
    const totalMs = items.reduce((sum, item) => sum + item.durationMs, 0)
    const effectiveTotalMs = totalMs > 0 ? totalMs : 1
    items.forEach((item) => {
      item.percentage = Math.round((item.durationMs / effectiveTotalMs) * 100)
    })

    // 找出耗时最长前 3 个步骤作为潜在瓶颈（要求耗时占比大于 15% 且 > 1 秒）
    const sorted = [...items].filter((i) => i.durationMs >= 1000).sort((a, b) => b.durationMs - a.durationMs)
    const bottlenecks = sorted.slice(0, 3)
    bottlenecks.forEach((b) => {
      b.isBottleneck = true
    })

    return {
      recordedStepDurationMs: totalMs,
      performanceItems: items,
      topBottlenecks: bottlenecks,
    }
  }, [run.stepRuns])

  const runElapsedMs = elapsedMs(run.startedAt, run.finishedAt)
  const unassignedMs = runElapsedMs !== null && runElapsedMs >= recordedStepDurationMs
    ? runElapsedMs - recordedStepDurationMs
    : null

  // 3. 提取全局上下文变量 (run.context 中的键值)
  const contextEntries = useMemo(() => {
    if (!run.context || typeof run.context !== 'object') return []
    return Object.entries(run.context).filter(([k]) => !k.startsWith('_') && !k.startsWith('$'))
  }, [run.context])

  const hasAssertions = Boolean(
    run.snapshot.outcomeManifest?.entries.length ||
    run.snapshot.runtimeInvariantManifest?.entries.length
  )

  return (
    <div className='flex flex-1 flex-col overflow-y-auto p-4 space-y-4'>
      {/* A. 异常直接归因卡片 (若有失败步骤) */}
      {failedStep && failedAttempt?.error ? (
        <section className='rounded-lg border border-status-error-foreground/30 bg-status-error-background/15 p-4 shadow-xs space-y-3'>
          <div className='flex flex-wrap items-start justify-between gap-3'>
            <div className='flex items-start gap-2.5 min-w-0'>
              <AlertTriangle className='size-5 text-status-error-foreground shrink-0 mt-0.5' />
              <div>
                <div className='flex items-center gap-2'>
                  <span className='font-mono font-bold text-status-error-foreground text-caption bg-status-error-background px-1.5 py-0.5 rounded'>
                    #{failedStep.ordinal + 1}
                  </span>
                  <h3 className='text-body font-semibold text-status-error-foreground truncate'>
                    运行于步骤「{failedStep.name}」中断失败
                  </h3>
                </div>
                <p className='mt-1 text-label text-foreground font-medium'>
                  {failedDiagnosis?.title || failedAttempt.error.code}: {failedDiagnosis?.description || failedAttempt.error.safeMessage}
                </p>
                {failedDiagnosis?.suggestion ? (
                  <p className='mt-1 text-caption text-muted-foreground'>
                    💡 排查建议：{failedDiagnosis.suggestion}
                  </p>
                ) : null}
              </div>
            </div>

            <div className='flex items-center gap-2 shrink-0'>
              <Can allOf={['ai:assist']}>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='h-7.5 text-label border-status-error-foreground/30 hover:bg-status-error-background/30 gap-1'
                  onClick={() => {
                    const err = `${failedAttempt.error?.code}: ${failedAttempt.error?.safeMessage}`
                    setQuote(buildStepQuote(failedStep, err))
                    openAssistant({
                      question: `分析本次运行失败原因：第 ${failedStep.ordinal + 1} 步 [${failedStep.name}] 报错 ${failedAttempt.error?.code}，如何解决？`,
                      capabilityHint: 'run.diagnose',
                      pageContext: { page: 'run', runId: run.id },
                    })
                  }}
                >
                  <Sparkles className='size-3.5 text-primary' />
                  <span>智能诊断</span>
                </Button>
              </Can>

              <Button
                type='button'
                size='sm'
                className='h-7.5 text-label gap-1'
                onClick={() => onSelectStep(failedStep.id)}
              >
                <span>查看失败现场</span>
                <ArrowRight className='size-3.5' />
              </Button>
            </div>
          </div>
        </section>
      ) : null}

      {/* B. 业务最终判定与成功条件 (Outcome & Assertions) */}
      <section className='rounded-lg border border-border-card bg-card p-4 shadow-card space-y-3'>
        <div className='flex items-center justify-between border-b border-border-card/60 pb-2.5'>
          <div className='flex items-center gap-2'>
            <Target className='size-4 text-primary' />
            <h2 className='text-body font-semibold text-foreground'>业务判定与成功条件</h2>
          </div>
          <span className='text-caption text-muted-foreground'>
            {hasAssertions ? '已配置断言规则' : '无显式断言规则'}
          </span>
        </div>

        {/* 双轴判定摘要 */}
        <OutcomeAxisSummary
          executionLabel={RUN_EXECUTION_AXIS_LABELS[run.status]}
          outcomeStatus={run.outcomeStatus}
          hasContracts={Boolean(run.snapshot.outcomeManifest?.entries.length)}
        />

        {/* 详细断言列表 */}
        {hasAssertions ? (
          <div className='pt-1'>
            <OutcomeConditionList
              runId={run.id}
              run={run}
              evidenceItems={evidenceItems}
              onFocusEvidence={onFocusEvidence}
            />
          </div>
        ) : (
          <p className='text-label text-muted-foreground pt-1'>
            本次运行未配置成功条件或运行期不变式规则；步骤执行结果可单独查看，业务结果未评价。
          </p>
        )}
      </section>

      {/* C. 业务产出与提取指标 (Outputs & Context Variables) */}
      {run.output ? (
        <RunOutputCard
          output={run.output}
          runStatus={run.status}
          outcomeStatus={run.outcomeStatus}
          onFocusEvidence={onFocusEvidence}
          onFocusStep={(stepOrdinal) => {
            const step = run.stepRuns.find((s) => s.ordinal === stepOrdinal)
            if (step) onSelectStep(step.id)
          }}
        />
      ) : contextEntries.length > 0 ? (
        <section className='rounded-lg border border-border-card bg-card p-4 shadow-card space-y-3'>
          <div className='flex items-center justify-between border-b border-border-card/60 pb-2.5'>
            <div className='flex items-center gap-2'>
              <TrendingUp className='size-4 text-primary' />
              <h2 className='text-body font-semibold text-foreground'>关键提取变量与产出数据</h2>
            </div>
            <span className='text-caption text-muted-foreground font-mono'>
              {contextEntries.length} 项变量
            </span>
          </div>

          <div className='grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5'>
            {contextEntries.map(([key, val]) => (
              <div
                key={key}
                className='flex flex-col justify-between rounded-md border border-border-card bg-muted/20 p-2.5 text-label'
              >
                <span className='font-mono font-medium text-muted-foreground text-caption truncate'>
                  {key}
                </span>
                <span className='font-mono font-semibold text-foreground text-body mt-1 truncate' title={String(val)}>
                  {typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val)}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className='rounded-lg border border-border-card bg-card p-4 shadow-card'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-2 text-muted-foreground text-label'>
              <TrendingUp className='size-4' />
              <span>本场景未配置数据提取或业务指标回传。</span>
            </div>
            <StatusBadge tone='neutral'>无产出指标</StatusBadge>
          </div>
        </section>
      )}

      {/* D. 执行性能与耗时分布 (Performance Waterfall & Bottlenecks) */}
      <section className='rounded-lg border border-border-card bg-card p-4 shadow-card space-y-3.5'>
        <div className='flex flex-wrap items-center justify-between gap-2 border-b border-border-card/60 pb-2.5'>
          <div className='flex items-center gap-2'>
            <Clock className='size-4 text-primary' />
            <h2 className='text-body font-semibold text-foreground'>耗时分布与性能透视</h2>
          </div>
          <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground'>
            {runElapsedMs !== null ? (
              <span>运行历时: <strong className='text-foreground font-mono'>{formatDuration(run.startedAt, run.finishedAt)}</strong></span>
            ) : null}
            <span>已记录步骤耗时总和: <strong className='text-foreground font-mono'>{formatElapsedMs(recordedStepDurationMs)}</strong></span>
            <span>已执行步骤: <strong className='text-foreground font-mono'>{performanceItems.length}</strong> / 编排步骤: <strong className='text-foreground font-mono'>{run.stepRuns.length}</strong></span>
          </div>
        </div>

        {unassignedMs !== null ? (
          <p className='text-label text-muted-foreground'>
            未归于步骤的耗时：<strong className='font-mono text-foreground'>{formatElapsedMs(unassignedMs)}</strong>（可能包含等待、恢复或收尾时间）
          </p>
        ) : runElapsedMs !== null ? (
          <p className='text-label text-muted-foreground'>步骤时间存在重叠，无法直接计算未归于步骤的耗时。</p>
        ) : null}

        {/* 耗时瓶颈 TOP 步骤提示 */}
        {topBottlenecks.length > 0 ? (
          <div className='rounded-md border border-status-warning-foreground/30 bg-status-warning-background/15 p-3 space-y-2'>
            <div className='flex items-center gap-1.5 text-label font-medium text-status-warning-foreground'>
              <Flame className='size-4' />
              <span>耗时最长的步骤（按已记录步骤耗时）：</span>
            </div>
            <div className='grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2'>
              {topBottlenecks.map(({ step, durationFormatted, percentage }) => (
                <button
                  key={step.id}
                  type='button'
                  onClick={() => onSelectStep(step.id)}
                  className='flex items-center justify-between rounded bg-card/80 border border-border-card p-2 text-left hover:border-primary transition-colors text-label'
                >
                  <div className='min-w-0 pr-2'>
                    <div className='font-medium text-foreground truncate'>
                      #{step.ordinal + 1} {step.name}
                    </div>
                    <div className='text-caption text-muted-foreground'>
                      占已记录步骤耗时 {percentage}%
                    </div>
                  </div>
                  <span className='font-mono font-bold text-status-warning-foreground shrink-0'>
                    {durationFormatted}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* 步骤耗时瀑布清单 (Waterfall Bar List) */}
        <div className='space-y-1.5 pt-1'>
          <p className='text-caption font-medium text-muted-foreground mb-1'>已执行步骤耗时横向对比（百分比以已记录步骤耗时总和为分母；点击条目直达步骤现场）：</p>
          {performanceItems.length === 0 ? (
            <p className='text-label text-muted-foreground'>暂无已执行步骤耗时记录。</p>
          ) : null}
          {performanceItems.map(({ step, durationFormatted, percentage }) => (
            <div
              key={step.id}
              onClick={() => onSelectStep(step.id)}
              className='group flex items-center justify-between rounded-md p-1.5 hover:bg-muted/40 cursor-pointer transition-colors text-label'
            >
              <div className='flex items-center gap-2 min-w-0 w-44 md:w-56 shrink-0'>
                <span className='font-mono text-caption text-muted-foreground w-6 text-right'>
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
                    <MinusCircle className='size-3.5 text-muted-foreground' />
                  )}
                </span>
                <span className='font-medium text-foreground truncate group-hover:text-primary transition-colors' title={step.name}>
                  {step.name}
                </span>
              </div>

              {/* 耗时可视化条 */}
              <div className='flex-1 mx-3 flex items-center gap-2 min-w-0'>
                <div className='h-2 flex-1 rounded-full bg-muted/50 overflow-hidden'>
                  <div
                    className={`h-full rounded-full transition-[width] motion-reduce:transition-none ${
                      step.status === 'FAILED'
                        ? 'bg-status-error'
                        : percentage >= 30
                          ? 'bg-status-warning'
                          : 'bg-primary/70'
                    }`}
                    style={{ width: `${percentage > 0 ? Math.max(2, percentage) : 0}%` }}
                  />
                </div>
              </div>

              <div className='flex items-center gap-2 shrink-0 text-right w-20 justify-end'>
                <span className='font-mono font-medium text-foreground text-caption'>
                  {durationFormatted}
                </span>
                <span className='font-mono text-muted-foreground text-3xs w-8 text-right'>
                  {percentage}%
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
