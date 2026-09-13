import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { hasPermission } from '@cairn/shared'
import { fetchRun, fetchRunEvidence } from '@/lib/runs-api'
import { useAuthStore } from '@/stores/auth-store'
import { AttemptEvidenceList } from '@/features/runs/evidence-viewer'
import { AiAttemptSummary } from '@/features/runs/ai-evidence'
import {
  RUN_EVIDENCE_STATUS_LABELS,
  RUN_STATUS_LABELS,
  STEP_RUN_STATUS_LABELS,
  formatDuration,
  runEvidenceStatusTone,
  runStatusTone,
  stepRunStatusTone,
} from '@/features/runs/labels'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { StatusBadge } from '@/components/status-badge'
import { stepTypeLabel } from './labels'

export function TrialPanel({
  runId,
  scenarioId,
  selectedDraftStepId,
  onSelectDraftStep,
}: {
  runId: string
  scenarioId: string
  selectedDraftStepId: string | null
  onSelectDraftStep: (stepId: string) => void
}) {
  const user = useAuthStore((state) => state.auth.user)
  const canRead = Boolean(user && hasPermission(user.permissions, 'run:read'))
  const runQuery = useQuery({
    queryKey: ['runs', runId],
    queryFn: () => fetchRun(runId),
    enabled: canRead,
  })
  const evidenceQuery = useQuery({
    queryKey: ['runs', runId, 'evidence'],
    queryFn: () => fetchRunEvidence(runId),
    enabled: canRead && runQuery.isSuccess,
  })

  if (!canRead) {
    return (
      <section aria-label='试跑结果' className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
        <p className='text-small text-muted-foreground'>没有运行读取权限，不能展示试跑结果。草稿不受影响。</p>
      </section>
    )
  }

  const run = runQuery.data
  const mismatch = run && run.scenarioId !== scenarioId
  const historic = run?.snapshot.steps.find((step) => step.id === selectedDraftStepId) ?? run?.snapshot.steps[0]
  const stepRun = historic ? run?.stepRuns.find((item) => item.stepId === historic.id) : undefined
  const latestAttempt = stepRun?.attempts[stepRun.attempts.length - 1]
  const attemptEvidence = (evidenceQuery.data?.items ?? []).filter((item) => item.attemptId === latestAttempt?.id)
  const screenshot = attemptEvidence.find((item) => item.type === 'screenshot')
  const runLevel = (evidenceQuery.data?.items ?? []).filter((item) => !item.attemptId)
  const draftMissing = Boolean(selectedDraftStepId && run && !run.snapshot.steps.some((step) => step.id === selectedDraftStepId))
  const fetchedAt = runQuery.dataUpdatedAt ? new Date(runQuery.dataUpdatedAt).toLocaleTimeString() : null

  return (
    <Collapsible defaultOpen className='rounded-lg border border-border-card bg-card shadow-card'>
      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider px-5 py-4'>
        <CollapsibleTrigger className='flex items-center gap-2 text-left'>
          <h2 className='text-section font-semibold'>试跑结果</h2>
          <ChevronDown className='size-4 text-muted-foreground' />
        </CollapsibleTrigger>
        <div className='flex flex-wrap items-center gap-2'>
          {fetchedAt ? <p className='text-label text-muted-foreground'>最近获取 {fetchedAt}</p> : null}
          <Button
            size='sm'
            variant='outline'
            onClick={() => {
              void runQuery.refetch()
              void evidenceQuery.refetch()
            }}
          >
            <RefreshCw />
            刷新
          </Button>
          <Button size='sm' variant='outline' asChild>
            <Link to='/runs/$runId' params={{ runId }}>
              打开完整运行详情
            </Link>
          </Button>
        </div>
      </div>
      <CollapsibleContent className='space-y-4 p-5'>
        {runQuery.isError || mismatch ? (
          <p className='text-small text-status-warning-foreground'>
            {mismatch ? '这条运行不属于当前场景，已忽略。' : '无法加载该 Run。草稿不受影响。'}
          </p>
        ) : !run ? (
          <p className='text-small text-muted-foreground'>正在读取冻结快照…</p>
        ) : (
          <>
            <div className='flex flex-wrap items-center gap-2'>
              <StatusBadge tone={runStatusTone(run.status)}>{RUN_STATUS_LABELS[run.status]}</StatusBadge>
              <StatusBadge tone={runEvidenceStatusTone(run.evidenceStatus, run.status)}>
                {RUN_EVIDENCE_STATUS_LABELS[run.evidenceStatus]}
              </StatusBadge>
              <StatusBadge tone={run.scenarioVersionKind === 'trial' ? 'warning' : 'neutral'}>
                {run.scenarioVersionKind === 'trial' ? '试跑版本' : '正式版本'}
              </StatusBadge>
            </div>
            <p className='text-small text-muted-foreground'>
              冻结版本 {run.scenarioVersionId}
              {run.startedAt ? ` · 开始 ${new Date(run.startedAt).toLocaleString()}` : ''}
              。结果来自 Snapshot，不是当前草稿 revision。
            </p>
            {run.status === 'FAILED' && run.stepRuns.every((item) => item.attempts.length === 0) ? (
              <div>
                <p className='text-small text-status-warning-foreground'>运行在步骤开始前失败。</p>
                <AttemptEvidenceList runId={run.id} items={runLevel} />
              </div>
            ) : null}
            {historic ? (
              <div className='space-y-2 rounded-md border border-border-default p-4'>
                <button type='button' className='text-left' onClick={() => onSelectDraftStep(historic.id)}>
                  <p className='text-body font-medium'>
                    {historic.name}
                    <span className='ms-2 text-label text-muted-foreground'>{stepTypeLabel(historic.type)}</span>
                  </p>
                </button>
                {draftMissing ? (
                  <p className='text-label text-status-warning-foreground'>当前草稿没有这个 Step ID，不能按顺序错配另一步。</p>
                ) : null}
                {stepRun ? (
                  <StatusBadge tone={stepRunStatusTone(stepRun.status)}>{STEP_RUN_STATUS_LABELS[stepRun.status]}</StatusBadge>
                ) : (
                  <p className='text-label text-muted-foreground'>这个历史步骤还没有 StepRun。</p>
                )}
                {latestAttempt ? (
                  <div className='space-y-2 text-small'>
                    <p>
                      最近 Attempt #{latestAttempt.attemptNo} · 共 {stepRun?.attempts.length ?? 0} 次
                      {formatDuration(latestAttempt.startedAt, latestAttempt.finishedAt)
                        ? ` · ${formatDuration(latestAttempt.startedAt, latestAttempt.finishedAt)}`
                        : ''}
                    </p>
                    {latestAttempt.error ? (
                      <p className='text-status-error-foreground'>
                        {latestAttempt.error.code}: {latestAttempt.error.safeMessage}
                      </p>
                    ) : null}
                    <AiAttemptSummary output={latestAttempt.output} evidence={attemptEvidence} />
                    {screenshot ? <AttemptEvidenceList runId={run.id} items={[screenshot]} /> : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}
