import { useEffect, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { scheduleDtoSchema, type ScheduleDto } from '@cairn/shared'
import { fetchScheduleEvents, fetchScheduleOccurrences } from '@/lib/schedules-api'
import { Button } from '@/components/ui/button'
import { subscribeObservation } from '@/lib/observation-stream'
import { AnalysisDetailDialog } from './analysis-detail'
import { useCan } from '@/hooks/use-permissions'
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
  if (!schedule) return null
  const consumer = schedule.definition.consumer
  return (
    <><Dialog open onOpenChange={onOpenChange}>
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
          <section className='grid gap-1'>
            <h3 className='text-section font-semibold'>触发记录</h3>
            {streamError ? <p role='alert' className='text-destructive'>{streamError}</p> : null}
            {!realtime ? <p role='status' className='text-muted-foreground'>实时通知未启用，当前约每 30 秒同步一次记录。</p> : null}
            {occurrences.isPending ? <p role='status'>正在加载触发记录…</p> : null}
            {occurrences.isError ? <p role='alert'>触发记录读取失败：{occurrences.error.message}</p> : null}
            {occurrences.data?.pages[0].items.length === 0 ? <p className='text-muted-foreground'>尚未触发。</p> : null}
            <p className='text-label text-muted-foreground'>
              最近结果：{lastResult(schedule.lastOccurrence?.admissionStatus, schedule.lastOccurrence?.reason)}
            </p>
            <ul className='grid gap-1'>
              {(occurrences.data?.pages.flatMap(page => page.items) ?? []).map((item) => (
                <li key={item.occurrenceId} className='text-label'>
                  {item.localStartDate} · {ADMISSION_LABELS[item.admissionStatus]}
                  {item.reason ? ` · ${SKIP_LABELS[item.reason]}` : ''}
                  {item.runId ? (
                    <Button variant='link' className='h-auto p-0' asChild>
                      <a href={`/runs/${item.runId}`}>查看运行</a>
                    </Button>
                  ) : null}
                  {item.suiteRunId ? (
                    <Button variant='link' className='h-auto p-0' asChild>
                      <a href={`/suite-runs/${item.suiteRunId}`}>查看集合运行</a>
                    </Button>
                  ) : null}
                  {item.jobId ? (
                    <Button variant='link' className='h-auto p-0' asChild>
                      <a href={`/targets/${schedule.targetId}/map`}>查看地图作业</a>
                    </Button>
                  ) : null}
                  {item.analysisJobId && canAnalyze ? <Button variant='link' className='h-auto p-0' onClick={() => setAnalysisJobId(item.analysisJobId ?? null)}>查看分析结果</Button> : null}
                </li>
              ))}
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
