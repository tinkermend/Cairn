import { useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { hasPermission } from '@cairn/shared'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Square,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useRunObservation } from '@/features/runs/use-run-observation'
import { cancelRun } from '@/lib/runs-api'
import { useAssistantStore } from '@/stores/assistant-store'
import { useAuthStore } from '@/stores/auth-store'
import { RUN_STATUS_LABELS, STEP_RUN_STATUS_LABELS } from '@/features/scenarios/labels'

function ActiveMiniRunTracker({ runId }: { runId: string }) {
  const setTrackedRunId = useAssistantStore((state) => state.setTrackedRunId)
  const user = useAuthStore((state) => state.auth.user)
  const navigate = useNavigate()
  const [cancelling, setCancelling] = useState(false)

  const { run } = useRunObservation(runId, true)

  const canCancel = hasPermission(user?.permissions ?? [], 'run:cancel')
  const isTerminated =
    run?.status === 'SUCCEEDED' ||
    run?.status === 'FAILED' ||
    run?.status === 'CANCELLED'

  const handleCancel = async () => {
    setCancelling(true)
    try {
      await cancelRun(runId)
      toast.success('已发送中止指令')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '中止失败')
    } finally {
      setCancelling(false)
    }
  }

  const handleNavigate = () => {
    void navigate({ to: '/runs/$runId', params: { runId } })
  }

  return (
    <aside
      role='region'
      aria-label='微型运行控制台'
      data-testid='mini-run-tracker'
      className='shrink-0 border-t border-border-default bg-surface-subtle p-3 space-y-2'
    >
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-2 min-w-0'>
          <span
            className={`size-2 rounded-full shrink-0 ${
              run?.status === 'SUCCEEDED'
                ? 'bg-status-success-foreground'
                : run?.status === 'FAILED'
                  ? 'bg-status-error-foreground'
                  : run?.status === 'CANCELLED'
                    ? 'bg-status-neutral-foreground'
                    : 'bg-primary-600 animate-pulse'
            }`}
            aria-hidden='true'
          />
          <span className='text-label font-medium text-text-primary truncate'>
            运行监控 · {runId.slice(0, 8)}…
          </span>
          {run?.status ? (
            <span className='text-small text-text-muted'>
              （{RUN_STATUS_LABELS[run.status as keyof typeof RUN_STATUS_LABELS] ?? '状态待确认'}）
            </span>
          ) : null}
        </div>
        <Button
          type='button'
          variant='ghost'
          size='icon'
          className='size-6 text-text-muted hover:text-text-primary'
          aria-label='关闭运行监控坞'
          onClick={() => setTrackedRunId(null)}
        >
          <X className='size-3.5' aria-hidden='true' />
        </Button>
      </div>

      {run?.stepRuns && run.stepRuns.length > 0 ? (
        <div className='space-y-1 max-h-32 overflow-y-auto overscroll-contain pr-1 text-small font-sans'>
          {run.stepRuns.map((step, idx) => {
            const isCurrent = step.status === 'RUNNING'
            const isDone = step.status === 'SUCCEEDED'
            const isFail = step.status === 'FAILED'
            return (
              <div
                key={step.id}
                className='flex items-center justify-between gap-2 rounded px-2 py-1 bg-surface-card border border-border-divider'
              >
                <div className='flex items-center gap-1.5 min-w-0'>
                  {isDone ? (
                    <CheckCircle2
                      className='size-3 text-status-success-foreground shrink-0'
                      aria-hidden='true'
                    />
                  ) : isFail ? (
                    <AlertCircle
                      className='size-3 text-status-error-foreground shrink-0'
                      aria-hidden='true'
                    />
                  ) : isCurrent ? (
                    <Loader2
                      className='size-3 text-primary-600 animate-spin shrink-0'
                      aria-hidden='true'
                    />
                  ) : (
                    <span className='size-3 text-text-muted text-center leading-none text-small'>
                      {idx + 1}
                    </span>
                  )}
                  <span className='truncate text-text-secondary'>
                    {step.name}
                  </span>
                  <span className='shrink-0 text-label text-text-muted'>
                    {STEP_RUN_STATUS_LABELS[step.status as keyof typeof STEP_RUN_STATUS_LABELS] ?? '待确认'}
                  </span>
                </div>
                {step.startedAt && step.finishedAt ? (
                  <span className='text-text-muted shrink-0 text-small'>
                    {(
                      (Date.parse(step.finishedAt) - Date.parse(step.startedAt)) /
                      1000
                    ).toFixed(1)}
                    s
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <p className='text-small text-text-muted'>正在等待执行进展事件…</p>
      )}

      <div className='flex items-center justify-between gap-2 pt-1 border-t border-border-divider'>
        {!isTerminated && canCancel ? (
          <Button
            type='button'
            variant='destructive'
            size='sm'
            loading={cancelling}
            className='h-7 gap-1 px-2.5 text-label'
            onClick={handleCancel}
          >
            <Square className='size-3 fill-current' aria-hidden='true' />
            中止运行
          </Button>
        ) : (
          <div />
        )}
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-7 gap-1 px-2 text-label text-text-muted hover:text-text-primary'
          onClick={handleNavigate}
        >
          前往完整复盘页
          <ExternalLink className='size-3' aria-hidden='true' />
        </Button>
      </div>
    </aside>
  )
}

export function MiniRunTracker() {
  const trackedRunId = useAssistantStore((state) => state.trackedRunId)
  const routerState = useRouterState()

  // 避免在完整复盘页重复展示时间轴
  const pathname = routerState.location.pathname
  const isOnRunPage =
    Boolean(trackedRunId) && pathname.startsWith(`/runs/${trackedRunId}`)

  if (!trackedRunId || isOnRunPage) return null

  return <ActiveMiniRunTracker runId={trackedRunId} />
}
