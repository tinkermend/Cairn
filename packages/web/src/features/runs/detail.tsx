import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { isFinishedRunStatus, resolveEvidencePolicy, type ExecutableStepType } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { cancelRun, fetchRun, fetchRunEvidence, resumeRunAuth, reviewRun } from '@/lib/runs-api'
import { AppHeader } from '@/components/layout/app-header'
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
  ATTEMPT_STATUS_LABELS,
  CAPTURE_MODE_LABELS,
  PLACEMENT_COPY,
  RUN_EVIDENCE_STATUS_LABELS,
  RUN_STATUS_LABELS,
  STEP_RUN_STATUS_LABELS,
  STEP_TYPE_LABELS,
  formatDuration,
  runEvidenceStatusTone,
  runStatusTone,
  stepRunStatusTone,
} from './labels'
import { AttemptEvidenceList } from './evidence-viewer'

export function RunDetailPage() {
  const { runId } = useParams({ from: '/_authenticated/runs/$runId/' })
  const runQuery = useQuery({ queryKey: ['runs', runId], queryFn: () => fetchRun(runId) })
  const evidenceQuery = useQuery({
    queryKey: ['runs', runId, 'evidence'],
    queryFn: () => fetchRunEvidence(runId),
  })
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const run = runQuery.data

  function refresh() {
    void runQuery.refetch()
    void evidenceQuery.refetch()
  }

  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='运行详情'
          description='业务状态、步骤时间线与结构化证据。刷新只走 GET，页面没有自动轮询。'
          actions={
            <div className='flex items-center gap-2'>
              <Button variant='outline' onClick={refresh}>
                刷新
              </Button>
              {run && !isFinishedRunStatus(run.status) && run.status !== 'NEEDS_REVIEW' ? (
                <Can permission='run:cancel'>
                  <Button
                    variant='destructive'
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
            </div>
          }
        />
        {runQuery.isPending ? (
          <PageSkeleton />
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
              <p className='mt-3 text-body text-muted-foreground'>
                场景{' '}
                <Link
                  to='/scenarios/$scenarioId'
                  params={{ scenarioId: run.scenarioId }}
                  className='text-primary hover:underline'
                >
                  {run.scenarioName}
                </Link>
                {' · '}
                目标系统{' '}
                <Link
                  to='/targets/$targetId'
                  params={{ targetId: run.targetId }}
                  className='text-primary hover:underline'
                >
                  {run.targetName}
                </Link>
                {run.targetAccountName ? ` · 目标账号 ${run.targetAccountName}` : ''}
              </p>
              {(() => {
                const policy = resolveEvidencePolicy(run.snapshot.evidencePolicy)
                return (
                  <p className='mt-2 text-label text-muted-foreground'>
                    本次采集：截图 {CAPTURE_MODE_LABELS[policy.screenshot]} · Trace{' '}
                    {CAPTURE_MODE_LABELS[policy.trace]}
                  </p>
                )
              })()}
              {run.lease ? (
                <p className='mt-2 text-label text-muted-foreground'>
                  执行租约 Worker {run.lease.holderWorkerId} · fencing {run.lease.fencingToken}
                </p>
              ) : (
                <p className='mt-2 text-label text-muted-foreground'>当前没有执行租约</p>
              )}
              {run.placement.state === 'session_lost' ||
              run.placement.state === 'owner_required' ||
              run.placement.state === 'owner_at_capacity' ||
              run.placement.state === 'session_not_ready' ? (
                <p
                  className={
                    run.placement.state === 'session_lost'
                      ? 'mt-2 text-body text-status-warning-foreground'
                      : 'mt-2 text-body text-muted-foreground'
                  }
                >
                  {PLACEMENT_COPY[run.placement.state]}
                  {run.placement.sessionId ? ` 会话 ${run.placement.sessionId}` : ''}
                  {run.placement.ownerWorkerId ? ` · Worker ${run.placement.ownerWorkerId}` : ''}
                </p>
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
              {run.status === 'WAITING_FOR_AUTH' ? (
                <Can permission='run:execute'>
                  <div className='mt-4 space-y-3'>
                    <p className='text-body'>
                      等待的是目标系统登录，不是控制台账号。确认外部系统已登录后再放回领取。
                    </p>
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setBusy(true)
                        void resumeRunAuth(runId, { note: note || undefined })
                          .then(() => {
                            toast.success('已确认目标系统登录，等待再次领取')
                            refresh()
                          })
                          .catch((error) => {
                            toast.error(error instanceof ApiRequestError ? error.message : '恢复失败')
                          })
                          .finally(() => setBusy(false))
                      }}
                    >
                      确认目标系统已登录
                    </Button>
                  </div>
                </Can>
              ) : null}
            </section>

            {(() => {
              const runLevel = (evidenceQuery.data?.items ?? []).filter((item) => !item.attemptId)
              return runLevel.length > 0 ? (
                <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
                  <h2 className='text-section font-semibold'>运行级证据</h2>
                  <AttemptEvidenceList runId={run.id} items={runLevel} />
                </section>
              ) : null
            })()}

            <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
              <h2 className='text-section font-semibold'>步骤时间线</h2>
              {evidenceQuery.isPending ? (
                <p className='text-label text-muted-foreground'>证据加载中…</p>
              ) : evidenceQuery.isError ? (
                <QueryErrorState title='无法加载证据' onRetry={() => void evidenceQuery.refetch()} />
              ) : null}
              {run.status === 'FAILED' && run.stepRuns.every((step) => step.attempts.length === 0) ? (
                <p className='text-body text-status-warning-foreground'>
                  {(evidenceQuery.data?.items ?? []).some((item) => !item.attemptId)
                    ? '运行在步骤开始前失败。原因见运行级证据。'
                    : '运行在步骤开始前失败，没有留下 Attempt 证据。常见原因是浏览器步骤未指定目标账号，或会话配置不被支持。'}
                </p>
              ) : null}
              <ol className='space-y-3'>
                {run.stepRuns.map((step) => (
                  <li key={step.id} className='rounded-md border border-border-card p-3'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='font-medium'>
                        {step.ordinal + 1}. {step.name}
                      </span>
                      <StatusBadge tone={stepRunStatusTone(step.status)}>
                        {STEP_RUN_STATUS_LABELS[step.status]}
                      </StatusBadge>
                    </div>
                    <p className='mt-1 text-label text-muted-foreground'>
                      {step.type in STEP_TYPE_LABELS
                        ? STEP_TYPE_LABELS[step.type as ExecutableStepType]
                        : step.type}
                    </p>
                    {step.attempts.length === 0 ? (
                      <p className='mt-2 text-label text-muted-foreground'>尚未开始尝试。</p>
                    ) : null}
                    {step.attempts.map((attempt) => (
                      <div key={attempt.id} className='mt-2 rounded-sm bg-muted/40 p-2 text-label'>
                        <p>
                          Attempt #{attempt.attemptNo} · {ATTEMPT_STATUS_LABELS[attempt.status]}
                          {formatDuration(attempt.startedAt, attempt.finishedAt)
                            ? ` · ${formatDuration(attempt.startedAt, attempt.finishedAt)}`
                            : ''}
                        </p>
                        {attempt.error ? (
                          <p className='mt-1 text-destructive'>
                            {attempt.error.code}: {attempt.error.safeMessage}
                          </p>
                        ) : null}
                        <AttemptEvidenceList
                          runId={run.id}
                          items={(evidenceQuery.data?.items ?? []).filter((item) => item.attemptId === attempt.id)}
                        />
                      </div>
                    ))}
                  </li>
                ))}
              </ol>
            </section>

            <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
              <h2 className='text-section font-semibold'>Context</h2>
              <pre className='overflow-x-auto text-label'>{JSON.stringify(run.context, null, 2)}</pre>
            </section>

          </div>
        )}
      </Main>
    </>
  )
}
