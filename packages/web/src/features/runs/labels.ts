import type { RunStatus, StepRunStatus } from '@cairn/shared'
import type { StatusTone } from '@/components/status-badge'
import { RUN_STATUS_LABELS, STEP_RUN_STATUS_LABELS } from '@/features/scenarios/labels'

export { RUN_STATUS_LABELS, STEP_RUN_STATUS_LABELS }

export function runStatusTone(status: RunStatus): StatusTone {
  if (status === 'SUCCEEDED') return 'success'
  if (status === 'FAILED') return 'error'
  if (status === 'NEEDS_REVIEW' || status === 'WAITING_FOR_AUTH') return 'warning'
  if (status === 'RUNNING' || status === 'RECOVERING') return 'info'
  return 'neutral'
}

export function stepRunStatusTone(status: StepRunStatus): StatusTone {
  if (status === 'SUCCEEDED') return 'success'
  if (status === 'FAILED') return 'error'
  if (status === 'RUNNING') return 'info'
  return 'neutral'
}
