import type { EvidenceSearchItem } from '@cairn/shared'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  RUN_STATUS_LABELS,
  ATTEMPT_STATUS_LABELS,
} from '@/features/runs/labels'
import { OUTCOME_STATUS_LABELS } from './labels'
import { cn } from '@/lib/utils'

function isSuccess(status?: string | null): boolean {
  return status === 'SUCCEEDED' || status === 'SUCCESS'
}

function isFailed(status?: string | null): boolean {
  return status === 'FAILED'
}

function isCancelled(status?: string | null): boolean {
  return status === 'CANCELLED'
}

function isRunning(status?: string | null): boolean {
  return status === 'RUNNING' || status === 'RECOVERING'
}

export function EvidenceResultCell({ item }: { item: EvidenceSearchItem }) {
  const isStep = item.stepOrdinal != null
  const { runStatus, attemptStatus, outcomeStatus, hitKind } = item

  let badgeTone: StatusTone = 'neutral'
  let badgeLabel = ''
  let subText: string | null = null
  let subTextVariant: 'muted' | 'success' | 'error' = 'muted'

  if (isSuccess(runStatus)) {
    if (isFailed(attemptStatus)) {
      badgeTone = 'warning'
      badgeLabel = '本步失败'
      subText = '运行已重试成功'
      subTextVariant = 'success'
    } else {
      badgeTone = 'success'
      badgeLabel = '成功'
      subText = isStep ? '本步通过' : '运行通过'
      subTextVariant = 'muted'
    }
  } else if (isFailed(runStatus)) {
    if (isFailed(attemptStatus)) {
      badgeTone = 'error'
      badgeLabel = '执行失败'
      subText = '整次运行失败'
      subTextVariant = 'muted'
    } else if (isSuccess(attemptStatus)) {
      badgeTone = 'success'
      badgeLabel = '本步通过'
      subText = '后续步骤失败'
      subTextVariant = 'error'
    } else {
      badgeTone = 'error'
      badgeLabel = '运行失败'
      subText = isStep ? '整次运行失败' : '运行级异常'
      subTextVariant = 'muted'
    }
  } else if (isCancelled(runStatus) || isCancelled(attemptStatus)) {
    badgeTone = 'neutral'
    badgeLabel = '已取消'
    subText = isCancelled(runStatus) ? '运行已取消' : '步骤已取消'
    subTextVariant = 'muted'
  } else if (isRunning(runStatus) || isRunning(attemptStatus)) {
    badgeTone = 'info'
    badgeLabel = '运行中'
    subText = isRunning(attemptStatus) ? '步骤执行中' : '运行处理中'
    subTextVariant = 'muted'
  } else {
    badgeTone = 'waiting'
    badgeLabel = RUN_STATUS_LABELS[runStatus] ?? runStatus
    subText = attemptStatus ? `尝试 ${ATTEMPT_STATUS_LABELS[attemptStatus] ?? attemptStatus}` : null
    subTextVariant = 'muted'
  }

  const tooltipLines: string[] = [
    `运行状态：${RUN_STATUS_LABELS[runStatus] ?? runStatus}`,
  ]
  if (attemptStatus) {
    tooltipLines.push(`单步尝试：${ATTEMPT_STATUS_LABELS[attemptStatus] ?? attemptStatus}`)
  }
  if (outcomeStatus) {
    tooltipLines.push(`业务判定：${OUTCOME_STATUS_LABELS[outcomeStatus] ?? outcomeStatus}`)
  }
  if (hitKind) {
    tooltipLines.push(`检索命中：${hitKind === 'attempt_failed' ? '单步尝试失败' : '整次运行失败'}`)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className='flex flex-col items-start gap-0.5 cursor-default select-none'>
          <StatusBadge tone={badgeTone}>{badgeLabel}</StatusBadge>
          {subText ? (
            <span
              className={cn(
                'text-label whitespace-nowrap',
                subTextVariant === 'muted' && 'text-muted-foreground',
                subTextVariant === 'success' && 'text-status-success-foreground',
                subTextVariant === 'error' && 'text-status-error-foreground'
              )}
            >
              {subText}
            </span>
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent className='text-label space-y-1 p-2'>
        {tooltipLines.map((line, idx) => (
          <p key={idx}>{line}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}
