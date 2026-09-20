import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { suiteRunObservationSchema } from '@cairn/shared'
import { ArrowLeft } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { subscribeObservation } from '@/lib/observation-stream'
import { cancelSuiteRun, fetchSuiteRun } from '@/lib/suites-api'
import { useCan } from '@/hooks/use-permissions'
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
            <Button variant='outline' asChild>
              <Link to='/evidence' search={{ suiteRunId, tab: 'search' }}>
                在证据与报告中查看
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
          <section className='grid gap-3 rounded-lg border border-border-card bg-card p-5 shadow-card sm:grid-cols-4'>
            <div>
              <p className='text-label text-muted-foreground'>计划成员</p>
              <p className='text-title'>{run.counts.planned}</p>
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
              <p className='text-label text-muted-foreground'>失败策略</p>
              <p className='text-title'>
                {run.failurePolicy === 'stop' ? '失败即停' : '失败继续'}
              </p>
            </div>
          </section>
          <p className='text-label text-muted-foreground'>
            成员间隙不预留账号，独立运行可能插入并延长墙钟时间。读取时间{' '}
            {new Date(run.readAt).toLocaleString()}。
          </p>
          <section className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>成员</TableHead>
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
                      <div className='font-medium'>{item.displayName}</div>
                      <div className='text-label text-muted-foreground'>
                        {item.memberId}
                      </div>
                    </TableCell>
                    <TableCell>
                      {SUITE_ADMISSION_LABELS[item.admission]}
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
                      <Button variant='outline' size='sm' asChild>
                        <Link
                          to='/runs/$runId'
                          params={{ runId: item.childRunId }}
                        >
                          打开子运行
                        </Link>
                      </Button>
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
          <ReportPanel subject={{ kind: 'SUITE_RUN', suiteRunId }} />
        </>
      )}
    </Main>
  )
}
