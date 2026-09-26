import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import {
  buildRunVideoChapters,
  readRunVideoPayload,
  RUN_EXECUTE_ALL_OF,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  cancelRun,
  deleteRun,
  fetchRunCleanup,
  previewDeleteRun,
  retryRunCleanup,
  reviewRun,
} from '@/lib/runs-api'
import { useCan } from '@/hooks/use-permissions'
import { useRunObservation } from './use-run-observation'
import { CleanupStatusIndicator } from '@/components/cleanup-status-indicator'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Main } from '@/components/layout/main'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DebugHoldBar } from './debug-hold-bar'
import { resolveRunEvidenceFocus } from './evidence-focus'
import { useAssistantContextBinding } from '@/features/assistant/use-assistant-context-binding'
import { AlertTriangle } from 'lucide-react'
import { RunCreateDialog } from './create-dialog'
import { findRunVideo } from './run-video'
import { RunHeroBanner } from './run-hero-banner'
import { StepRail } from './step-rail'
import { MediaViewport } from './media-viewport'
import { StepInspector } from './step-inspector'
import { PlacementHint } from './placement-hint'
import { AttemptEvidenceList } from './evidence-viewer'

export function RunDetailPage() {
  const { runId } = useParams({ from: '/_authenticated/runs/$runId/' })
  const search = useSearch({ from: '/_authenticated/runs/$runId/' })
  const navigate = useNavigate()
  const { run, evidence, connection, query: runQuery, refresh, eventSeq } = useRunObservation(runId)
  const [note, setNote] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState(false)
  const canDelete = useCan('run:delete')
  const canCancel = useCan('run:cancel')
  const evidenceItems = evidence?.items ?? []
  const runLevel = evidenceItems.filter((e) => !e.stepRunId && !e.attemptId)

  // 选中的步骤与尝试
  const [currentStepRunId, setCurrentStepRunId] = useState<string | null>(null)
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null)
  // 录像正在播放的步骤
  const [currentPlayingStepRunId, setCurrentPlayingStepRunId] = useState<string | null>(null)

  const selectedStep = run?.stepRuns.find((s) => s.id === currentStepRunId)
  const selectedStepId = selectedStep?.stepId

  useAssistantContextBinding(
    run
      ? {
          page: 'run',
          runId,
          targetId: run.targetId,
          scenarioId: run.scenarioId,
          statusSummary: `${run.scenarioName || '运行'} (${run.status})`,
          ...(selectedStepId ? { selectedStepId } : {}),
        }
      : {
          page: 'run',
          runId,
          statusSummary: '加载中...',
        }
  )

  const [seekRequest, setSeekRequest] = useState<{
    token: number
    ms: number
    source: 'chapter' | 'list' | 'deeplink' | 'pin'
  } | null>(null)
  const seekTokenRef = useRef(1)

  // 步骤选择与录像 Seek 联动
  const handleSelectStep = useCallback(
    (stepRunId: string, attemptId?: string) => {
      setCurrentStepRunId(stepRunId)
      setSelectedAttemptId(attemptId ?? null)
      if (!run) return

      const video = findRunVideo(evidenceItems)
      const videoPayload = readRunVideoPayload(video?.payload)
      const chapterModel = buildRunVideoChapters({ run, payload: videoPayload, evidenceItems })
      const chapter = chapterModel.chapters.find((c) => c.stepRunId === stepRunId)

      if (chapter) {
        if (attemptId) {
          const stepRun = run.stepRuns.find((s) => s.id === stepRunId)
          const att = stepRun?.attempts.find((a) => a.id === attemptId)
          const attStartMs =
            att && chapterModel.clock
              ? Date.parse(att.startedAt) - chapterModel.clock.originMs
              : chapter.fromMs
          setSeekRequest({ token: seekTokenRef.current++, ms: attStartMs, source: 'list' })
        } else {
          setSeekRequest({ token: seekTokenRef.current++, ms: chapter.fromMs, source: 'list' })
        }
      }
    },
    [run, evidenceItems]
  )

  // 初始化默认选中的步骤（首屏直达失败步或深链步）
  useEffect(() => {
    if (!run || run.stepRuns.length === 0) return
    const focus = resolveRunEvidenceFocus(run, evidenceItems, search)

    if (focus.stepRunId && !focus.mismatch) {
      setCurrentStepRunId(focus.stepRunId)
      if (focus.attemptId) setSelectedAttemptId(focus.attemptId)
      return
    }

    // 若用户尚未手动选择，智能选择第一优先级步骤
    if (!currentStepRunId) {
      const failed = run.stepRuns.find((s) => s.status === 'FAILED')
      const running = run.stepRuns.find((s) => s.status === 'RUNNING')
      const defaultStep = failed || running || run.stepRuns[0]
      if (defaultStep) {
        setCurrentStepRunId(defaultStep.id)
        const lastAtt = defaultStep.attempts[defaultStep.attempts.length - 1]
        if (lastAtt) setSelectedAttemptId(lastAtt.id)
      }
    }
  }, [run, evidenceItems, search, currentStepRunId])

  // 深链初始化录像 Seek
  const deepLinkSeekDoneRef = useRef(false)
  useEffect(() => {
    if (deepLinkSeekDoneRef.current || !run) return
    const video = findRunVideo(evidenceItems)
    const videoPayload = readRunVideoPayload(video?.payload)
    const chapterModel = buildRunVideoChapters({ run, payload: videoPayload, evidenceItems })
    if (!chapterModel.clock) return

    const focus = resolveRunEvidenceFocus(run, evidenceItems, search)
    if (focus.mismatch) {
      deepLinkSeekDoneRef.current = true
      return
    }

    if (focus.stepRunId) {
      const chapter = chapterModel.chapters.find((c) => c.stepRunId === focus.stepRunId)
      if (chapter) {
        let seekMs = chapter.fromMs
        if (focus.attemptId) {
          const stepRun = run.stepRuns.find((s) => s.id === focus.stepRunId)
          const att = stepRun?.attempts.find((a) => a.id === focus.attemptId)
          if (att) {
            seekMs = Date.parse(att.startedAt) - chapterModel.clock.originMs
          }
        }
        setSeekRequest({ token: seekTokenRef.current++, ms: seekMs, source: 'deeplink' })
      }
    }
    deepLinkSeekDoneRef.current = true
  }, [run, evidenceItems, search])

  const cleanupQuery = useQuery({
    queryKey: ['runs', runId, 'cleanup'],
    queryFn: () => fetchRunCleanup(runId),
    enabled: runQuery.isError,
  })
  const deletedView = runQuery.isError && !run && cleanupQuery.isSuccess

  if (runQuery.isPending) {
    return (
      <Main className='flex min-w-0 flex-1 flex-col gap-4 p-4'>
        <PageSkeleton />
      </Main>
    )
  }

  if (deletedView && cleanupQuery.data) {
    return (
      <Main className='flex min-w-0 flex-1 flex-col gap-4 p-5'>
        <section className='space-y-4 rounded-lg border border-border-card bg-card p-5 shadow-card'>
          <p className='text-body'>运行已删除。业务记录不可访问，附件按清理状态处理。</p>
          <CleanupStatusIndicator
            status={cleanupQuery.data}
            onRetry={canDelete ? () => retryRunCleanup(runId) : undefined}
            onStatusUpdated={() => void cleanupQuery.refetch()}
          />
          <Button variant='outline' onClick={() => void navigate({ to: '/runs' })}>
            返回运行记录
          </Button>
        </section>
      </Main>
    )
  }

  if (runQuery.isError || !run) {
    return (
      <Main className='flex min-w-0 flex-1 flex-col gap-4 p-5'>
        <QueryErrorState title='无法加载运行' onRetry={refresh} />
      </Main>
    )
  }

  return (
    <>
      <Main className='flex h-[calc(100vh-theme(spacing.16))] flex-col overflow-hidden p-3 sm:p-4 gap-2.5'>
        {/* 1. 紧凑业务身份带 (Hero Banner) */}
        <RunHeroBanner
          run={run}
          connection={connection}
          onRefresh={refresh}
          onCancel={() => {
            setBusy(true)
            void cancelRun(runId)
              .then(() => {
                toast.success('已取消')
                refresh()
              })
              .catch((error) => {
                toast.error(error instanceof ApiRequestError ? error.message : '取消失败')
              })
              .finally(() => setBusy(false))
          }}
          onDelete={() => setRemoving(true)}
          onCreateNew={() => {
            if (run.scenarioVersionKind === 'trial') {
              void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId: run.scenarioId } })
              return
            }
            setCreateOpen(true)
          }}
          busy={busy}
          canCancel={canCancel}
          canDelete={canDelete}
        />

        {/* 2. 调度放置提示 (PlacementHint) */}
        <PlacementHint
          placement={run.placement}
          targetId={run.targetId}
          accountId={run.targetAccountId}
        />

        {/* 3. 运行前失败提示与运行级证据 */}
        {run.status === 'FAILED' && run.stepRuns.every((step) => step.attempts.length === 0) ? (
          <p className='text-body text-status-warning-foreground font-medium shrink-0'>
            {evidenceItems.some((item) => !item.attemptId)
              ? '运行在步骤开始前失败。原因见运行级证据。'
              : '运行在步骤开始前失败，没有留下 Attempt 证据。常见原因是浏览器步骤未指定目标账号，或会话配置不被支持。'}
          </p>
        ) : null}

        {runLevel.length > 0 ? (
          <div className='rounded-lg border border-border-card bg-card p-4 shadow-card shrink-0 space-y-2'>
            <h2 className='text-body font-semibold text-foreground'>运行级证据</h2>
            <p className='text-label text-muted-foreground'>
              这些证据在第一个步骤执行前产生（例如参数校验、调度错误或全局准备失败）。
            </p>
            <div className='mt-2'>
              <AttemptEvidenceList runId={run.id} items={runLevel} />
            </div>
          </div>
        ) : null}

        {/* 4. 认证恢复 Checkpoint 提示 */}
        {run.authCheckpoint ? (
          <div className='space-y-2 rounded-lg border border-border-card bg-muted/40 p-4 shadow-card shrink-0'>
            <p className='text-body font-medium'>
              {run.status === 'NEEDS_REVIEW'
                ? '操作结果待核查，请先确认业务结果'
                : run.authCheckpoint.status === 'recovering'
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
            {run.authCheckpoint.status === 'unrecoverable' && run.status !== 'NEEDS_REVIEW' ? (
              <Can allOf={RUN_EXECUTE_ALL_OF}>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => {
                    if (run.scenarioVersionKind === 'trial') {
                      void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId: run.scenarioId } })
                      return
                    }
                    setCreateOpen(true)
                  }}
                >
                  {run.scenarioVersionKind === 'trial' ? '新建完整试跑' : '新建运行'}
                </Button>
              </Can>
            ) : null}
          </div>
        ) : null}

        {/* 5. 异常干预横幅：NEEDS_REVIEW 人工核查 */}
        {run.status === 'NEEDS_REVIEW' ? (
          <Can permission='run:review'>
            <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border border-status-warning-foreground/30 bg-status-warning-background/25 px-4 py-2.5 shadow-xs shrink-0'>
              <div className='flex items-center gap-2'>
                <AlertTriangle className='size-4 text-status-warning-foreground shrink-0' />
                <span className='font-semibold text-label text-status-warning-foreground'>操作结果待核查：</span>
                <span className='text-label text-foreground'>
                  操作已提交但连接或状态未明，请核实目标系统后判定结果。
                </span>
              </div>
              <div className='flex items-center gap-2'>
                <Label htmlFor='review-note' className='text-label font-medium shrink-0'>
                  核查说明
                </Label>
                <Input
                  id='review-note'
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder='可选说明，写入控制台审计'
                  className='h-7.5 w-48 text-caption bg-background'
                />
                <Button
                  size='sm'
                  className='h-7 text-label'
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    void reviewRun(runId, { conclusion: 'fail', note: note || undefined })
                      .then(() => {
                        toast.success('已判定失败')
                        refresh()
                      })
                      .catch((e) => toast.error(e instanceof ApiRequestError ? e.message : '核查失败'))
                      .finally(() => setBusy(false))
                  }}
                >
                  判定失败
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  className='h-7 text-label'
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    void reviewRun(runId, { conclusion: 'cancel', note: note || undefined })
                      .then(() => {
                        toast.success('已判定取消')
                        refresh()
                      })
                      .catch((e) => toast.error(e instanceof ApiRequestError ? e.message : '核查失败'))
                      .finally(() => setBusy(false))
                  }}
                >
                  判定取消
                </Button>
              </div>
            </div>
          </Can>
        ) : null}

        {/* 6. 草稿试跑调试暂停控制条 */}
        {run.scenarioVersionKind === 'trial' && run.debugMode !== 'runThrough' ? (
          <div className='shrink-0'>
            <DebugHoldBar run={run} onChanged={refresh} />
          </div>
        ) : null}

        {/* 5. 主复盘工作台：视口锁定双栏联动布局 */}
        <div className='flex flex-1 min-h-0 gap-3 overflow-hidden'>
          {/* 左栏：步骤流水线导轨 (Step Rail) */}
          <div className='w-[310px] md:w-[340px] xl:w-[370px] shrink-0 h-full overflow-hidden'>
            {(() => {
              const focus = resolveRunEvidenceFocus(run, evidenceItems, search)
              return (
                <StepRail
                  run={run}
                  evidenceItems={evidenceItems}
                  selectedStepRunId={currentStepRunId}
                  selectedAttemptId={selectedAttemptId}
                  currentPlayingStepRunId={currentPlayingStepRunId}
                  focusInvocationId={search.invocation}
                  focusStepRunId={focus.mismatch ? undefined : focus.stepRunId}
                  focusAttemptId={focus.mismatch ? undefined : focus.attemptId ?? selectedAttemptId ?? undefined}
                  focusEvidenceId={focus.mismatch ? undefined : focus.evidenceId}
                  onSelectStep={handleSelectStep}
                />
              )
            })()}
          </div>

          {/* 右栏：伴随媒体视口 + 步骤多维检视器 */}
          <div className='flex flex-1 min-w-0 flex-col h-full overflow-hidden gap-2.5'>
            {/* 上部：媒体视口 (录像或实时流) */}
            <MediaViewport
              run={run}
              evidenceItems={evidenceItems}
              currentStepRunId={currentPlayingStepRunId}
              onChapterChange={setCurrentPlayingStepRunId}
              seekRequest={seekRequest}
              onSelectStep={handleSelectStep}
              eventSeq={eventSeq}
              onRunChanged={refresh}
            />

            {/* 下部：多维检视工作台 */}
            <div className='flex-1 min-h-0 overflow-hidden'>
              <StepInspector
                run={run}
                step={selectedStep}
                selectedAttemptId={selectedAttemptId}
                evidenceItems={evidenceItems}
                eventSeq={eventSeq}
                onFocusEvidence={(evidenceId) => {
                  void navigate({
                    search: ((prev: Record<string, unknown>) => ({ ...prev, evidence: evidenceId })) as any,
                  })
                }}
              />
            </div>
          </div>
        </div>
      </Main>

      {/* 弹窗支持：新建/重新运行弹窗 */}
      {createOpen ? (
        <RunCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          defaultScenarioId={run.scenarioId}
          defaultTargetId={run.targetId}
        />
      ) : null}

      {/* 弹窗支持：删除确认弹窗 */}
      <ResourceDeleteDialog
        open={removing}
        onOpenChange={setRemoving}
        resourceId={runId}
        resourceName={run ? `${run.scenarioName} (${run.id.slice(0, 8)})` : runId}
        resourceType='run'
        previewFn={() => previewDeleteRun(runId)}
        deleteFn={(body) => deleteRun(runId, body)}
        onSuccess={() => {
          setRemoving(false)
          void navigate({ to: '/runs' })
        }}
      />
    </>
  )
}
