import { Link } from '@tanstack/react-router'
import {
  EVIDENCE_TYPE_LABELS,
  type EvidenceDetailResponse,
  type EvidenceSearchItem,
} from '@cairn/shared'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { TruncatedText } from '@/components/truncated-text'
import { AttemptEvidenceList } from '@/features/runs/evidence-viewer'
import { RUN_STATUS_LABELS, ATTEMPT_STATUS_LABELS } from '@/features/runs/labels'
import { EvidenceThumb } from './thumb'
import { formatKnownBytes, formatWhen, OUTCOME_STATUS_LABELS } from './labels'

function displayTone(status: EvidenceSearchItem['displayStatus']) {
  if (status === 'available' || status === 'available_structured') return 'success' as const
  if (status === 'collecting' || status === 'deleting') return 'info' as const
  if (status === 'capture_upload_anomaly' || status === 'unlinked') return 'warning' as const
  return 'neutral' as const
}

export function EvidenceContext({ item }: { item: EvidenceSearchItem }) {
  const location =
    item.stepOrdinal != null
      ? `步骤 ${item.stepOrdinal + 1}${item.stepName ? ` · ${item.stepName}` : ''}${item.attemptNo != null ? ` · 尝试 ${item.attemptNo}` : ''}`
      : '运行级'
  return (
    <div className='space-y-2 text-label'>
      <div className='flex flex-wrap items-center gap-2'>
        <StatusBadge tone={displayTone(item.displayStatus)}>{item.displayStatusLabel}</StatusBadge>
        {item.overlayProtected ? <StatusBadge tone='info'>保护中</StatusBadge> : null}
        {item.evidence.externalAccess ? <StatusBadge tone='neutral'>已对外发布</StatusBadge> : null}
        {item.hitKind === 'attempt_failed' ? <StatusBadge tone='error'>尝试失败</StatusBadge> : null}
        {item.hitKind === 'run_failed' ? <StatusBadge tone='error'>运行失败</StatusBadge> : null}
      </div>
      <p>
        {item.targetName}
        {item.targetNameCurrent !== item.targetName ? `（当前 ${item.targetNameCurrent}）` : ''}
        {item.targetDeleted ? ' · 目标已删除' : ''}
        {' · '}
        {item.scenarioName}
        {item.scenarioDeleted ? ' · 场景已删除' : ''}
        {item.scenarioVersionNo != null ? ` · v${item.scenarioVersionNo}` : ''}
        {item.scenarioVersionKind === 'trial' ? ' · 试跑' : ''}
      </p>
      <p className='text-muted-foreground'>{location}</p>
      <p className='text-muted-foreground'>
        采集 {formatWhen(item.evidence.createdAt)} · 运行 {RUN_STATUS_LABELS[item.runStatus]} · 结果{' '}
        {OUTCOME_STATUS_LABELS[item.outcomeStatus]}
        {item.attemptStatus ? ` · 尝试 ${ATTEMPT_STATUS_LABELS[item.attemptStatus]}` : ''}
      </p>
      <p className='text-muted-foreground'>
        体积 {formatKnownBytes(item.byteSize, item.byteSizeUnknown)} · 到期 {formatWhen(item.retainUntil)}
        {item.retainUntilUnknown ? '（期限未记录）' : ''}
      </p>
      {item.reasonUnknown ? <p className='text-status-warning-foreground'>原因未知</p> : null}
      {item.errorSummary ? <TruncatedText text={item.errorSummary} /> : null}
    </div>
  )
}

export function EvidenceDetailBody({
  detail,
}: {
  detail: EvidenceDetailResponse
}) {
  const item = detail.item
  const availableFile = item.evidence.status === 'available'
  return (
    <div className='space-y-4'>
      <EvidenceContext item={item} />
      {item.evidence.type === 'screenshot' && availableFile ? (
        <EvidenceThumb runId={item.evidence.runId} evidenceId={item.evidence.id} />
      ) : null}
      <AttemptEvidenceList runId={item.evidence.runId} items={[item.evidence]} />
      {detail.related.sameAttempt.length > 0 ? (
        <div>
          <p className='text-label font-medium'>同一次尝试</p>
          <ul className='mt-1 space-y-1'>
            {detail.related.sameAttempt.map((ref) => (
              <li key={ref.evidenceId}>
                <Link
                  to='/evidence/$evidenceId'
                  params={{ evidenceId: ref.evidenceId }}
                  className='text-label text-link'
                >
                  {EVIDENCE_TYPE_LABELS[ref.type]}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {detail.related.runVideo ? (
        <p className='text-label'>
          本次运行录像：
          <Link
            to='/evidence/$evidenceId'
            params={{ evidenceId: detail.related.runVideo.evidenceId }}
            className='text-link'
          >
            查看录像
          </Link>
        </p>
      ) : null}
      <Button asChild variant='outline'>
        <Link
          to='/runs/$runId'
          params={{ runId: item.evidence.runId }}
          search={{
            stepRunId: item.evidence.stepRunId ?? undefined,
            attemptId: item.evidence.attemptId ?? undefined,
            evidenceId: item.evidence.id,
          }}
        >
          回到运行
        </Link>
      </Button>
    </div>
  )
}
