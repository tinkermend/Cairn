import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { AiTaskEvent } from '@cairn/shared'
import { fetchAttemptAiTasks } from '@/lib/runs-api'
import { useCan } from '@/hooks/use-permissions'

const PHASE_LABELS: Record<AiTaskEvent['phase'], string> = {
  prepared: '已派发',
  completed: '完成',
  failed: '失败',
  interrupted: '被打断',
  unknown: '结果未知',
}

const BINDING_REASON_LABELS: Record<string, string> = {
  NO_COORDINATES_PROVIDED: '无定位坐标',
  NO_ELEMENT_AT_POINT: '坐标处无元素',
  NO_UNIQUE_LOCATOR_PASS: '没有唯一候选',
  SENSITIVE_TARGET: '敏感目标，未采集',
  EVALUATION_FAILED: '点检失败',
}

const LEVEL_LABELS: Record<string, string> = {
  full: '可全部固化',
  partial: '部分可固化',
  blocked: '不可固化',
}

const INTEGRITY_LABELS: Record<string, string> = {
  complete: '完整',
  partial: '部分缺失',
  none: '未采集',
}

export function AiActionTracePanel({ runId, attemptId }: { runId: string; attemptId: string }) {
  const canRead = useCan('run:read')
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: ['runs', runId, 'ai-tasks', attemptId],
    queryFn: () => fetchAttemptAiTasks(runId, attemptId, { limit: 200 }),
    enabled: canRead && open,
    staleTime: 5_000,
  })

  if (!canRead) return null
  const observation = query.data?.observation
  const events = query.data?.events ?? []

  return (
    <div className='rounded-md border border-border-card bg-card'>
      <button
        type='button'
        className='flex w-full items-center gap-2 px-3 py-2 text-left'
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? (
          <ChevronDown className='size-4 shrink-0 text-muted-foreground' />
        ) : (
          <ChevronRight className='size-4 shrink-0 text-muted-foreground' />
        )}
        <span className='text-label font-medium'>AI 动作</span>
        {observation ? (
          <span className='text-label text-muted-foreground'>
            {observation.actionCount} 个动作 · {LEVEL_LABELS[observation.solidifiableLevel] ?? observation.solidifiableLevel}
            {' · '}
            {INTEGRITY_LABELS[observation.traceIntegrity] ?? observation.traceIntegrity}
          </span>
        ) : open && query.isSuccess ? (
          <span className='text-label text-muted-foreground'>未采集</span>
        ) : null}
      </button>
      {open ? (
        <div className='space-y-2 border-t border-border-card px-3 py-2'>
          {query.isPending ? <p className='text-label text-muted-foreground'>读取中…</p> : null}
          {query.isError ? (
            <p className='text-label text-destructive'>读取失败：{query.error.message}</p>
          ) : null}
          {query.isSuccess && events.length === 0 ? (
            <p className='text-label text-muted-foreground'>
              本次尝试没有记录 AI 动作事实（能力未开启，或步骤未派发动作）。
            </p>
          ) : null}
          {events.map((event) => (
            <div key={event.id ?? `${event.ordinal}-${event.phase}`} className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
              <span className='font-mono text-label text-muted-foreground'>#{event.ordinal}</span>
              <span className='text-label font-medium'>{event.actionName}</span>
              <span className='text-label text-muted-foreground'>{PHASE_LABELS[event.phase]}</span>
              {event.elementDescription ? (
                <span className='min-w-0 truncate text-label'>{event.elementDescription}</span>
              ) : null}
              {event.binding.status === 'bound' && event.binding.candidates[0] ? (
                <span className='rounded bg-muted/60 px-1.5 py-0.5 font-mono text-label'>
                  {event.binding.candidates[0].by}: {event.binding.candidates[0].value}
                </span>
              ) : event.binding.status === 'unbound' ? (
                <span className='text-label text-muted-foreground'>
                  {BINDING_REASON_LABELS[event.binding.reason ?? ''] ?? '未绑定'}
                </span>
              ) : null}
              {event.binding.anchor ? (
                <span className='font-mono text-label text-muted-foreground'>
                  行锚点: {event.binding.anchor.withinText}
                </span>
              ) : null}
              {event.valueProvenance.kind === 'literal' ? (
                <span className='font-mono text-label text-muted-foreground'>值: 字面量</span>
              ) : event.valueProvenance.kind !== 'none' ? (
                <span className='font-mono text-label text-muted-foreground'>
                  值来源: {event.valueProvenance.kind}({event.valueProvenance.source})
                </span>
              ) : null}
              {event.writeSignalCount > 0 ? (
                <span className='rounded bg-amber-500/10 px-1.5 py-0.5 text-label text-amber-600 dark:text-amber-400'>
                  写请求 ×{event.writeSignalCount}
                </span>
              ) : null}
              {event.binding.dataDependent ? (
                <span className='rounded bg-amber-500/10 px-1.5 py-0.5 text-label text-amber-600 dark:text-amber-400'>
                  数据相关
                </span>
              ) : null}
            </div>
          ))}
          {query.data?.nextCursor !== undefined ? (
            <p className='text-label text-muted-foreground'>
              动作较多，仅显示前 {events.length} 条；完整轨迹经接口分页读取。
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
