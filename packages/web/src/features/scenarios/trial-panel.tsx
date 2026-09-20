import { Link } from '@tanstack/react-router'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { faceScreenshot, hasPermission } from '@cairn/shared'
import { useAuthStore } from '@/stores/auth-store'
import { connectionLabel, connectionTone, useRunObservation } from '@/features/runs/use-run-observation'
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
import { BrowserView } from '@/features/runs/browser-view'
import { RunVideoSection, StepFaceScreenshot, stepFaceScreenshot } from '@/features/runs/run-video'
import { PlacementHint } from '@/features/runs/placement-hint'
import { StepTimeline } from '@/features/runs/step-timeline'
import { OutcomeAxisSummary, OutcomeConditionList, RUN_EXECUTION_AXIS_LABELS } from '@/features/runs/outcome-axis'

function formatTrialValue(value: unknown): string {
  if (value === undefined) return '无'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '无法展示'
  }
}

export function TrialPanel({
  runId,
  scenarioId,
  selectedDraftStepId,
  onSelectDraftStep,
}: {
  runId: string
  scenarioId: string
  selectedDraftStepId: string | null
  onSelectDraftStep: (stepId: string | null) => void
}) {
  const user = useAuthStore((state) => state.auth.user)
  const canRead = Boolean(user && hasPermission(user.permissions, 'run:read'))
  const { run, evidence, connection, query: runQuery, refresh, eventSeq } = useRunObservation(runId, canRead)

  if (!canRead) {
    return (
      <section aria-label='试跑结果' className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
        <p className='text-small text-muted-foreground'>没有运行读取权限，不能展示试跑结果。草稿不受影响。</p>
      </section>
    )
  }

  const mismatch = run && run.scenarioId !== scenarioId
  const selectedModule = run?.snapshot.moduleManifest?.entries.find(
    (entry) => entry.invocationId === selectedDraftStepId,
  )
  const derivedForDraft = run?.snapshot.outcomeManifest?.entries.find(
    (entry) => entry.sourceStepId === selectedDraftStepId,
  )
  const historic =
    (selectedModule
      ? run?.snapshot.steps.find((step) => selectedModule.expandedStepIds.includes(step.id))
      : run?.snapshot.steps.find((step) => step.id === selectedDraftStepId) ??
        run?.snapshot.steps.find((step) => step.id === derivedForDraft?.stepId)) ?? run?.snapshot.steps[0]
  const stepRun = historic ? run?.stepRuns.find((item) => item.stepId === historic.id) : undefined
  const latestAttempt = stepRun?.attempts[stepRun.attempts.length - 1]
  const attemptEvidence = (evidence?.items ?? []).filter((item) => item.attemptId === latestAttempt?.id)
  const screenshot = latestAttempt ? faceScreenshot(attemptEvidence, latestAttempt.id) : undefined
  const runLevel = (evidence?.items ?? []).filter((item) => !item.attemptId)
  const draftMissing = Boolean(
    selectedDraftStepId &&
      run &&
      !run.snapshot.steps.some((step) => step.id === selectedDraftStepId) &&
      !run.snapshot.outcomeManifest?.entries.some((entry) => entry.sourceStepId === selectedDraftStepId) &&
      !run.snapshot.moduleManifest?.entries.some((entry) => entry.invocationId === selectedDraftStepId),
  )
  const fetchedAt = runQuery.dataUpdatedAt ? new Date(runQuery.dataUpdatedAt).toLocaleTimeString() : null
  const hasModuleGroups = Boolean(run?.snapshot.moduleManifest?.entries.length)

  return (
    <Collapsible defaultOpen className='rounded-lg border border-border-card bg-card shadow-card'>
      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider px-5 py-4'>
        <CollapsibleTrigger className='flex items-center gap-2 text-left'>
          <h2 className='text-section font-semibold'>试跑结果</h2>
          <ChevronDown className='size-4 text-muted-foreground' />
        </CollapsibleTrigger>
        <div className='flex flex-wrap items-center gap-2'>
          {fetchedAt ? <p className='text-label text-muted-foreground'>最近获取 {fetchedAt}</p> : null}
          {canRead ? (
            <StatusBadge tone={connectionTone(connection)}>{connectionLabel(connection)}</StatusBadge>
          ) : null}
          <Button
            size='sm'
            variant='outline'
            onClick={() => {
              void refresh()
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
            <OutcomeAxisSummary
              executionLabel={RUN_EXECUTION_AXIS_LABELS[run.status]}
              outcomeStatus={run.outcomeStatus}
            />
            <OutcomeConditionList
              runId={run.id}
              run={run}
              evidenceItems={evidence?.items ?? []}
              onEdit={(row) => {
                if (row.entry.scope === 'scenario') {
                  onSelectDraftStep(null)
                  return
                }
                onSelectDraftStep(row.entry.sourceStepId ?? selectedDraftStepId)
              }}
            />
            <PlacementHint placement={run.placement} />
            {run.authCheckpoint ? (
              <div className='space-y-2 rounded-md border border-border-card bg-muted/30 p-3'>
                <p className='text-body'>
                  {run.status === 'NEEDS_REVIEW' ? '操作结果待核查，请先确认业务结果' : run.authCheckpoint.status === 'recovering'
                    ? run.authCheckpoint.recoveryKind === 'manual'
                      ? '正在等待人工认证恢复'
                      : '正在恢复登录'
                    : run.authCheckpoint.status === 'recovered'
                      ? '登录已恢复，已通过续跑校验'
                      : run.authCheckpoint.status === 'unrecoverable'
                        ? '登录已失效，本次运行无法安全续跑'
                        : '认证门禁已关闭'}
                </p>
                <p className='text-label text-muted-foreground'>
                  {run.authCheckpoint.trigger.summary}
                  {run.authCheckpoint.unrecoverableCode
                    ? ` · ${run.authCheckpoint.unrecoverableCode === 'AUTH_RECOVERY_LIMIT' ? '恢复次数已用尽' : '无法安全续跑'}`
                    : ''}
                </p>
                <p className='text-label text-muted-foreground'>恢复位置：第 {run.authCheckpoint.nextOrdinal + 1} 步 · {run.snapshot.steps.find((step) => step.id === run.authCheckpoint?.nextStepId)?.name ?? run.authCheckpoint.nextStepId}</p>
                {run.authCheckpoint.status === 'unrecoverable' && run.status !== 'NEEDS_REVIEW' && user && hasPermission(user.permissions, 'run:execute') ? (
                  <Button size='sm' variant='outline' asChild>
                    <Link to='/scenarios/$scenarioId' params={{ scenarioId }}>
                      新建完整试跑
                    </Link>
                  </Button>
                ) : null}
              </div>
            ) : null}
            <BrowserView
              runId={run.id}
              runStatus={run.status}
              eventSeq={eventSeq}
              onRunChanged={refresh}
            />
            <RunVideoSection run={run} items={evidence?.items ?? []} />
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
            {hasModuleGroups && run ? (
              <StepTimeline run={run} evidenceItems={evidence?.items ?? []} />
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
                    {latestAttempt.output &&
                    typeof latestAttempt.output === 'object' &&
                    !Array.isArray(latestAttempt.output) &&
                    ('expected' in latestAttempt.output || 'actual' in latestAttempt.output) ? (
                      <p>
                        期望 {formatTrialValue((latestAttempt.output as { expected?: unknown }).expected)}
                        {' · '}
                        实际 {formatTrialValue((latestAttempt.output as { actual?: unknown }).actual)}
                      </p>
                    ) : null}
                    {latestAttempt.error ? (
                      <p className='text-status-error-foreground'>
                        {latestAttempt.error.code}: {latestAttempt.error.safeMessage}
                      </p>
                    ) : null}
                    <AiAttemptSummary output={latestAttempt.output} evidence={attemptEvidence} />
                    {(() => {
                      const face = stepRun ? stepFaceScreenshot(stepRun.attempts, evidence?.items ?? []) : screenshot
                      return face ? <StepFaceScreenshot runId={run.id} item={face} /> : null
                    })()}
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
