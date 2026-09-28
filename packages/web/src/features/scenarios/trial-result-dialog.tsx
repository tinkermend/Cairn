import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ExternalLink, Focus, RefreshCw } from 'lucide-react'
import {
  buildRunVideoChapters,
  faceScreenshot,
  hasPermission,
  readRunVideoPayload,
  stepRunFor,
} from '@cairn/shared'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { StatusBadge } from '@/components/status-badge'
import { stepTypeLabel } from './labels'
import { findRunVideo, RunVideoSection, StepFaceScreenshot, stepFaceScreenshot } from '@/features/runs/run-video'
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

export type TrialResultDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  runId: string
  scenarioId: string
  selectedDraftStepId: string | null
  onSelectDraftStep: (stepId: string | null) => void
  onFocusFailedStep?: (stepId: string) => void
}

export function TrialResultDialog({
  open,
  onOpenChange,
  runId,
  scenarioId,
  selectedDraftStepId,
  onSelectDraftStep,
  onFocusFailedStep,
}: TrialResultDialogProps) {
  const user = useAuthStore((state) => state.auth.user)
  const canRead = Boolean(user && hasPermission(user.permissions, 'run:read'))
  const { run, evidence, connection, query: runQuery, refresh } = useRunObservation(runId, open && canRead)
  const [seekRequest, setSeekRequest] = useState<{
    token: number
    ms: number
    source: 'chapter' | 'list' | 'deeplink' | 'pin'
  } | null>(null)
  const seekTokenRef = useRef(1)
  const lastAutoSeekRef = useRef<string | null>(null)
  const video = findRunVideo(evidence?.items ?? [])
  const videoPayload = useMemo(() => readRunVideoPayload(video?.payload), [video?.payload])

  useEffect(() => {
    if (!canRead || !run || !selectedDraftStepId || !video) return
    const chapterModel = buildRunVideoChapters({
      run,
      payload: videoPayload,
      evidenceItems: evidence?.items ?? [],
    })
    if (!chapterModel.clock) return
    const step = run.snapshot.steps.find((s) => s.id === selectedDraftStepId)
    const stepRun = step ? stepRunFor(run.stepRuns, step.id) : undefined
    if (stepRun) {
      const chapter = chapterModel.chapters.find((c) => c.stepRunId === stepRun.id)
      if (chapter) {
        const seekKey = `${run.id}:${selectedDraftStepId}:${chapter.fromMs}`
        if (lastAutoSeekRef.current === seekKey) return
        lastAutoSeekRef.current = seekKey
        setSeekRequest({ token: seekTokenRef.current++, ms: chapter.fromMs, source: 'list' })
      }
    }
  }, [canRead, run, selectedDraftStepId, video, videoPayload, evidence?.items])

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
  const stepRun = historic && run ? stepRunFor(run.stepRuns, historic.id) : undefined
  const latestAttempt = stepRun?.attempts[stepRun.attempts.length - 1]
  const attemptEvidence = (evidence?.items ?? []).filter((item) => item.attemptId === latestAttempt?.id)
  const screenshot = latestAttempt
    ? faceScreenshot(attemptEvidence, latestAttempt.id, { attemptFailed: latestAttempt.status !== 'SUCCEEDED' })
    : undefined
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

  // 提取失败的第一步，供用户一键定位
  const firstFailedStepRun = run?.stepRuns.find((sr) => sr.status === 'FAILED')
  const failedStep = firstFailedStepRun
    ? run?.snapshot.steps.find((s) => s.id === firstFailedStepRun.stepId)
    : undefined

  const handleFocusFailure = () => {
    if (!failedStep) return
    if (onFocusFailedStep) {
      onFocusFailedStep(failedStep.id)
    } else {
      onSelectDraftStep(failedStep.id)
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className='w-[95vw] sm:max-w-5xl lg:max-w-6xl max-h-[88vh] flex flex-col p-0 gap-0 overflow-hidden'
        aria-describedby='trial-dialog-description'
      >
        <DialogHeader className='flex flex-row items-center justify-between border-b border-border-divider px-6 py-3.5 space-y-0 shrink-0 pr-12'>
          <div className='flex items-center gap-3 min-w-0'>
            <DialogTitle className='text-section font-semibold shrink-0 whitespace-nowrap text-foreground'>
              试跑结果
            </DialogTitle>
            {run ? (
              <div className='flex items-center gap-2 flex-wrap'>
                <StatusBadge tone={runStatusTone(run.status)}>{RUN_STATUS_LABELS[run.status]}</StatusBadge>
                <StatusBadge tone={runEvidenceStatusTone(run.evidenceStatus, run.status)}>
                  {RUN_EVIDENCE_STATUS_LABELS[run.evidenceStatus]}
                </StatusBadge>
                <StatusBadge tone={run.scenarioVersionKind === 'trial' ? 'warning' : 'neutral'}>
                  {run.scenarioVersionKind === 'trial' ? '试跑版本' : '正式版本'}
                </StatusBadge>
              </div>
            ) : null}
          </div>
          <DialogDescription id='trial-dialog-description' className='sr-only'>
            展示本次试跑的运行状态、业务结果轴以及执行录像与证据
          </DialogDescription>
          <div className='flex items-center gap-2 shrink-0'>
            {fetchedAt ? (
              <span className='text-label text-muted-foreground whitespace-nowrap hidden sm:inline'>
                最近获取 {fetchedAt}
              </span>
            ) : null}
            {canRead && connection ? (
              <StatusBadge tone={connectionTone(connection)}>{connectionLabel(connection)}</StatusBadge>
            ) : null}
            <Button
              size='sm'
              variant='outline'
              className='h-8 px-2.5'
              onClick={() => {
                void refresh()
              }}
            >
              <RefreshCw className='size-3.5 mr-1' />
              刷新
            </Button>
            <Button size='sm' variant='outline' className='h-8 px-2.5' asChild>
              <Link to='/runs/$runId' params={{ runId }} target='_blank'>
                <ExternalLink className='size-3.5 mr-1' />
                打开完整运行详情
              </Link>
            </Button>
          </div>
        </DialogHeader>

        <div className='flex-1 overflow-y-auto p-6'>
          {!canRead ? (
            <p className='text-small text-muted-foreground'>没有运行读取权限，不能展示试跑结果。草稿不受影响。</p>
          ) : runQuery.isError || mismatch ? (
            <p className='text-small text-status-warning-foreground'>
              {mismatch ? '这条运行不属于当前场景，已忽略。' : '无法加载该 Run。草稿不受影响。'}
            </p>
          ) : !run ? (
            <div className='flex items-center justify-center py-16 text-muted-foreground text-small'>
              正在读取试跑快照…
            </div>
          ) : (
            <div className='grid grid-cols-1 lg:grid-cols-12 gap-6 items-start'>
              {/* 左侧：高清大尺寸录像区 7 列 */}
              <div className='lg:col-span-7 space-y-4 min-w-0'>
                {video ? (
                  <div className='rounded-lg border border-border-card bg-card p-4 shadow-sm'>
                    <RunVideoSection
                      run={run}
                      items={evidence?.items ?? []}
                      seekRequest={seekRequest}
                      onSelectStep={(stepRunId) => {
                        const sr = run.stepRuns.find((s) => s.id === stepRunId)
                        if (sr) {
                          onSelectDraftStep(sr.stepId)
                        }
                      }}
                    />
                  </div>
                ) : (
                  <div className='rounded-lg border border-dashed border-border-default bg-muted/20 p-8 text-center text-muted-foreground space-y-1.5'>
                    <p className='text-body font-medium'>本次试跑未产生独立执行录像</p>
                    <p className='text-label text-muted-foreground/80'>
                      可能是由于未包含网页交互操作，或录像尚在异步落库中。
                    </p>
                  </div>
                )}

                {/* 模块步骤流水（若有模块） */}
                {hasModuleGroups && run ? (
                  <div className='rounded-lg border border-border-card bg-card p-4 space-y-2 shadow-sm'>
                    <h3 className='text-body font-semibold text-foreground'>模块步骤流水</h3>
                    <StepTimeline
                      run={run}
                      evidenceItems={evidence?.items ?? []}
                      onSelectStep={(stepRunId) => {
                        const sr = run.stepRuns.find((s) => s.id === stepRunId)
                        if (sr) {
                          onSelectDraftStep(sr.stepId)
                        }
                      }}
                    />
                  </div>
                ) : null}

                {/* 历史选中步骤证据详情（排查辅助） */}
                {historic ? (
                  <div className='space-y-3 rounded-lg border border-border-default bg-card p-4 shadow-sm'>
                    <div className='flex items-center justify-between'>
                      <div className='flex items-center gap-2'>
                        <span className='text-label font-medium text-muted-foreground'>检查步骤：</span>
                        <button
                          type='button'
                          className='text-left hover:underline'
                          onClick={() => onSelectDraftStep(historic.id)}
                        >
                          <span className='text-body font-medium'>{historic.name}</span>
                          <span className='ms-2 text-label text-muted-foreground'>{stepTypeLabel(historic.type)}</span>
                        </button>
                      </div>
                      {stepRun ? (
                        <StatusBadge tone={stepRunStatusTone(stepRun.status)}>
                          {STEP_RUN_STATUS_LABELS[stepRun.status]}
                        </StatusBadge>
                      ) : null}
                    </div>
                    {draftMissing ? (
                      <p className='text-label text-status-warning-foreground'>当前草稿没有这个 Step ID，不能按顺序错配另一步。</p>
                    ) : null}
                    {latestAttempt ? (
                      <div className='space-y-2 text-small border-t border-border-divider/60 pt-3'>
                        <p className='text-muted-foreground'>
                          最近 Attempt #{latestAttempt.attemptNo} · 共 {stepRun?.attempts.length ?? 0} 次尝试
                          {formatDuration(latestAttempt.startedAt, latestAttempt.finishedAt)
                            ? ` · 耗时 ${formatDuration(latestAttempt.startedAt, latestAttempt.finishedAt)}`
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
                          <div className='rounded bg-status-error/10 p-2.5 text-status-error-foreground font-mono text-caption'>
                            {latestAttempt.error.code}: {latestAttempt.error.safeMessage}
                          </div>
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
              </div>

              {/* 右侧：排错诊断与业务判定 5 列 */}
              <div className='lg:col-span-5 space-y-4 min-w-0'>
                {/* 失败高亮置顶卡片 */}
                {failedStep ? (
                  <div className='rounded-lg border border-status-error/40 bg-status-error/10 p-4 space-y-2.5 shadow-sm'>
                    <div className='flex items-center justify-between'>
                      <span className='text-caption font-semibold uppercase tracking-wider text-status-error-foreground flex items-center gap-1.5'>
                        <span className='size-2 rounded-full bg-status-error animate-pulse' />
                        步骤执行失败
                      </span>
                      <StatusBadge tone='error'>
                        第 {firstFailedStepRun ? firstFailedStepRun.ordinal + 1 : ''} 步
                      </StatusBadge>
                    </div>
                    <p className='text-body font-semibold text-foreground'>{failedStep.name}</p>
                    {latestAttempt?.error ? (
                      <div className='rounded bg-background/90 border border-status-error/20 p-2.5 font-mono text-caption text-status-error-foreground whitespace-pre-wrap break-all'>
                        {latestAttempt.error.code}: {latestAttempt.error.safeMessage}
                      </div>
                    ) : (
                      <p className='text-small text-status-error-foreground'>未能成功执行该步骤，请核对定位器或超时设置</p>
                    )}
                    <Button
                      size='sm'
                      variant='outline'
                      className='w-full border-status-error/40 text-status-error hover:bg-status-error/15 mt-1 font-medium bg-background/50'
                      onClick={handleFocusFailure}
                    >
                      <Focus className='size-3.5 mr-1.5' />
                      定位并修改此步骤
                    </Button>
                  </div>
                ) : null}

                {/* 步骤开始前失败 */}
                {run.status === 'FAILED' && run.stepRuns.every((item) => item.attempts.length === 0) ? (
                  <div className='rounded-lg border border-status-error/30 bg-status-error/10 p-4 shadow-sm'>
                    <p className='text-small font-medium text-status-error-foreground'>运行在步骤开始前失败。</p>
                    <AttemptEvidenceList runId={run.id} items={runLevel} />
                  </div>
                ) : null}

                {/* 业务结果判定 */}
                <div className='space-y-3 rounded-lg border border-border-card bg-card p-4 shadow-sm'>
                  <h3 className='text-body font-semibold text-foreground'>业务结果判定</h3>
                  <OutcomeAxisSummary
                    executionLabel={RUN_EXECUTION_AXIS_LABELS[run.status]}
                    outcomeStatus={run.outcomeStatus}
                    hasContracts={Boolean(run.snapshot.outcomeManifest?.entries.length)}
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
                </div>

                {/* 环境与恢复策略 */}
                <div className='space-y-3 rounded-lg border border-border-card bg-card p-4 shadow-sm'>
                  <h3 className='text-body font-semibold text-foreground'>环境与定位策略</h3>
                  <PlacementHint placement={run.placement} />
                  {run.authCheckpoint ? (
                    <div className='space-y-2 rounded-md border border-border-card bg-muted/30 p-3'>
                      <p className='text-body font-medium'>
                        {run.status === 'NEEDS_REVIEW' ? '操作结果待核查，请先确认业务结果' : run.authCheckpoint.status === 'recovering'
                          ? run.authCheckpoint.recoveryKind === 'manual'
                            ? '正在等待登录恢复'
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
                      <p className='text-label text-muted-foreground'>
                        恢复位置：第 {run.authCheckpoint.nextOrdinal + 1} 步 ·{' '}
                        {run.snapshot.steps.find((step) => step.id === run.authCheckpoint?.nextStepId)?.name ??
                          run.authCheckpoint.nextStepId}
                      </p>
                      {run.authCheckpoint.status === 'unrecoverable' && run.status !== 'NEEDS_REVIEW' && user && hasPermission(user.permissions, 'run:execute') ? (
                        <Button size='sm' variant='outline' className='mt-2' asChild>
                          <Link to='/scenarios/$scenarioId' params={{ scenarioId }}>
                            新建完整试跑
                          </Link>
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <p className='text-label text-muted-foreground'>本次试跑未触发认证恢复或登录门禁。</p>
                  )}
                  <p className='text-caption text-muted-foreground pt-2 border-t border-border-divider/70'>
                    冻结版本 {run.scenarioVersionId}
                    {run.startedAt ? ` · 开始 ${new Date(run.startedAt).toLocaleString()}` : ''}
                    。结果来自 Snapshot，不是当前草稿 revision。
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className='flex flex-row items-center justify-between border-t border-border-divider bg-muted/20 px-6 py-3.5 space-x-0 shrink-0'>
          <div>
            {failedStep ? (
              <Button
                variant='outline'
                size='sm'
                className='border-status-error text-status-error hover:bg-status-error/10 font-medium'
                onClick={handleFocusFailure}
              >
                <Focus className='size-3.5 mr-1.5' />
                定位到失败步骤：{failedStep.name}
              </Button>
            ) : (
              <span className='text-caption text-muted-foreground'>试跑为一次性验证，结果已自动同步至运行记录</span>
            )}
          </div>
          <Button size='sm' onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
