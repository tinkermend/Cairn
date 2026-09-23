import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { suiteRunObservationSchema } from '@cairn/shared'
import { ArrowLeft, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { subscribeObservation } from '@/lib/observation-stream'
import { cancelSuiteRun, fetchSuiteRun, rerunSuiteItem } from '@/lib/suites-api'
import { fetchReports, fetchReportRevision } from '@/lib/reports-api'
import { useCan } from '@/hooks/use-permissions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { StatusBadge } from '@/components/status-badge'
import { ReportPanel } from '@/features/reports/panel'
import { SuiteReportView } from '@/features/reports/suite-report-view'
import { RUN_STATUS_LABELS, runStatusTone } from '@/features/runs/labels'
import {
  RUN_OUTCOME_STATUS_LABELS,
  runOutcomeStatusTone,
} from '@/features/runs/outcome-labels'
import {
  SUITE_ADMISSION_LABELS,
  SUITE_RUN_STATUS_LABELS,
  SUITE_VERDICT_LABELS,
  suiteRunStatusTone,
  suiteVerdictTone,
} from '@/features/suites/labels'

export function SuiteRunDetailPage() {
  const { suiteRunId } = useParams({
    from: '/_authenticated/suite-runs/$suiteRunId/',
  })
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['suite-run', suiteRunId],
    queryFn: () => fetchSuiteRun(suiteRunId),
  })
  useEffect(() => {
    if (!query.isSuccess) return
    const controller = new AbortController()
    void subscribeObservation({
      path: `/api/suite-runs/${suiteRunId}/events`,
      schema: suiteRunObservationSchema,
      signal: controller.signal,
      onObservation: (value) =>
        queryClient.setQueryData(['suite-run', suiteRunId], value),
      isFinished: (value) =>
        ['COMPLETED', 'CANCELLED', 'FAILED'].includes(value.status) &&
        value.evidenceStatus !== 'PENDING' &&
        value.automaticReport?.status !== 'pending',
    }).catch((error: Error) => {
      if (!controller.signal.aborted) toast.error(error.message)
    })
    return () => controller.abort()
  }, [suiteRunId, queryClient, query.isSuccess])
  const canCancel = useCan('run:cancel')
  const run = query.data
  useEffect(() => {
    if (run?.automaticReport?.status === 'created')
      void queryClient.invalidateQueries({ queryKey: ['reports'] })
  }, [run?.automaticReport?.status, queryClient])

  const reportsQuery = useQuery({
    queryKey: ['reports', { scope: 'suite_summary', suiteRunId }],
    queryFn: () => fetchReports({ scope: 'suite_summary', suiteRunId }),
    enabled: Boolean(suiteRunId),
  })
  const latestReport = reportsQuery.data?.items[0]
  const latestRevisionId = latestReport?.currentRevision?.id
  const reportRevisionQuery = useQuery({
    queryKey: ['report-revision', latestReport?.id, latestRevisionId],
    queryFn: () => fetchReportRevision(latestReport!.id, latestRevisionId!),
    enabled: Boolean(latestReport?.id && latestRevisionId),
  })

  const [rerunningMember, setRerunningMember] = useState<string | null>(null)

  async function handleRerun(memberId: string) {
    setRerunningMember(memberId)
    try {
      const res = await rerunSuiteItem(suiteRunId, { memberId })
      toast.success('已启动单项重跑')
      queryClient.setQueryData(['suite-run', suiteRunId], res.suiteRun)
      void query.refetch()
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '重跑失败')
    } finally {
      setRerunningMember(null)
    }
  }

  const failedItems = run?.items.filter(
    (i) => i.runStatus === 'FAILED' || i.outcomeStatus === 'FAIL' || i.runStatus === 'CANCELLED',
  ) ?? []

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <PageHeader
        parent={
          <Link
            to='/suite-runs'
            className='inline-flex items-center gap-1.5 hover:text-link'
          >
            <ArrowLeft className='size-4' />
            返回集合运行
          </Link>
        }
        title='场景集运行'
        description='查看整集进度、各场景结果与汇总报告。'
        actions={
          <div className='flex flex-wrap items-center gap-2'>
            {run ? (
              <StatusBadge tone={suiteRunStatusTone(run.status)}>
                {SUITE_RUN_STATUS_LABELS[run.status]}
              </StatusBadge>
            ) : null}
            {run?.verdict ? (
              <StatusBadge tone={suiteVerdictTone(run.verdict)}>
                {SUITE_VERDICT_LABELS[run.verdict]}
              </StatusBadge>
            ) : null}
            {run && ['COMPLETED', 'CANCELLED', 'FAILED'].includes(run.status) && failedItems.length > 0 ? (
              <Can permission='run:execute'>
                <Button
                  variant='outline'
                  disabled={rerunningMember !== null}
                  onClick={() => {
                    if (failedItems[0]) void handleRerun(failedItems[0].memberId)
                  }}
                >
                  <RotateCcw className='size-4 mr-1' />
                  {failedItems.length === 1 ? '只重跑失败项' : `只重跑失败项 (${failedItems.length})`}
                </Button>
              </Can>
            ) : null}
            {latestReport ? (
              <Button variant='outline' asChild>
                <Link to='/reports/$reportId' params={{ reportId: latestReport.id }}>
                  查看综合总报表
                </Link>
              </Button>
            ) : null}
            <Button variant='outline' asChild>
              <Link to='/evidence' search={{ suiteRunId, tab: 'search' }}>
                在结果与报告中查看
              </Link>
            </Button>
            {run &&
            !['COMPLETED', 'CANCELLED', 'FAILED'].includes(run.status) &&
            canCancel ? (
              <Can permission='run:cancel'>
                <Button
                  variant='destructive'
                  onClick={() => {
                    void cancelSuiteRun(suiteRunId)
                      .then(() => {
                        toast.success('已请求取消')
                        void query.refetch()
                      })
                      .catch((error) =>
                        toast.error(
                          error instanceof ApiRequestError
                            ? error.message
                            : '取消失败'
                        )
                      )
                  }}
                >
                  取消整集
                </Button>
              </Can>
            ) : null}
          </div>
        }
      />
      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError || !run ? (
        <QueryErrorState
          title='无法加载集合运行'
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          <section className='grid gap-3 rounded-lg border border-border-card bg-card p-5 shadow-card sm:grid-cols-5'>
            <div>
              <p className='text-label text-muted-foreground'>计划成员</p>
              <p className='text-title'>{run.counts.planned}</p>
            </div>
            <div>
              <p className='text-label text-muted-foreground'>执行模式</p>
              <p className='text-title'>
                {run.executionMode === 'sequential'
                  ? '严格串行'
                  : `受控并发 (上限 ${run.maxConcurrency ?? 3})`}
              </p>
            </div>
            <div>
              <p className='text-label text-muted-foreground'>
                成功 / 失败 / 跳过
              </p>
              <p className='text-title'>
                {run.counts.succeeded} / {run.counts.failed} /{' '}
                {run.counts.skipped}
              </p>
            </div>
            <div>
              <p className='text-label text-muted-foreground'>
                进行中 / 待开始
              </p>
              <p className='text-title'>
                {run.counts.active} / {run.counts.pending}
              </p>
            </div>
            <div>
              <p className='text-label text-muted-foreground'>耗时度量</p>
              <p className='text-title'>
                {run.wallClockMs != null
                  ? `${(run.wallClockMs / 1000).toFixed(1)}s`
                  : '执行中'}
                {run.childDurationMs != null && run.wallClockMs != null && run.childDurationMs > run.wallClockMs ? (
                  <span className='ml-1 text-xs font-normal text-success'>
                    (节约 {(((run.childDurationMs - run.wallClockMs) / run.childDurationMs) * 100).toFixed(0)}%)
                  </span>
                ) : null}
              </p>
            </div>
          </section>
          <p className='text-label text-muted-foreground'>
            成员间隙不预留账号，中间可能被别的运行插入，整次会更久。读取时间{' '}
            {new Date(run.readAt).toLocaleString()}。
          </p>
          <section className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>成员</TableHead>
                  <TableHead>目标账号</TableHead>
                  <TableHead>放行</TableHead>
                  <TableHead>子运行</TableHead>
                  <TableHead>业务结果</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.items.map((item) => (
                  <TableRow key={item.memberId}>
                    <TableCell>
                      <div className='flex items-center gap-2'>
                        <span className='font-medium'>{item.displayName}</span>
                        {item.stageId ? (
                          <Badge variant='outline' className='font-mono text-[10px]'>
                            Stage {item.stageOrdinal != null ? item.stageOrdinal + 1 : item.stageId}
                          </Badge>
                        ) : null}
                        {item.rerunCount && item.rerunCount > 0 ? (
                          <Badge variant='secondary' className='text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'>
                            重跑第 {item.rerunCount} 次
                          </Badge>
                        ) : null}
                      </div>
                      <div className='text-label text-muted-foreground'>
                        {item.memberId}
                      </div>
                    </TableCell>
                    <TableCell>
                      {item.targetAccountId ? (
                        <span className='font-mono text-xs text-muted-foreground' title={item.targetAccountId}>
                          {item.targetAccountId.slice(0, 8)}
                        </span>
                      ) : (
                        <span className='text-xs text-muted-foreground'>默认</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div>{SUITE_ADMISSION_LABELS[item.admission]}</div>
                      {item.skipReason ? (
                        <div className='text-xs text-muted-foreground'>{item.skipReason}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge tone={runStatusTone(item.runStatus)}>
                        {RUN_STATUS_LABELS[item.runStatus]}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={runOutcomeStatusTone(item.outcomeStatus)}
                      >
                        {RUN_OUTCOME_STATUS_LABELS[item.outcomeStatus]}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <div className='flex items-center justify-end gap-2'>
                        {item.childRunId ? (
                          <Button variant='outline' size='sm' asChild>
                            <Link
                              to='/runs/$runId'
                              params={{ runId: item.childRunId }}
                            >
                              打开子运行
                            </Link>
                          </Button>
                        ) : null}
                        {['COMPLETED', 'CANCELLED', 'FAILED'].includes(run.status) ? (
                          <Can permission='run:execute'>
                            <Button
                              variant='ghost'
                              size='sm'
                              disabled={rerunningMember !== null}
                              onClick={() => void handleRerun(item.memberId)}
                            >
                              <RotateCcw className='size-3.5 mr-1' />
                              重跑
                            </Button>
                          </Can>
                        ) : null}
                        {!item.childRunId && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(run.status) ? (
                          <span className='text-muted-foreground'>-</span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
          {run.automaticReport && (
            <p role='status' className='text-label text-muted-foreground'>
              {run.automaticReport.status === 'pending'
                ? '已启用自动报告，等待集合结束及证据收尾。'
                : run.automaticReport.status === 'created'
                  ? '自动报告已创建，文件生成进度见下方报告。'
                  : `自动报告${run.automaticReport.status === 'skipped' ? '已跳过' : '生成失败'}：${run.automaticReport.reason ?? '请手动创建报告或联系管理员检查权限。'}`}
            </p>
          )}
          {reportRevisionQuery.data?.document ? (
            <section className='space-y-4'>
              <div className='flex items-center justify-between'>
                <h2 className='text-title'>综合巡检总报表</h2>
                {latestReport ? (
                  <Link
                    to='/reports/$reportId'
                    params={{ reportId: latestReport.id }}
                    className='text-sm text-link'
                  >
                    在独立页查看完整报告
                  </Link>
                ) : null}
              </div>
              <SuiteReportView document={reportRevisionQuery.data.document} />
            </section>
          ) : null}
          <ReportPanel subject={{ kind: 'SUITE_RUN', suiteRunId }} />
        </>
      )}
    </Main>
  )
}
