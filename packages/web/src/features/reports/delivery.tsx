import { useEffect, useState } from 'react'
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  exportJobDtoSchema,
  type ExportJobDto,
  type ReportDto,
} from '@cairn/shared'
import { toast } from 'sonner'
import { subscribeObservation } from '@/lib/observation-stream'
import {
  cancelReportJob,
  createReportBundle,
  deriveMemberReport,
  downloadArtifact,
  exportReport,
  fetchExportJob,
  fetchReportJobs,
  fetchReportRevision,
  fetchReportRevisions,
  retryReportJob,
} from '@/lib/reports-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatusBadge } from '@/components/status-badge'

export function ExportJobCard({
  initial,
  id,
}: {
  initial?: ExportJobDto
  id: string
}) {
  const cache = useQueryClient(),
    canExport = useCan('report:export')
  const job = useQuery({
    queryKey: ['export-job', id],
    queryFn: () => fetchExportJob(id),
    initialData: initial,
  })
  const [busy, setBusy] = useState(false),
    [retried, setRetried] = useState<ExportJobDto>()
  useEffect(() => {
    if (!job.data || !['queued', 'running'].includes(job.data.status)) return
    const controller = new AbortController()
    void subscribeObservation({
      path: `/api/export-jobs/${id}/events`,
      schema: exportJobDtoSchema,
      signal: controller.signal,
      onObservation: (value) => {
        cache.setQueryData(['export-job', id], value)
        if (!['queued', 'running'].includes(value.status)) {
          void cache.invalidateQueries({ queryKey: ['reports'] })
          void cache.invalidateQueries({ queryKey: ['report', value.reportId] })
          void cache.invalidateQueries({ queryKey: ['report-jobs'] })
        }
      },
      isFinished: (value) => !['queued', 'running'].includes(value.status),
    }).catch((error) => {
      if (!controller.signal.aborted) toast.error(error.message)
    })
    return () => controller.abort()
  }, [id, job.data?.status, cache])
  if (!job.data)
    return job.isError ? (
      <p className='text-label text-destructive'>
        任务无法访问，请检查当前权限。
        <Button variant='link' onClick={() => void job.refetch()}>
          重试读取
        </Button>
      </p>
    ) : (
      <p className='text-label'>正在读取任务…</p>
    )
  const value = job.data,
    active = ['queued', 'running'].includes(value.status)
  return (
    <div className='space-y-2 rounded-md border p-3' aria-live='polite'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-label'>
          {
            {
              report_materialize: '报告材料',
              report_render: 'Word / PDF',
              report_bundle: '报告包',
            }[value.kind]
          }
        </span>
        <StatusBadge
          tone={
            value.status === 'failed'
              ? 'error'
              : value.status === 'complete'
                ? 'success'
                : 'info'
          }
        >
          {
            {
              queued: '等待处理',
              running: '正在处理',
              complete: '文件任务完成',
              partial: '部分文件已交付',
              failed: '任务失败',
              cancelled: '已取消',
            }[value.status]
          }
        </StatusBadge>
        <span className='text-small text-muted-foreground'>
          {new Date(value.createdAt).toLocaleString('zh-CN')}
        </span>
      </div>
      {value.progress && <p className='text-label'>{value.progress}</p>}
      {value.contentCompleteness === 'partial' && (
        <p className='text-label text-muted-foreground'>
          报告内容有缺项，具体原因已记录在文档中。
        </p>
      )}
      {value.error && (
        <p className='text-label break-words text-destructive'>{value.error}</p>
      )}
      {canExport && (
        <div className='flex flex-wrap gap-2'>
          {value.artifactIds.map((artifactId, index) => (
            <Button
              key={artifactId}
              variant='outline'
              size='sm'
              disabled={
                value.artifacts?.find((file) => file.id === artifactId)
                  ?.available === false
              }
              onClick={async () => {
                try {
                  const file = await downloadArtifact(artifactId),
                    url = URL.createObjectURL(file.blob),
                    anchor = document.createElement('a')
                  anchor.href = url
                  anchor.download = file.fileName ?? 'report'
                  anchor.click()
                  setTimeout(() => URL.revokeObjectURL(url), 1000)
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : '下载失败'
                  )
                }
              }}
            >
              下载
              {value.artifacts?.find((file) => file.id === artifactId)?.kind ===
              'report_pdf'
                ? 'PDF'
                : value.artifacts?.find((file) => file.id === artifactId)
                      ?.kind === 'report_docx'
                  ? 'Word'
                  : value.kind === 'report_bundle'
                    ? '报告包'
                    : `文件 ${index + 1}`}
            </Button>
          ))}
          {value.artifacts?.map((file) => (
            <p
              key={`retention-${file.id}`}
              className='w-full text-small break-words text-muted-foreground'
            >
              {file.fileName} ·{' '}
              {file.available
                ? `有效至 ${new Date(file.retainUntil).toLocaleString('zh-CN')}`
                : '已到期或不可用'}
            </p>
          ))}
          {active && (
            <Button
              variant='ghost'
              size='sm'
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  cache.setQueryData(
                    ['export-job', id],
                    await cancelReportJob(id)
                  )
                } catch (error) {
                  toast.error(
                    error instanceof Error ? error.message : '取消失败'
                  )
                } finally {
                  setBusy(false)
                }
              }}
            >
              取消此任务
            </Button>
          )}
          {!active &&
            ['failed', 'cancelled', 'partial'].includes(value.status) &&
            (value.retryCount ?? 0) < 3 && (
              <Button
                variant='outline'
                size='sm'
                disabled={busy || !!retried}
                onClick={async () => {
                  setBusy(true)
                  try {
                    setRetried(
                      await retryReportJob(id, `retry-${crypto.randomUUID()}`)
                    )
                  } catch (error) {
                    toast.error(
                      error instanceof Error ? error.message : '重试失败'
                    )
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                仅重试文件任务
              </Button>
            )}
        </div>
      )}
      {retried && (
        <ExportJobCard key={retried.id} id={retried.id} initial={retried} />
      )}
    </div>
  )
}

