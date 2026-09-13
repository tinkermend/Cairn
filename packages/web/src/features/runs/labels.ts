import {
  isFinishedRunStatus,
  type AttemptStatus,
  type EvidenceCaptureMode,
  type RunEvidenceStatus,
  type RunPlacementState,
  type RunStatus,
  type StepRunStatus,
} from '@cairn/shared'
import type { StatusTone } from '@/components/status-badge'
import { RUN_STATUS_LABELS, STEP_RUN_STATUS_LABELS, STEP_TYPE_LABELS } from '@/features/scenarios/labels'

export { RUN_STATUS_LABELS, STEP_RUN_STATUS_LABELS, STEP_TYPE_LABELS }

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

export const ATTEMPT_STATUS_LABELS: Record<AttemptStatus, string> = {
  RUNNING: '运行中',
  SUCCEEDED: '成功',
  FAILED: '失败',
  CANCELLED: '已取消',
}

export const CAPTURE_MODE_LABELS: Record<EvidenceCaptureMode, string> = {
  off: '关闭',
  on_failure: '失败时',
  always: '始终',
}

export const MISSING_REASON_LABELS: Record<string, string> = {
  worker_lost: '执行进程失联，现场字节已不可得',
  object_store_unavailable: '对象存储不可用',
  object_purged: '已过保留期，对象被清理',
  upload_incomplete: '上传未完成',
  trace_too_large: 'Trace 超过体积上限，未上传',
  capture_failed: '采集失败，没有留下可用字节',
}

export function missingReasonLabel(reason: string): string {
  return MISSING_REASON_LABELS[reason] ?? reason
}

export function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (!startedAt || !finishedAt) return null
  const ms = Date.parse(finishedAt) - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${ms} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 1000)} s`
}
