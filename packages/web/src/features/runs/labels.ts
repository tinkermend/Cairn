import { isFinishedRunStatus, type RunEvidenceStatus, type RunPlacementState, type RunStatus, type StepRunStatus } from '@cairn/shared'
import type { StatusTone } from '@/components/status-badge'
import { RUN_STATUS_LABELS, STEP_RUN_STATUS_LABELS } from '@/features/scenarios/labels'

export { RUN_STATUS_LABELS, STEP_RUN_STATUS_LABELS }

export const PLACEMENT_COPY: Record<
  Exclude<RunPlacementState, 'not_applicable' | 'claimed' | 'claimable'>,
  string
> = {
  owner_required: '等待持有该账号会话的 Worker 领取。',
  owner_at_capacity: '会话所在 Worker 执行槽已满，排队中。',
  session_not_ready: '会话正在创建或关闭，等待就绪。',
  session_lost: '会话失联，处置并确认旧浏览器停止后才会继续。',
}

export function runStatusTone(status: RunStatus): StatusTone {
  if (status === 'SUCCEEDED') return 'success'
  if (status === 'FAILED') return 'error'
  if (status === 'NEEDS_REVIEW' || status === 'WAITING_FOR_AUTH') return 'warning'
  if (status === 'RUNNING' || status === 'RECOVERING') return 'info'
  return 'neutral'
}

export const RUN_EVIDENCE_STATUS_LABELS: Record<RunEvidenceStatus, string> = {
  PENDING: '证据收集中',
  COMPLETE: '证据完整',
  INCOMPLETE: '证据不完整',
}

export function runEvidenceStatusTone(
  evidenceStatus: RunEvidenceStatus,
  runStatus: RunStatus,
): StatusTone {
  if (evidenceStatus === 'INCOMPLETE') return 'warning'
  if (evidenceStatus === 'COMPLETE') return 'success'
  if (isFinishedRunStatus(runStatus) && evidenceStatus === 'PENDING') return 'neutral'
  return 'neutral'
}

export function stepRunStatusTone(status: StepRunStatus): StatusTone {
  if (status === 'SUCCEEDED') return 'success'
  if (status === 'FAILED') return 'error'
  if (status === 'RUNNING') return 'info'
  return 'neutral'
}
