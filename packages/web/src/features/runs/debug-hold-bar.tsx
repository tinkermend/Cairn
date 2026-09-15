import { useState } from 'react'
import { isAiStepType, type DebugAction, type RunDetailDto, type Step } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { debugRun } from '@/lib/runs-api'
import { useRunObservation } from '@/features/runs/use-run-observation'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

function currentStep(run: RunDetailDto): { step?: Step; status?: string } {
  const stepId = run.checkpoint?.stepId
  const step = run.snapshot.steps.find((item) => item.id === stepId) ?? run.snapshot.steps[0]
  const status = step ? run.stepRuns.find((item) => item.stepId === step.id)?.status : undefined
  return { step, status }
}

function needsSideEffectConfirm(step: Step | undefined): boolean {
  return Boolean(step && (step.effectType === 'SIDE_EFFECT' || isAiStepType(step.type)))
}

function expectActualFrom(output: unknown): { expected: string; actual: string } | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  const record = output as Record<string, unknown>
  if (!('expected' in record) && !('actual' in record)) return null
  return {
    expected: formatObserveValue(record.expected),
    actual: formatObserveValue(record.actual),
  }
}

function formatObserveValue(value: unknown): string {
  if (value === undefined) return '无'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '无法展示'
  }
}

export function StudioHoldBar({ runId }: { runId: string }) {
  const { run, refresh } = useRunObservation(runId, true)
  if (!run) return null
  return <DebugHoldBar run={run} onChanged={refresh} />
}

export function DebugHoldBar({
  run,
  onChanged,
}: {
  run: RunDetailDto
  onChanged?: () => void
}) {
  const debug = run.debugMode !== 'runThrough'
  const holding = run.status === 'HOLDING' && debug
  const running = run.status === 'RUNNING' && debug
  const { step, status } = currentStep(run)
  const failed = status === 'FAILED'
  const succeeded = status === 'SUCCEEDED'
  const [busy, setBusy] = useState(false)
  const [confirmRetry, setConfirmRetry] = useState(false)
  const [confirmPageChange, setConfirmPageChange] = useState(false)
  const latestAttempt = step
    ? run.stepRuns.find((item) => item.stepId === step.id)?.attempts.at(-1)
    : undefined
  const expectActual = expectActualFrom(latestAttempt?.output)

  if (!holding && !running) return null

  const send = (action: DebugAction) => {
    setBusy(true)
    void debugRun(run.id, action)
      .then(() => onChanged?.())
      .catch((error) => {
        if (
          action.action === 'retry_current' &&
          error instanceof ApiRequestError &&
          error.payload.code === 'PAGE_CHANGED_ACK_REQUIRED'
        ) {
          setConfirmPageChange(true)
          return
        }
        toast.error(error instanceof ApiRequestError ? error.message : '调试操作失败')
      })
      .finally(() => setBusy(false))
  }

  const retry = (pageChangedAck?: boolean) => {
    const action: DebugAction = {
      action: 'retry_current',
      fencingToken: run.checkpoint?.fencingToken,
      confirmSideEffect: needsSideEffectConfirm(step) ? true : undefined,
      ...(pageChangedAck ? { pageChangedAck: true } : {}),
    }
    send(action)
  }

  return (
    <div
      aria-label='调试挂起操作'
      className='sticky bottom-0 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-border-card bg-card px-4 py-3 shadow-card'
    >
      {holding && failed ? (
        <>
          <Button
            disabled={busy}
            onClick={() => {
              if (needsSideEffectConfirm(step)) setConfirmRetry(true)
              else retry()
            }}
          >
            再试这一步
          </Button>
          <Button variant='outline' disabled={busy} onClick={() => send({ action: 'stop' })}>
            结束会话
          </Button>
          <p className='text-small text-muted-foreground'>
            后续步骤保持未跑。副作用步骤再试可能对目标系统重复操作。
          </p>
        </>
      ) : null}
      {holding && (expectActual || latestAttempt?.error) ? (
        <div className='w-full space-y-1 text-small'>
          {expectActual ? (
            <>
              <p>期望 {expectActual.expected}</p>
              <p>实际 {expectActual.actual}</p>
            </>
          ) : null}
          {latestAttempt?.error ? (
            <p className='text-status-error-foreground'>
              {latestAttempt.error.code}: {latestAttempt.error.safeMessage}
            </p>
          ) : null}
        </div>
      ) : null}
      {holding && (succeeded || (!failed && run.checkpoint?.reason === 'author_pause')) ? (
        <>
          <Button
            disabled={busy}
            onClick={() =>
              send({
                action: 'continue',
                fencingToken: run.checkpoint?.fencingToken,
              })
            }
          >
            继续下一步
          </Button>
          <Button variant='outline' disabled={busy} onClick={() => send({ action: 'stop' })}>
            结束会话
          </Button>
        </>
      ) : null}
      {running ? (
        <>
          <Button variant='outline' disabled={busy} onClick={() => send({ action: 'pause' })}>
            当前步结束后暂停
          </Button>
          <p className='text-small text-muted-foreground'>已发出的副作用不能撤回。</p>
        </>
      ) : null}

      <AlertDialog open={confirmPageChange} onOpenChange={setConfirmPageChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>页面已变化，仍要再试？</AlertDialogTitle>
            <AlertDialogDescription>
              当前页与检查点不一致。确认后会开新的 Attempt；解析失败不会装成成功。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPageChange(false)
                retry(true)
              }}
            >
              确认再试
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmRetry} onOpenChange={setConfirmRetry}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>再试有副作用的步骤？</AlertDialogTitle>
            <AlertDialogDescription>
              这一步可能对目标系统重复提交或改写数据。确认后才会发起新的 Attempt，历史失败证据会保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmRetry(false)
                retry()
              }}
            >
              确认再试
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
