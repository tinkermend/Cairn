import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  EVIDENCE_TYPE_LABELS,
  type EvidenceDetailResponse,
  type EvidenceSearchItem,
} from '@cairn/shared'
import { ExternalLink, ListOrdered, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { TruncatedText } from '@/components/truncated-text'
import { AttemptEvidenceList } from '@/features/runs/evidence-viewer'
import { RUN_STATUS_LABELS, ATTEMPT_STATUS_LABELS } from '@/features/runs/labels'
import { StepTimeline } from '@/features/runs/step-timeline'
import { useRunObservation } from '@/features/runs/use-run-observation'
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

function EvidenceRunTimeline({
  runId,
  currentStepRunId,
  currentAttemptId,
  currentEvidenceId,
}: {
  runId: string
  currentStepRunId?: string | null
  currentAttemptId?: string | null
  currentEvidenceId?: string
}) {
  const [selectedStepRunId, setSelectedStepRunId] = useState<string | null>(
    currentStepRunId ?? null
  )
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(
    currentAttemptId ?? null
  )

  const { run, evidence, query } = useRunObservation(runId)

  return (
    <section className='mt-6 space-y-3 border-t border-border-card pt-5'>
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <ListOrdered className='size-4 text-primary' />
          <h3 className='font-semibold text-body'>全景执行流水线</h3>
          {run ? (
            <span className='rounded-full bg-surface-subtle px-2 py-0.5 text-label text-muted-foreground'>
              共 {run.stepRuns.length} 步 · {RUN_STATUS_LABELS[run.status]}
            </span>
          ) : null}
        </div>
        <Button asChild variant='ghost' size='sm' className='h-7 gap-1 text-label'>
          <Link
            to='/runs/$runId'
            params={{ runId }}
            search={{
              stepRunId: selectedStepRunId ?? undefined,
              attemptId: selectedAttemptId ?? undefined,
              evidenceId: currentEvidenceId,
            }}
          >
            <span>完整运行页</span>
            <ExternalLink className='size-3' />
          </Link>
        </Button>
      </div>

      {query.isPending ? (
        <div className='flex items-center justify-center gap-2 rounded-lg border border-border-card bg-surface-subtle/50 p-6 text-label text-muted-foreground'>
          <Loader2 className='size-4 animate-spin text-primary' />
          <span>正在加载完整步骤流水线...</span>
        </div>
      ) : query.isError || !run ? (
        <p className='rounded-lg border border-border-card bg-surface-subtle/50 p-3 text-label text-muted-foreground'>
          无法加载本次运行的完整步骤。你可以点击上方按钮直接前往运行详情页。
        </p>
      ) : (
        <div className='rounded-lg border border-border-card bg-surface-subtle/30 p-3'>
          <StepTimeline
            run={run}
            evidenceItems={evidence?.items ?? []}
            focusStepRunId={selectedStepRunId ?? undefined}
            focusAttemptId={selectedAttemptId ?? undefined}
            focusEvidenceId={currentEvidenceId}
            currentStepRunId={selectedStepRunId}
            onSelectStep={(stepRunId, attemptId) => {
              setSelectedStepRunId(stepRunId)
              setSelectedAttemptId(attemptId ?? null)
            }}
          />
        </div>
      )}
    </section>
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
      <div className='pt-1'>
        <Button asChild variant='outline' size='sm'>
          <Link
            to='/runs/$runId'
            params={{ runId: item.evidence.runId }}
            search={{
              stepRunId: item.evidence.stepRunId ?? undefined,
              attemptId: item.evidence.attemptId ?? undefined,
              evidenceId: item.evidence.id,
            }}
          >
            回到运行详情
          </Link>
        </Button>
      </div>

      <EvidenceRunTimeline
        key={item.evidence.id}
        runId={item.evidence.runId}
        currentStepRunId={item.evidence.stepRunId}
        currentAttemptId={item.evidence.attemptId}
        currentEvidenceId={item.evidence.id}
      />
    </div>
  )
}