export function ReportDelivery({
  report,
  activeJobId,
  formats = ['docx', 'pdf'],
}: {
  report: ReportDto
  activeJobId?: string | null
  formats?: Array<'docx' | 'pdf'>
}) {
  const canExport = useCan('report:export')
  const [selected, setSelected] = useState<string>(),
    [includeChildren, setIncludeChildren] = useState(true),
    [memberId, setMemberId] = useState(''),
    [childTitle, setChildTitle] = useState(''),
    [busy, setBusy] = useState(false),
    [extraJob, setExtraJob] = useState<ExportJobDto>()
  const revisions = useInfiniteQuery({
    queryKey: ['report-revisions', report.id, report.currentRevision?.id],
    queryFn: ({ pageParam }) => fetchReportRevisions(report.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const revisionId = selected ?? report.currentRevision?.id
  const detail = useQuery({
    queryKey: [
      'report-revision',
      report.id,
      revisionId,
      report.currentRevision?.sealedAt,
    ],
    queryFn: () => fetchReportRevision(report.id, revisionId!),
    enabled: !!revisionId,
  })
  const jobs = useInfiniteQuery({
    queryKey: ['report-jobs', report.id, activeJobId],
    queryFn: ({ pageParam }) => fetchReportJobs(report.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const revision = detail.data?.revision,
    members = detail.data?.document?.source.items
  const act = async (work: () => Promise<ExportJobDto>) => {
    setBusy(true)
    try {
      setExtraJob(await work())
      await jobs.refetch()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '提交失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className='space-y-4'>
      {report.currentRevision?.materialJobId &&
        !report.currentRevision.sealedAt && (
          <ExportJobCard id={report.currentRevision.materialJobId} />
        )}
      <details className='rounded-md border p-3'>
        <summary className='cursor-pointer text-body'>
          查看修订、材料与历史文件
        </summary>
        <div className='mt-4 grid min-w-0 gap-3'>
          <Select value={revisionId} onValueChange={setSelected}>
            <SelectTrigger
              aria-label='报告修订'
              className='w-full min-w-0 [&_[data-slot=select-value]]:block [&_[data-slot=select-value]]:truncate'
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {revisions.data?.pages
                .flatMap((page) => page.items)
                .map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    修订 {item.revisionNo} · {item.title}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {revisions.hasNextPage && (
            <Button
              variant='link'
              onClick={() => void revisions.fetchNextPage()}
            >
              更早修订
            </Button>
          )}
          {detail.isError && (
            <p className='text-label text-destructive'>
              无法读取修订。
              <Button variant='link' onClick={() => void detail.refetch()}>
                重试读取
              </Button>
            </p>
          )}
          {detail.data?.document && (
            <div className='space-y-2 text-label'>
              <p>
                数据截至：
                {new Date(detail.data.document.asOf).toLocaleString('zh-CN')}
              </p>
              <p>
                已封存图片：
                {detail.data.document.materials?.filter(
                  (item) => item.artifactId
                ).length ?? 0}
                ；缺失图片：
                {detail.data.document.materials?.filter(
                  (item) => item.missingReason
                ).length ?? 0}
              </p>
              {detail.data.document.gaps.map((gap, i) => (
                <p className='break-words text-muted-foreground' key={i}>
                  {gap}
                </p>
              ))}
            </div>
          )}
          {selected && selected !== report.currentRevision?.id && canExport && (
            <Button
              variant='outline'
              disabled={busy || !formats.length || !revision?.sealedAt}
              onClick={() =>
                void act(() =>
                  exportReport(report.id, selected, {
                    formats,
                    idempotencyKey: `history-${crypto.randomUUID()}`,
                  })
                )
              }
            >
              导出此历史修订
            </Button>
          )}
          {jobs.data?.pages
            .flatMap((page) => page.items)
            .filter(
              (item) =>
                item.id !== activeJobId &&
                item.id !== extraJob?.id &&
                item.id !== report.currentRevision?.materialJobId
            )
            .map((item) => (
              <ExportJobCard key={item.id} initial={item} id={item.id} />
            ))}
          {jobs.hasNextPage && (
            <Button variant='link' onClick={() => void jobs.fetchNextPage()}>
              更早文件任务
            </Button>
          )}
        </div>
      </details>
      {canExport && report.subject.kind === 'SUITE_RUN' && (
        <details className='rounded-md border p-3'>
          <summary className='cursor-pointer text-body'>报告包与子报告</summary>
          <div className='mt-4 grid gap-3'>
            <p className='text-label text-muted-foreground'>
              使用当前选定的总报告修订
              {revision ? ` ${revision.revisionNo}` : ''}
              ，共用同一取数时间和已封存的图片。报告包保留 24 小时。
            </p>
            <label className='flex items-center gap-2 text-body'>
              <input
                type='checkbox'
                checked={includeChildren}
                onChange={(event) => setIncludeChildren(event.target.checked)}
              />
              报告包包含每个成员的子报告
            </label>
            <Button
              className='justify-self-start'
              variant='outline'
              disabled={busy || !formats.length || !revision?.sealedAt}
              onClick={() =>
                void act(() =>
                  createReportBundle({
                    reportRevisionId: revisionId!,
                    formats,
                    includeChildReports: includeChildren,
                    idempotencyKey: `bundle-${crypto.randomUUID()}`,
                  })
                )
              }
            >
              生成 Word / PDF 报告包
            </Button>
            <div className='grid gap-2 border-t pt-3'>
              <Label>单独导出成员报告</Label>
              <Select value={memberId} onValueChange={setMemberId}>
                <SelectTrigger
                  aria-label='选择报告成员'
                  className='w-full min-w-0 [&_[data-slot=select-value]]:block [&_[data-slot=select-value]]:truncate'
                >
                  <SelectValue placeholder='选择成员' />
                </SelectTrigger>
                <SelectContent>
                  {Array.isArray(members) &&
                    members.map((item) => {
                      const member = item as Record<string, unknown>
                      return (
                        <SelectItem
                          key={String(member.memberId)}
                          value={String(member.memberId)}
                        >
                          {String(member.displayName ?? member.memberId)}
                        </SelectItem>
                      )
                    })}
                </SelectContent>
              </Select>
              <Input
                aria-label='子报告独立标题'
                value={childTitle}
                maxLength={200}
                placeholder='子报告独立标题（留空使用成员默认）'
                onChange={(event) => setChildTitle(event.target.value)}
              />
              <Button
                className='justify-self-start'
                variant='outline'
                disabled={
                  busy || !formats.length || !revision?.sealedAt || !memberId
                }
                onClick={() =>
                  void act(async () => {
                    const child = await deriveMemberReport(
                      report.id,
                      revisionId!,
                      {
                        memberId,
                        config: childTitle.trim()
                          ? { title: childTitle.trim() }
                          : undefined,
                        idempotencyKey: `member-${crypto.randomUUID()}`,
                      }
                    )
                    return exportReport(child.id, child.currentRevision!.id, {
                      formats,
                      idempotencyKey: `member-export-${crypto.randomUUID()}`,
                    })
                  })
                }
              >
                导出此成员报告
              </Button>
            </div>
          </div>
        </details>
      )}
      {extraJob && (
        <ExportJobCard key={extraJob.id} id={extraJob.id} initial={extraJob} />
      )}
    </div>
  )
}
