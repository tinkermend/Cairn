import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Crosshair,
  Play,
  RefreshCw,
  Square,
} from 'lucide-react'
import {
  isAiStepType,
  stepRunFor,
  type DebugAction,
  type RunDetailDto,
  type Step,
  type TargetDescriptor,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { debugRun } from '@/lib/runs-api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { StatusBadge } from '@/components/status-badge'
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
import { useAuthoringObserve } from '../observe'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

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

function targetCandidateSummary(target?: TargetDescriptor): string {
  if (!target) return '未指定'
  if (target.semantic) return target.semantic
  const first = target.candidates[0]
  if (!first) return '空目标'
  if (first.by === 'role') return `角色 ${first.value} "${first.name ?? ''}"`
  if (first.by === 'label') return `标签 "${first.value}"`
  if (first.by === 'text') return `文本 "${first.value}"`
  if (first.by === 'testId') return `测试ID "${first.value}"`
  return `${first.by}: ${first.value}`
}

function holdingFailureSummary(error?: { code?: string; safeMessage?: string }): string {
  if (error?.code === 'TARGET_NOT_FOUND' || error?.code === 'ELEMENT_NOT_FOUND') {
    return '这一页上找不到要点的对象'
  }
  return error?.safeMessage || '目标元素未找到或操作失败'
}

export function HealingCard({
  run,
  currentStep,
  retryTarget,
  onBeforeRetry,
  onChanged,
  onSaveToDraft,
}: {
  run: RunDetailDto
  currentStep?: Step
  retryTarget?: TargetDescriptor
  onBeforeRetry?: () => Promise<unknown>
  onChanged?: () => void
  onSaveToDraft?: (target: TargetDescriptor) => void
}) {
  const observe = useAuthoringObserve()
  const debug = run.debugMode !== 'runThrough'
  const holding = run.status === 'HOLDING' && debug
  const running = run.status === 'RUNNING' && debug

  const checkpointStep = run.checkpoint?.stepId
    ? run.snapshot.steps.find((item) => item.id === run.checkpoint!.stepId)
    : undefined
  const stepUnresolved = holding && !checkpointStep
  const step = checkpointStep
  const stepRun = step ? stepRunFor(run.stepRuns, step.id) : undefined
  const status = stepRun?.status
  const failed = status === 'FAILED'
  const succeeded = status === 'SUCCEEDED'
  const pausedBeforeStep = holding && run.checkpoint?.reason === 'author_pause' && !succeeded && !failed

  const [busy, setBusy] = useState(false)
  const [confirmSideEffect, setConfirmSideEffect] = useState(false)
  const [confirmPageChange, setConfirmPageChange] = useState(false)
  const [saveToDraft, setSaveToDraft] = useState(true)

  const latestAttempt = stepRun?.attempts.slice(-1)[0]
  const expectActual = expectActualFrom(latestAttempt?.output)
  const isSideEffect = Boolean(step && (step.effectType === 'SIDE_EFFECT' || isAiStepType(step.type)))

  const newlyPicked = observe.lastPicked || observe.highlight?.target

  if (!holding && !running) return null

  const send = (action: DebugAction) => {
    setBusy(true)
    const proceed = async () => {
      if (action.action === 'retry_current' && onBeforeRetry) {
        const res = await onBeforeRetry()
        if (res === false || res === null) return
      }
      const finalAction: DebugAction = {
        ...action,
        ...(action.action === 'retry_current' && currentStep?.id === checkpointStep?.id ? { stepOverride: currentStep } : {}),
      }
      return debugRun(run.id, finalAction).then(() => {
        onChanged?.()
        if (action.action === 'retry_current' && newlyPicked && saveToDraft) {
          onSaveToDraft?.(newlyPicked)
        }
      })
    }

    void proceed()
      .catch((error) => {
        if (
          action.action === 'retry_current' &&
          error instanceof ApiRequestError &&
          error.payload?.code === 'PAGE_CHANGED_ACK_REQUIRED'
        ) {
          setConfirmPageChange(true)
          return
        }
        toast.error(error instanceof ApiRequestError ? error.message : '调试操作失败')
      })
      .finally(() => setBusy(false))
  }

  const handleRetryWithTarget = (targetOverride?: TargetDescriptor, pageChangedAck?: boolean) => {
    const action: DebugAction = {
      action: 'retry_current',
      fencingToken: run.checkpoint?.fencingToken,
      targetOverride: targetOverride ?? retryTarget,
      confirmSideEffect: isSideEffect ? true : undefined,
      ...(pageChangedAck ? { pageChangedAck: true } : {}),
    }
    send(action)
  }

  return (
    <div
      aria-label='就地修复与调试挂起'
      className='space-y-3 rounded-lg border border-border-card bg-card p-4 shadow-card'
    >
      {holding && stepUnresolved ? (
        <div className='space-y-2'>
          <div className='flex items-start gap-2'>
            <AlertTriangle className='mt-0.5 size-4 shrink-0 text-status-warning-foreground' />
            <div className='min-w-0 flex-1'>
              <h4 className='text-body font-semibold text-status-warning-foreground'>
                挂起的步骤无法确定
              </h4>
              <p className='mt-1 text-small text-muted-foreground'>
                找不到这次挂起对应的步骤，不能假装是第一步失败。
              </p>
            </div>
          </div>
          <Button variant='outline' disabled={busy} onClick={() => send({ action: 'stop' })}>
            <Square className='size-3.5' />
            结束会话
          </Button>
        </div>
      ) : null}

      {holding && failed ? (
        <div className='space-y-3'>
          <div className='flex items-start gap-2'>
            <AlertTriangle className='mt-0.5 size-4 shrink-0 text-status-error-foreground' />
            <div className='min-w-0 flex-1'>
              <div className='flex flex-wrap items-center gap-2'>
                <h4 className='text-body font-semibold text-status-error-foreground'>
                  第 {run.snapshot.steps.findIndex((s) => s.id === step?.id) + 1} 步执行失败
                </h4>
                <StatusBadge tone='error'>已挂起</StatusBadge>
              </div>
              <p className='mt-1 text-small text-muted-foreground'>
                {holdingFailureSummary(latestAttempt?.error ?? undefined)}
              </p>
              {latestAttempt?.error ? (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button type='button' size='sm' variant='ghost' className='mt-1 h-7 gap-1 px-2 text-label'>
                      详细原因
                      <ChevronDown className='size-3.5' />
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className='mt-1 rounded-md bg-muted/40 p-2 text-label text-muted-foreground'>
                    <p>
                      {latestAttempt.error.safeMessage}
                      {latestAttempt.error.code ? ` (${latestAttempt.error.code})` : ''}
                    </p>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </div>
          </div>

          {expectActual ? (
            <div className='rounded-md bg-muted/40 p-2.5 text-small'>
              <p className='text-muted-foreground'>
                期望值：<span className='font-mono font-medium text-foreground'>{expectActual.expected}</span>
              </p>
              <p className='text-muted-foreground'>
                实际值：<span className='font-mono font-medium text-foreground'>{expectActual.actual}</span>
              </p>
            </div>
          ) : null}

          <div className='rounded-md border border-border-default bg-muted/20 p-3 text-small'>
            <div className='flex items-center justify-between gap-2'>
              <span className='font-medium text-foreground'>
                {newlyPicked ? '已在画面中重选目标' : '修复建议：在中间受管画面中重新点选'}
              </span>
              <Button
                size='sm'
                variant={observe.pickMode ? 'default' : 'outline'}
                onClick={() => observe.setPickMode(!observe.pickMode)}
              >
                <Crosshair className='size-3.5' />
                {observe.pickMode ? '点击画面拾取…' : '重新在画面点选'}
              </Button>
            </div>
            {newlyPicked ? (
              <div className='mt-2 rounded bg-background p-2 font-mono text-label text-foreground'>
                {targetCandidateSummary(newlyPicked)}
              </div>
            ) : null}
          </div>

          <div className='flex flex-wrap items-center justify-between gap-2 pt-1'>
            <div className='flex items-center gap-2'>
              <Checkbox
                id='save-to-draft-chk'
                checked={saveToDraft}
                onCheckedChange={(v) => setSaveToDraft(v === true)}
              />
              <label
                htmlFor='save-to-draft-chk'
                className='cursor-pointer text-small text-muted-foreground'
              >
                重试通过后同步保存到草稿
              </label>
            </div>

            <div className='flex flex-wrap items-center gap-2'>
              <Button
                disabled={busy}
                onClick={() => {
                  if (isSideEffect) setConfirmSideEffect(true)
                  else handleRetryWithTarget(newlyPicked)
                }}
              >
                <RefreshCw className='size-3.5' />
                {newlyPicked ? '用新目标重试本步' : '再试这一步'}
              </Button>
              <Button
                variant='outline'
                disabled={busy}
                onClick={() => send({ action: 'stop' })}
              >
                <Square className='size-3.5' />
                结束会话
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {holding && (succeeded || pausedBeforeStep || (!failed && run.checkpoint?.reason === 'step_succeeded')) ? (
        <div className='space-y-3'>
          <div className='flex items-start gap-2'>
            {pausedBeforeStep
              ? <AlertTriangle className='mt-0.5 size-4 shrink-0 text-status-warning-foreground' />
              : <CheckCircle2 className='mt-0.5 size-4 shrink-0 text-status-success-foreground' />}
            <div className='min-w-0 flex-1'>
              <div className='flex flex-wrap items-center gap-2'>
                <h4 className={`text-body font-semibold ${pausedBeforeStep ? 'text-status-warning-foreground' : 'text-status-success-foreground'}`}>
                  {pausedBeforeStep
                    ? '已在当前步骤前暂停'
                    : run.checkpoint?.reason === 'step_succeeded'
                    ? '单步重试已成功，已自动重新挂起'
                    : '当前步骤已通过验证'}
                </h4>
                <StatusBadge tone={pausedBeforeStep ? 'warning' : 'success'}>{pausedBeforeStep ? '待执行' : '就绪'}</StatusBadge>
              </div>
              <p className='mt-0.5 text-small text-muted-foreground'>
                {pausedBeforeStep
                  ? '本步尚未执行。可先调整目标与条件，再单步验证或继续运行。'
                  : run.checkpoint?.reason === 'step_succeeded'
                  ? '本步重试成功，已保持受管画面。可继续执行后续步骤，或在此继续调整本步。'
                  : '本步已成功执行，点击继续执行后续安全步骤。'}
              </p>
            </div>
          </div>

          <div className='flex flex-wrap items-center gap-2'>
            <Button
              disabled={busy}
              onClick={() =>
                send({
                  action: 'continue',
                  fencingToken: run.checkpoint?.fencingToken,
                })
              }
            >
              <Play className='size-3.5' />
              {pausedBeforeStep ? '继续执行当前步骤' : '继续后续步骤'}
            </Button>
            <Button
              variant='outline'
              disabled={busy}
              onClick={() => send({ action: 'stop' })}
            >
              <Square className='size-3.5' />
              结束会话
            </Button>
          </div>
        </div>
      ) : null}

      {running ? (
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <p className='text-small text-muted-foreground'>正在受管环境中执行…</p>
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => send({ action: 'pause' })}
          >
            当前步结束后暂停
          </Button>
        </div>
      ) : null}

      <AlertDialog open={confirmPageChange} onOpenChange={setConfirmPageChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>页面已变化，仍要在此页面重试？</AlertDialogTitle>
            <AlertDialogDescription>
              受管浏览器当前页面 URL 或结构与发生挂起时有差异。确认后会开新的 Attempt 发起重试；解析失败不会伪造为成功。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPageChange(false)
                handleRetryWithTarget(newlyPicked, true)
              }}
            >
              确认在此页面重试
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmSideEffect} onOpenChange={setConfirmSideEffect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>再试具有副作用的步骤？</AlertDialogTitle>
            <AlertDialogDescription>
              这一步被标记为有副作用（例如提交表单或支付）。确认后才会向目标系统发起新操作，历史失败证据会被完整保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmSideEffect(false)
                handleRetryWithTarget(newlyPicked)
              }}
            >
              确认重试
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
