import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { Share2, Check } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useBreadcrumb } from '@/stores/breadcrumb-store'
import { createReportShareToken, fetchReport, fetchReportRevision } from '@/lib/reports-api'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ReportPanel } from './panel'
import { SuiteReportView } from './suite-report-view'

export function ReportDetailPage() {
  const { reportId } = useParams({ from: '/_authenticated/reports/$reportId/' })
  const report = useQuery({
    queryKey: ['report', reportId],
    queryFn: () => fetchReport(reportId),
  })

  useBreadcrumb({
    entityId: reportId,
    title: report.data?.currentRevision?.title || '运行报告',
  })
  const currentRevisionId = report.data?.currentRevision?.id
  const revisionDetail = useQuery({
    queryKey: ['report-revision', reportId, currentRevisionId],
    queryFn: () => fetchReportRevision(reportId, currentRevisionId!),
    enabled: Boolean(reportId && currentRevisionId),
  })

  const [sharing, setSharing] = useState(false)
  const [copied, setCopied] = useState(false)

  const handleShare = async () => {
    try {
      setSharing(true)
      const res = await createReportShareToken(reportId)
      const fullUrl = `${window.location.origin}${res.url}`
      await navigator.clipboard.writeText(fullUrl)
      setCopied(true)
      toast.success('免登录只读分享链接已复制到剪贴板（24小时内有效）')
      setTimeout(() => setCopied(false), 3000)
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : '生成分享链接失败')
    } finally {
      setSharing(false)
    }
  }

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-6'>
      <PageHeader
        title='运行报告'
        description='查看固定修订、导出进度和交付文件。'
        parent={
          <Link
            to='/runs'
            search={{ view: 'reports' }}
            className='text-link'
          >
            返回报告列表
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
          <div className='flex items-center justify-between gap-4'>
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

            {report.data.subject.kind === 'SUITE_RUN' && (
              <Button
                variant='outline'
                size='sm'
                onClick={handleShare}
                disabled={sharing}
                className='gap-2'
              >
                {copied ? <Check className='size-4 text-status-success-foreground' /> : <Share2 className='size-4' />}
                {copied ? '链接已复制' : sharing ? '生成中...' : '分享只读报告'}
              </Button>
            )}
          </div>
          {revisionDetail.data?.document ? (
            <SuiteReportView document={revisionDetail.data.document} />
          ) : null}
          <ReportPanel
            subject={report.data.subject}
            initialReport={report.data}
          />
        </>
      )}
    </Main>
  )
}
