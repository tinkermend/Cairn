import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import {
  scheduleDtoSchema,
  SCHEDULE_SKIP_REASON_METAS,
  resolveSkipReasonAction,
  type ScheduleDto,
  type ScheduleSkipReason,
} from '@cairn/shared'
import { fetchScheduleEvents, fetchScheduleOccurrences } from '@/lib/schedules-api'
import { Button } from '@/components/ui/button'
import { subscribeObservation } from '@/lib/observation-stream'
import { AnalysisDetailDialog } from './analysis-detail'
import { useCan } from '@/hooks/use-permissions'
import { useAssistantContextBinding } from '@/features/assistant/use-assistant-context-binding'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ADMISSION_LABELS, CONSUMER_LABELS, MODE_LABELS, SKIP_LABELS, lastResult } from './labels'

export function ScheduleDetailDialog({
  schedule: selectedSchedule,
  onOpenChange,
}: {
  schedule: ScheduleDto | null
  onOpenChange: (open: boolean) => void
}) {
  const client = useQueryClient()
  const [latestSchedule, setLatestSchedule] = useState<ScheduleDto | null>(null)
  const schedule = latestSchedule?.scheduleId === selectedSchedule?.scheduleId ? latestSchedule : selectedSchedule
  const [analysisJobId, setAnalysisJobId] = useState<string | null>(null)
  const [streamError, setStreamError] = useState('')
  const [realtime, setRealtime] = useState(true)
  const canAnalyze = useCan('map:analyze')
  const canReadSchedule = useCan('schedule:read')

  useAssistantContextBinding(
    schedule && canReadSchedule
      ? {
          page: 'schedule',
          entityId: schedule.scheduleId,
          summaryText: `调度: ${schedule.name ?? schedule.objectLabel ?? CONSUMER_LABELS[schedule.consumerKey]}`,
          statusLabel: schedule.enabled ? '已启用' : '已停用',
          statusTone: schedule.enabled ? 'success' : 'neutral',
        }
      : null,
  )

  const occurrences = useInfiniteQuery({
    queryKey: ['schedules', schedule?.scheduleId, 'occurrences'],
    queryFn: ({ pageParam }) => fetchScheduleOccurrences(schedule!.scheduleId, { limit: 20, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor,
    enabled: Boolean(schedule),
  })
  const events = useInfiniteQuery({
    queryKey: ['schedules', schedule?.scheduleId, 'events'],
    queryFn: ({ pageParam }) => fetchScheduleEvents(schedule!.scheduleId, { limit: 20, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor,
    enabled: Boolean(schedule),
  })
  const scheduleId = schedule?.scheduleId
  useEffect(() => {
    if (!scheduleId) return
    const controller = new AbortController()
    void subscribeObservation({ path: `/api/schedules/${scheduleId}/observe`, schema: scheduleDtoSchema, event: 'schedule', signal: controller.signal,
      onObservation: setLatestSchedule,
      onRealtime: setRealtime,
      onEvent: () => { void client.invalidateQueries({ queryKey: ['schedules', scheduleId] }) },
      isFinished: () => false,
    }).catch((error: Error) => { if (!controller.signal.aborted) setStreamError(error.message) })
    return () => controller.abort()
  }, [scheduleId, client])

  const recentOccurrences = occurrences.data?.pages[0]?.items ?? []
  const summary = useMemo(() => {
    if (recentOccurrences.length === 0) return null
    let admitted = 0
    let skipped = 0
    let failed = 0
    const skipCounts = new Map<ScheduleSkipReason, number>()

    for (const item of recentOccurrences) {
      if (item.admissionStatus === 'ADMITTED') admitted++
      else if (item.admissionStatus === 'SKIPPED') {
        skipped++
        if (item.reason) {
          skipCounts.set(item.reason, (skipCounts.get(item.reason) ?? 0) + 1)
        }
      } else if (item.admissionStatus === 'FAILED') failed++
    }

    let topSkipReason: ScheduleSkipReason | null = null
    let topSkipCount = 0
    for (const [r, count] of skipCounts.entries()) {
      if (count > topSkipCount) {
        topSkipCount = count
        topSkipReason = r
      }
    }

    return {
      total: recentOccurrences.length,
      admitted,
      skipped,
      failed,
      topSkipReason,
      topSkipCount,
      topSkipRate: skipped > 0 ? Math.round((topSkipCount / skipped) * 100) : 0,
    }
  }, [recentOccurrences])

  if (!schedule) return null
  const consumer = schedule.definition.consumer
  return (
    <><Dialog open onOpenChange={onOpenChange} variant='inspection'>
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{schedule.name ?? schedule.objectLabel ?? CONSUMER_LABELS[schedule.consumerKey]}</DialogTitle>
          <DialogDescription>
            {CONSUMER_LABELS[schedule.consumerKey]} · 修订 {schedule.revision} · {schedule.enabled ? '已启用' : '已停用'}
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-4 text-body'>
          <section className='grid gap-1'>
            <h3 className='text-section font-semibold'>配置</h3>
            <p>对象：{schedule.objectLabel ?? '—'}</p>
            {consumer.type === 'scenario_run' ? <p>场景版本 {consumer.scenarioVersionId}</p> : null}
            {consumer.type === 'suite_run' ? <p>集合版本 {consumer.suiteVersionId} · {consumer.members.length} 个成员</p> : null}
            {consumer.type === 'knowledge_analysis' ? (
              <p>
                {MODE_LABELS[consumer.mode]} · {consumer.budget.useAi ? '使用模型' : '确定性统计'} · 单批 {consumer.budget.maxItems}
              </p>
            ) : null}
            <p>
              {schedule.definition.timeRule.kind === 'interval'
                ? `间隔 ${Math.round(schedule.definition.timeRule.intervalMs / 60000)} 分钟`
                : `${schedule.definition.timezone} ${schedule.definition.timeRule.windows.map(window => `${window.windowStart}–${window.windowEnd}`).join('、')}`}
            </p>
            {schedule.blockReasons?.length ? (
              <p className='text-status-warning-foreground'>
                {schedule.blockReasons
                  .map((reason) => SKIP_LABELS[reason as keyof typeof SKIP_LABELS] ?? reason)
                  .join(' · ')}
              </p>
            ) : null}
          </section>
          <section className='grid gap-2'>
            <h3 className='text-section font-semibold'>触发记录</h3>
            {streamError ? <p role='alert' className='text-destructive'>{streamError}</p> : null}
            {!realtime ? <p role='status' className='text-muted-foreground'>实时通知未启用，当前约每 30 秒同步一次记录。</p> : null}
            {occurrences.isPending ? <p role='status'>正在加载触发记录…</p> : null}
            {occurrences.isError ? <p role='alert'>触发记录读取失败：{occurrences.error.message}</p> : null}
            {occurrences.data?.pages[0].items.length === 0 ? <p className='text-muted-foreground'>尚未触发。</p> : null}
            {summary ? (
              <div
                className='rounded-md border border-border-default/60 bg-muted/40 p-2.5 text-label grid gap-1'
                data-testid='schedule-admission-summary'
              >
                <div className='flex items-center gap-3 font-medium flex-wrap'>
                  <span>最近 {summary.total} 次触发统计：</span>
                  <span className='text-status-success-foreground'>已准入 {summary.admitted} 次</span>
                  <span className='text-status-warning-foreground'>已跳过 {summary.skipped} 次</span>
                  {summary.failed > 0 ? (
                    <span className='text-destructive'>准入失败 {summary.failed} 次</span>
                  ) : null}
                </div>
                {summary.topSkipReason ? (
                  <div className='text-muted-foreground'>
                    主要跳过原因：<span className='font-medium text-foreground'>{SCHEDULE_SKIP_REASON_METAS[summary.topSkipReason]?.label ?? summary.topSkipReason}</span>
                    （占跳过记录的 {summary.topSkipRate}%）
                  </div>
                ) : null}
              </div>
            ) : null}
            <p className='text-label text-muted-foreground'>
              最近结果：{lastResult(schedule.lastOccurrence?.admissionStatus, schedule.lastOccurrence?.reason)}
            </p>
            <ul className='grid gap-2'>
              {(occurrences.data?.pages.flatMap(page => page.items) ?? []).map((item) => {
                const meta = item.reason ? SCHEDULE_SKIP_REASON_METAS[item.reason] : null
                const action = item.reason
                  ? resolveSkipReasonAction(item.reason, {
                      targetId: schedule.targetId,
                      runId: item.runId,
                      scheduleId: schedule.scheduleId,
                    })
                  : null

                return (
                  <li
                    key={item.occurrenceId}
                    className='text-label rounded border border-border-default/40 p-2 grid gap-1 bg-surface-base'
                    data-testid='schedule-occurrence-row'
                  >
                    <div className='flex items-center gap-2 flex-wrap'>
                      <span className='font-medium'>{item.localStartDate}</span>
                      <span>·</span>
                      <span
                        className={
                          item.admissionStatus === 'SKIPPED'
                            ? 'text-status-warning-foreground font-medium'
                            : item.admissionStatus === 'FAILED'
                              ? 'text-destructive font-medium'
                              : 'font-medium'
                        }
                      >
                        {ADMISSION_LABELS[item.admissionStatus]}
                      </span>
                      {item.reason ? <span>· {meta?.label ?? item.reason}</span> : null}
                      {item.runId ? (
                        <Button variant='link' className='h-auto p-0 text-primary' asChild>
                          <a href={`/runs/${item.runId}`}>查看运行</a>
                        </Button>
                      ) : null}
                      {item.suiteRunId ? (
                        <Button variant='link' className='h-auto p-0 text-primary' asChild>
                          <a href={`/suite-runs/${item.suiteRunId}`}>查看集合运行</a>
                        </Button>
                      ) : null}
                      {item.jobId ? (
                        <Button variant='link' className='h-auto p-0 text-primary' asChild>
                          <a href={`/targets/${schedule.targetId}/map`}>查看地图作业</a>
                        </Button>
                      ) : null}
                      {item.analysisJobId && canAnalyze ? (
                        <Button variant='link' className='h-auto p-0 text-primary' onClick={() => setAnalysisJobId(item.analysisJobId ?? null)}>
                          查看分析结果
                        </Button>
                      ) : null}
                      {action ? (
                        <Button variant='outline' size='sm' className='h-6 px-2 text-xs ml-auto text-primary' asChild>
                          <a href={action.href}>{action.label}</a>
                        </Button>
                      ) : null}
                    </div>
                    {item.admissionStatus === 'SKIPPED' && meta?.explanation ? (
                      <p className='text-xs text-muted-foreground leading-normal'>{meta.explanation}</p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            {occurrences.hasNextPage ? <Button variant='outline' disabled={occurrences.isFetchingNextPage} onClick={() => void occurrences.fetchNextPage()}>更多触发记录</Button> : null}
          </section>
          <section className='grid gap-1'>
            <h3 className='text-section font-semibold'>操作历史</h3>
            <ul className='grid gap-1'>
              {(events.data?.pages.flatMap(page => page.items) ?? []).map((item) => (
                <li key={item.eventId} className='text-label text-muted-foreground'>
                  {item.createdAt} · {item.eventType}
                </li>
              ))}
            </ul>
            {events.isError ? <p role='alert'>操作历史读取失败：{events.error.message}</p> : null}
            {events.hasNextPage ? <Button variant='outline' disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>更多操作历史</Button> : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>{analysisJobId ? <AnalysisDetailDialog jobId={analysisJobId} onClose={() => setAnalysisJobId(null)} /> : null}</>
  )
}
