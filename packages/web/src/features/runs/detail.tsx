import { RunCreateDialog } from './create-dialog'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { isFinishedRunStatus, RUN_EXECUTE_ALL_OF } from '@cairn/shared'
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
import { AttemptEvidenceList } from './evidence-viewer'
import { OutcomeConditionList } from './outcome-axis'
import { BrowserView } from './browser-view'
import { RunVideoSection } from './run-video'
import { RunMapClues } from '@/features/map/run-clues'
import { RunMapConsumption, RunMapDecisions } from './map-decisions'
import { PlacementHint } from './placement-hint'
import { DebugHoldBar } from './debug-hold-bar'
import { StepTimeline } from './step-timeline'
import { resolveRunEvidenceFocus } from './evidence-focus'
import { useAssistantStore } from '@/stores/assistant-store'
import { RunMetricStrip } from './run-metric-strip'
import { ReportPanel } from '@/features/reports/panel'
import { AlertTriangle, ArrowLeft, Copy, ListOrdered, Target } from 'lucide-react'

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
    enabled: runQuery.isError,
  })
  const deletedView = runQuery.isError && !run && cleanupQuery.isSuccess

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          parent={
            <Link
              to='/runs'
              className='inline-flex items-center gap-1.5 hover:text-link'
            >
              <ArrowLeft className='size-4' />
              返回运行记录
            </Link>
          }
          title='运行详情'
          description='业务状态、步骤时间线与结构化证据。实时通道只提示变化，刷新仍从数据库恢复。'
          actions={
            <div className='flex items-center gap-2'>
              <StatusBadge tone={connectionTone(connection)}>{connectionLabel(connection)}</StatusBadge>
              <Button variant='outline' onClick={() => void refresh()}>
                刷新
              </Button>
              <Button variant='outline' asChild>
                <Link to='/evidence' search={{ runId, tab: 'search' }}>
                  在证据与报告中查看
                </Link>
              </Button>
              {run?.suiteRunId ? (
                <Button variant='outline' asChild>
                  <Link to='/suite-runs/$suiteRunId' params={{ suiteRunId: run.suiteRunId }}>
                    所属场景集运行
                  </Link>
                </Button>
              ) : null}
              <Can allOf={['notification:read']}><Button variant='outline' asChild><Link to='/notifications' search={{ tab: 'records', runId }}>通知记录</Link></Button></Can>
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
              返回运行记录
            </Button>
          </section>
        ) : runQuery.isError || !run ? (
          <QueryErrorState title='无法加载运行' onRetry={refresh} />
        ) : (
          <div className='space-y-5'>
            {/* 1. 全局 4 列健康指标条 */}
            <RunMetricStrip run={run} />

            {/* 2. 调度提示与地图消费说明 */}
            <PlacementHint
              placement={run.placement}
              targetId={run.targetId}
              accountId={run.targetAccountId}
            />
            <RunMapConsumption frozen={run.snapshot.mapConsumption} />

            {/* 4. 认证恢复 Checkpoint 提示 */}
            {run.authCheckpoint ? (
              <div className='space-y-2 rounded-lg border border-border-card bg-muted/40 p-4 shadow-card'>
                <p className='text-body font-medium'>
                  {run.status === 'NEEDS_REVIEW'
                    ? '操作结果待核查，请先确认业务结果'
                    : run.authCheckpoint.status === 'recovering'
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
                <p className='text-label text-muted-foreground'>
                  恢复位置：第 {run.authCheckpoint.nextOrdinal + 1} 步 ·{' '}
                  {run.snapshot.steps.find((step) => step.id === run.authCheckpoint?.nextStepId)?.name ??
                    run.authCheckpoint.nextStepId}
                </p>
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

            {/* 5. NEEDS_REVIEW 核查横幅 */}
            {run.status === 'NEEDS_REVIEW' ? (
              <Can permission='run:review'>
                <div className='space-y-3 rounded-lg border border-status-warning-foreground/30 bg-status-warning-background/15 p-5 shadow-card'>
                  <div className='flex items-center gap-2 text-status-warning-foreground'>
                    <AlertTriangle className='size-5' />
                    <h2 className='text-section font-semibold'>操作结果待核查</h2>
                  </div>
                  <p className='text-body text-muted-foreground'>
                    操作已提交但连接或状态未明，无法证明业务已完成。请先确认目标系统订单或记录状态，再判定本次运行。
                  </p>
                  <div className='space-y-2'>
                    <Label htmlFor='review-note'>核查说明</Label>
                    <Input
                      id='review-note'
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder='可选说明，写入控制台审计'
                      className='bg-background max-w-xl'
                    />
                  </div>
                  <div className='flex gap-2 pt-1'>
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

            {/* 6. 受管浏览器视口与录像视口 */}
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

            {/* 7. 运行级证据（如果在步骤开始前产生，或属于整个运行） */}
            {(() => {
              const runLevel = evidenceItems.filter((item) => !item.attemptId && item.type !== 'video')
              return runLevel.length > 0 ? (
                <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
                  <h2 className='text-section font-semibold'>运行级证据</h2>
                  <AttemptEvidenceList runId={run.id} items={runLevel} />
                </section>
              ) : null
            })()}

            {/* 8. 双栏协作复盘工作台 */}
            <div className='grid grid-cols-1 items-start gap-5 lg:grid-cols-12'>
              {/* 左栏：步骤时间线流水 (7 cols) */}
              <div className='space-y-4 lg:col-span-7 xl:col-span-7'>
                <section className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
                  <div className='flex items-center justify-between pb-3 border-b border-border-divider'>
                    <h2 className='flex items-center gap-2 text-section font-semibold'>
                      <ListOrdered className='size-4 text-primary' />
                      步骤时间线
                    </h2>
                    <span className='text-label text-muted-foreground'>
                      共 {run.stepRuns.length} 步
                    </span>
                  </div>
                  {runQuery.isPending ? (
                    <p className='mt-3 text-label text-muted-foreground'>证据加载中…</p>
                  ) : runQuery.isError ? (
                    <div className='mt-3'>
                      <QueryErrorState title='无法加载证据' onRetry={() => void refresh()} />
                    </div>
                  ) : null}
                  {run.status === 'FAILED' && run.stepRuns.every((step) => step.attempts.length === 0) ? (
                    <p className='mt-3 text-body text-status-warning-foreground font-medium'>
                      {evidenceItems.some((item) => !item.attemptId)
                        ? '运行在步骤开始前失败。原因见运行级证据。'
                        : '运行在步骤开始前失败，没有留下 Attempt 证据。常见原因是浏览器步骤未指定目标账号，或会话配置不被支持。'}
                    </p>
                  ) : null}
                  <div className='mt-4'>
                    {(() => {
                      const focus = resolveRunEvidenceFocus(run, evidenceItems, search)
                      return (
                        <>
                          {focus.mismatch ? (
                            <p className='mb-3 text-label text-status-warning-foreground'>
                              深链指向的步骤或证据不属于本次运行，未自动定位。
                            </p>
                          ) : null}
                          <StepTimeline
                            run={run}
                            evidenceItems={evidenceItems}
                            focusInvocationId={search.invocation}
                            focusStepRunId={focus.mismatch ? undefined : focus.stepRunId}
                            focusAttemptId={focus.mismatch ? undefined : focus.attemptId}
                            focusEvidenceId={focus.mismatch ? undefined : focus.evidenceId}
                          />
                        </>
                      )
                    })()}
                  </div>
                </section>
              </div>

              {/* 右栏：成功条件判定、地图决策与 Context (5 cols) */}
              <div className='space-y-4 lg:col-span-5 xl:col-span-5'>
                {/* 成功条件判定卡片 */}
                <section className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
                  <h2 className='flex items-center gap-2 text-section font-semibold'>
                    <Target className='size-4 text-primary' />
                    成功条件
                  </h2>
                  <div className='mt-3'>
                    <OutcomeConditionList runId={run.id} run={run} evidenceItems={evidenceItems} />
                  </div>
                </section>

                {/* 地图决策与线索 */}
                <RunMapClues targetId={run.targetId} runId={run.id} />
                <RunMapDecisions key={run.id} runId={run.id} eventSeq={eventSeq} steps={run.stepRuns} />

                {/* Context 卡片 */}
                <section className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
                  <div className='flex items-center justify-between'>
                    <h2 className='text-section font-semibold'>Context</h2>
                    <Button
                      variant='ghost'
                      size='sm'
                      className='h-7 px-2 text-label'
                      onClick={() => {
                        void navigator.clipboard.writeText(JSON.stringify(run.context, null, 2))
                        toast.success('已复制 Context')
                      }}
                    >
                      <Copy className='mr-1 size-3' />
                      复制
                    </Button>
                  </div>
                  <div className='mt-3 rounded-md border border-border-card/60 bg-muted/40 p-3'>
                    <pre className='overflow-x-auto text-label font-mono'>{JSON.stringify(run.context, null, 2)}</pre>
                  </div>
                </section>
                <ReportPanel subject={{ kind: 'RUN', runId: run.id }} />
              </div>
            </div>
          </div>
        )}
      </Main>
      {run && createOpen ? (
        <RunCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          defaultScenarioId={run.scenarioId}
          defaultTargetId={run.targetId}
        />
      ) : null}
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
