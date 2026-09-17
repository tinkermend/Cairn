import { RunCreateDialog } from './create-dialog'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { isFinishedRunStatus, RUN_EXECUTE_ALL_OF, resolveEvidencePolicy } from '@cairn/shared'
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
import { connectionLabel, connectionTone, useRunObservation } from './use-run-observation'
import { CleanupStatusIndicator } from '@/components/cleanup-status-indicator'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { Can } from '@/components/rbac/can'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  CAPTURE_MODE_LABELS,
  RUN_EVIDENCE_STATUS_LABELS,
  RUN_STATUS_LABELS,
  runEvidenceStatusTone,
  runStatusTone,
} from './labels'
import { AttemptEvidenceList } from './evidence-viewer'
import { OutcomeAxisSummary, OutcomeConditionList, RUN_EXECUTION_AXIS_LABELS } from './outcome-axis'
import { CatalogName } from './catalog-name'
import { BrowserView } from './browser-view'
import { RunVideoSection } from './run-video'
import { RunMapClues } from '@/features/map/run-clues'
import { RunMapConsumption, RunMapDecisions } from './map-decisions'
import { PlacementHint } from './placement-hint'
import { DebugHoldBar } from './debug-hold-bar'
import { StepTimeline } from './step-timeline'
import { useAssistantStore } from '@/stores/assistant-store'

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
  const evidenceItems = evidence?.items ?? []
  const openAssistant = useAssistantStore((state) => state.openPanel)
  const finished = Boolean(run && isFinishedRunStatus(run.status))
  const cleanupQuery = useQuery({
    queryKey: ['runs', runId, 'cleanup'],
    queryFn: () => fetchRunCleanup(runId),
    enabled: finished || runQuery.isError,
  })
  const deletedView = runQuery.isError && !run && cleanupQuery.isSuccess

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='运行详情'
          description='业务状态、步骤时间线与结构化证据。实时通道只提示变化，刷新仍从数据库恢复。'
          actions={
            <div className='flex items-center gap-2'>
              <StatusBadge tone={connectionTone(connection)}>{connectionLabel(connection)}</StatusBadge>
              <Button variant='outline' onClick={() => void refresh()}>
                刷新
              </Button>
              <Can allOf={['ai:assist', 'run:read', 'target:read']}>
                <Button
                  variant='outline'
                  onClick={() =>
                    openAssistant({
                      question: '分析本次运行',
                      capabilityHint: 'run.diagnose',
                      pageContext: { page: 'run', runId },
                    })
                  }
                >
                  分析本次运行
                </Button>
              </Can>
              {run && !isFinishedRunStatus(run.status) && run.status !== 'NEEDS_REVIEW' ? (
                <Can permission='run:cancel'>
                  <Button
                    variant={run.status === 'WAITING_FOR_AUTH' ? 'outline' : 'destructive'}
                    disabled={busy}
                    onClick={() => {
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
                  >
                    取消
                  </Button>
                </Can>
              ) : null}
              {finished ? (
                <Can permission='run:delete'>
                  <Button variant='ghost' className='text-destructive' onClick={() => setRemoving(true)}>
                    删除
                  </Button>
                </Can>
              ) : null}
            </div>
          }
        />
        {runQuery.isPending ? (
          <PageSkeleton />
        ) : deletedView && cleanupQuery.data ? (
          <section className='space-y-4 rounded-lg border border-border-card bg-card p-5 shadow-card'>
            <p className='text-body'>运行已删除。业务记录不可访问，附件按清理状态处理。</p>
            <CleanupStatusIndicator
              status={cleanupQuery.data}
              onRetry={canDelete ? () => retryRunCleanup(runId) : undefined}
              onStatusUpdated={() => void cleanupQuery.refetch()}
            />
            <Button variant='outline' onClick={() => void navigate({ to: '/runs' })}>
              返回运行列表
            </Button>
          </section>
        ) : runQuery.isError || !run ? (
          <QueryErrorState title='无法加载运行' onRetry={refresh} />
        ) : (
          <div className='space-y-5'>
            <section className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
              <div className='flex flex-wrap items-center gap-2'>
                <StatusBadge tone={runStatusTone(run.status)}>{RUN_STATUS_LABELS[run.status]}</StatusBadge>
                <StatusBadge tone={runEvidenceStatusTone(run.evidenceStatus, run.status)}>
                  {RUN_EVIDENCE_STATUS_LABELS[run.evidenceStatus]}
                </StatusBadge>
                {run.scenarioVersionKind === 'trial' ? (
                  <StatusBadge tone='warning'>试跑</StatusBadge>
                ) : (
                  <StatusBadge tone='neutral'>正式</StatusBadge>
                )}
              </div>
              <div className='mt-4'>
                <OutcomeAxisSummary
                  executionLabel={RUN_EXECUTION_AXIS_LABELS[run.status]}
                  outcomeStatus={run.outcomeStatus}
                />
              </div>
              <p className='mt-3 text-body text-muted-foreground'>
                {run.source?.kind === 'service' ? '服务 API 调用 · ' : ''}场景{' '}
                <CatalogName name={run.scenarioName} deleted={run.scenarioDeleted}>
                  <Link
                    to='/scenarios/$scenarioId'
                    params={{ scenarioId: run.scenarioId }}
                    className='text-primary hover:underline'
                  >
                    {run.scenarioName}
                  </Link>
                </CatalogName>
                {' · '}
                目标系统{' '}
                <CatalogName name={run.targetName} deleted={run.targetDeleted}>
                  <Link
                    to='/targets/$targetId'
                    params={{ targetId: run.targetId }}
                    className='text-primary hover:underline'
                  >
                    {run.targetName}
                  </Link>
                </CatalogName>
                {run.targetAccountName
                  ? ` · 目标账号 ${run.targetAccountName}${run.targetAccountDeleted ? '（已删除）' : ''}`
                  : ''}
              </p>
              {(() => {
                const policy = resolveEvidencePolicy(run.snapshot.evidencePolicy)
                return (
                  <p className='mt-2 text-label text-muted-foreground'>
                    本次采集：截图 {CAPTURE_MODE_LABELS[policy.screenshot]} · 录像{' '}
                    {policy.video === 'always' ? '始终' : '关闭'} · Trace{' '}
                    {CAPTURE_MODE_LABELS[policy.trace]}
                  </p>
                )
              })()}
              {cleanupQuery.data ? (
                <div className='mt-3'>
                  <CleanupStatusIndicator
                    status={cleanupQuery.data}
                    onRetry={canDelete ? () => retryRunCleanup(runId) : undefined}
                    onStatusUpdated={() => void cleanupQuery.refetch()}
                  />
                </div>
              ) : null}
              {run.lease ? (
                <p className='mt-2 text-label text-muted-foreground'>
                  执行租约 Worker {run.lease.holderWorkerId} · fencing {run.lease.fencingToken}
                </p>
              ) : (
                <p className='mt-2 text-label text-muted-foreground'>当前没有执行租约</p>
              )}
              <PlacementHint
                placement={run.placement}
                targetId={run.targetId}
                accountId={run.targetAccountId}
              />
              <RunMapConsumption frozen={run.snapshot.mapConsumption} />
              {run.snapshot.authVerification ? (
                <p className='mt-2 text-label text-muted-foreground'>
                  登录核验{' '}
                  {run.snapshot.authVerification.capability === 'IDENTITY_VERIFIED'
                    ? '身份已核验'
                    : run.snapshot.authVerification.capability === 'LOGIN_VERIFIED'
                      ? '登录已核验'
                      : '旧模式'}
                  {run.snapshot.authVerification.profileRevision
                    ? ` · 规则修订 ${run.snapshot.authVerification.profileRevision}`
                    : ''}
                  {` · 新鲜度 ${run.snapshot.authVerification.freshnessSeconds} 秒`}
                </p>
              ) : (
                <p className='mt-2 text-label text-muted-foreground'>历史运行未冻结核验规则，按旧模式解释。</p>
              )}
              {run.authCheckpoint ? (
                <div className='mt-3 space-y-2 rounded-md border border-border-card bg-muted/30 p-3'>
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
                  {run.authCheckpoint.status === 'unrecoverable' && run.status !== 'NEEDS_REVIEW' ? (
                    <Can allOf={RUN_EXECUTE_ALL_OF}>
                    <Button
                      variant='outline'
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
              {run.status === 'NEEDS_REVIEW' ? (
                <Can permission='run:review'>
                  <div className='mt-4 space-y-3'>
                    <Label htmlFor='review-note'>核查说明</Label>
                    <Input
                      id='review-note'
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder='可选说明，写入控制台审计'
                    />
                    <div className='flex gap-2'>
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setBusy(true)
                          void reviewRun(runId, { conclusion: 'fail', note: note || undefined })
                            .then(() => {
                              toast.success('已判定失败')
                              refresh()
                            })
                            .catch((error) => {
                              toast.error(error instanceof ApiRequestError ? error.message : '核查失败')
                            })
                            .finally(() => setBusy(false))
                        }}
                      >
                        判定失败
                      </Button>
                      <Button
                        variant='outline'
                        disabled={busy}
                        onClick={() => {
                          setBusy(true)
                          void reviewRun(runId, { conclusion: 'cancel', note: note || undefined })
                            .then(() => {
                              toast.success('已判定取消')
                              refresh()
                            })
                            .catch((error) => {
                              toast.error(error instanceof ApiRequestError ? error.message : '核查失败')
                            })
                            .finally(() => setBusy(false))
                        }}
                      >
                        判定取消
                      </Button>
                    </div>
                  </div>
                </Can>
              ) : null}
            </section>
            <BrowserView
              runId={runId}
              runStatus={run.status}
              eventSeq={eventSeq}
              onRunChanged={refresh}
            />
            <RunVideoSection run={run} items={evidenceItems} />
            {run.scenarioVersionKind === 'trial' && run.debugMode !== 'runThrough' ? (
              <DebugHoldBar run={run} onChanged={refresh} />
            ) : null}

            <RunMapClues targetId={run.targetId} runId={run.id} />
            <RunMapDecisions key={run.id} runId={run.id} eventSeq={eventSeq} steps={run.stepRuns} />
            {(() => {
              const runLevel = evidenceItems.filter((item) => !item.attemptId && item.type !== 'video')
              return runLevel.length > 0 ? (
                <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
                  <h2 className='text-section font-semibold'>运行级证据</h2>
                  <AttemptEvidenceList runId={run.id} items={runLevel} />
                </section>
              ) : null
            })()}

            <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
              <h2 className='text-section font-semibold'>成功条件</h2>
              <OutcomeConditionList runId={run.id} run={run} evidenceItems={evidenceItems} />
            </section>

            <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
              <h2 className='text-section font-semibold'>步骤时间线</h2>
              {runQuery.isPending ? (
                <p className='text-label text-muted-foreground'>证据加载中…</p>
              ) : runQuery.isError ? (
                <QueryErrorState title='无法加载证据' onRetry={() => void refresh()} />
              ) : null}
              {run.status === 'FAILED' && run.stepRuns.every((step) => step.attempts.length === 0) ? (
                <p className='text-body text-status-warning-foreground'>
                  {evidenceItems.some((item) => !item.attemptId)
                    ? '运行在步骤开始前失败。原因见运行级证据。'
                    : '运行在步骤开始前失败，没有留下 Attempt 证据。常见原因是浏览器步骤未指定目标账号，或会话配置不被支持。'}
                </p>
              ) : null}
              <StepTimeline run={run} evidenceItems={evidenceItems} focusInvocationId={search.invocation} />
            </section>

            <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
              <h2 className='text-section font-semibold'>Context</h2>
              <pre className='overflow-x-auto text-label'>{JSON.stringify(run.context, null, 2)}</pre>
            </section>

          </div>
        )}
      </Main>
      {run && createOpen ? <RunCreateDialog open={createOpen} onOpenChange={setCreateOpen} defaultScenarioId={run.scenarioId} defaultTargetId={run.targetId} /> : null}
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
