import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { fetchReport } from '@/lib/reports-api'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ReportPanel } from './panel'

export function ReportDetailPage() {
  const { reportId } = useParams({ from: '/_authenticated/reports/$reportId/' })
  const report = useQuery({
    queryKey: ['report', reportId],
    queryFn: () => fetchReport(reportId),
  })
  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <PageHeader
        title='运行报告'
        description='查看固定修订、导出进度和交付文件。'
        parent={
          <Link
            to='/evidence'
            search={{ tab: 'reports' }}
            className='text-link'
          >
            返回证据与报告
          </Link>
        }
      />
      {report.isPending ? (
        <PageSkeleton />
      ) : report.isError || !report.data ? (
        <QueryErrorState
          title='报告已删除或不可访问'
          onRetry={() => void report.refetch()}
        />
      ) : (
        <>
          {report.data.subject.kind === 'RUN' ? (
            <Link
              className='text-body text-link'
              to='/runs/$runId'
              params={{ runId: report.data.subject.runId }}
            >
              查看来源运行
            </Link>
          ) : (
            <Link
              className='text-body text-link'
              to='/suite-runs/$suiteRunId'
              params={{ suiteRunId: report.data.subject.suiteRunId }}
            >
              查看来源集合运行
            </Link>
          )}
          <ReportPanel
            subject={report.data.subject}
            initialReport={report.data}
          />
        </>
      )}
    </Main>
  )
}
