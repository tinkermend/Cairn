import { useId, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DEFAULT_REPORT_CONFIG,
  type ReportConfig,
  type ReportDto,
  type ReportSubject,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  createReport,
  createReportRevision,
  exportReport,
  fetchExportJob,
  fetchReports,
  fetchReport,
  previewReport,
  fetchReportSourceOptions,
  deleteReport,
  previewDeleteReport,
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
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { ReportConfigFields } from './config-fields'
import { ReportDelivery, ExportJobCard } from './delivery'

function newIdempotencyKey() {
  return `report-${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

export function ReportPanel({
  subject,
  initialReport,
}: {
  subject: ReportSubject
  initialReport?: ReportDto
}) {
  const sourceKey = subject.kind === 'RUN' ? subject.runId : subject.suiteRunId
  return (
    <ReportPanelContent
      key={`${subject.kind}:${sourceKey}:${initialReport?.id ?? ''}`}
      subject={subject}
      initialReport={initialReport}
    />
  )
}

function ReportPanelContent({
  subject,
  initialReport,
}: {
  subject: ReportSubject
  initialReport?: ReportDto
}) {
  const canRead = useCan('report:read')
  const canExport = useCan('report:export')
  const canDelete = useCan('report:delete')
  const [deleting, setDeleting] = useState(false)
  const queryClient = useQueryClient()
  const query = {
    scope:
      subject.kind === 'RUN' ? ('run' as const) : ('suite_summary' as const),
    runId: subject.kind === 'RUN' ? subject.runId : undefined,
    suiteRunId: subject.kind === 'SUITE_RUN' ? subject.suiteRunId : undefined,
  }
  const reports = useQuery({
    queryKey: ['reports', query],
    queryFn: () => fetchReports(query),
    enabled: canRead,
  })
  const [olderReports, setOlderReports] = useState<ReportDto[]>([])
  const [nextCursor, setNextCursor] = useState<string | null | undefined>()
  const [selectedReport, setSelectedReport] = useState<string | undefined>(
    initialReport?.id
  )
  const selected = useQuery({
    queryKey: ['report', selectedReport],
    queryFn: () => fetchReport(selectedReport!),
    enabled: !!selectedReport,
    initialData:
      selectedReport === initialReport?.id ? initialReport : undefined,
  })
  const allReports = [
    ...(reports.data?.items ?? []),
    ...olderReports,
    ...(selected.data ? [selected.data] : []),
  ].filter(
    (item, index, items) =>
      items.findIndex((other) => other.id === item.id) === index
  )
  const current = selectedReport
    ? (selected.data ?? allReports.find((item) => item.id === selectedReport))
    : allReports[0]
  const [title, setTitle] = useState('')
  const options = useQuery({
    queryKey: ['report-source-options', subject],
    queryFn: () => fetchReportSourceOptions(subject),
    enabled: canRead,
  })
  const [override, setOverride] = useState<ReportConfig>()
  const config =
    override ??
    current?.currentRevision?.config ??
    options.data?.config ??
    DEFAULT_REPORT_CONFIG
  const effectiveConfig = {
    ...(override ?? {}),
    ...(title.trim() ? { title: title.trim() } : {}),
  }
  const titleId = useId()
  const [stage, setStage] = useState<'final' | 'phase'>('final')
  const [busy, setBusy] = useState(false)
  const [formats, setFormats] = useState<Array<'docx' | 'pdf'>>(['docx', 'pdf'])
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useQuery({
    queryKey: ['export-job', jobId],
    queryFn: () => fetchExportJob(jobId!),
    enabled: false,
  })

  if (!canRead) return null

  async function generate() {
    setBusy(true)
    try {
      const preview = await previewReport({
        subject,
        stage,
        scope: subject.kind === 'RUN' ? 'run' : 'suite_summary',
        config: effectiveConfig,
        idempotencyKey: newIdempotencyKey(),
      })
      if (preview.issues.length) toast.message(preview.issues.join('；'))
      if (stage === 'final' && !preview.canGenerateFinal) {
        toast.error('运行尚未结束或证据仍在收集，可以选择生成阶段报告')
        return
      }
      const created = await createReport({
        subject,
        stage,
        scope: subject.kind === 'RUN' ? 'run' : 'suite_summary',
        config: effectiveConfig,
        idempotencyKey: newIdempotencyKey(),
      })
      setJobId(null)
      queryClient.setQueryData(['report', created.id], created)
      setSelectedReport(created.id)
      await queryClient.invalidateQueries({ queryKey: ['reports', query] })
      toast.success(
        created.currentRevision?.sealedAt
          ? '报告已生成'
          : '报告已创建，正在准备材料'
      )
    } catch (error) {
      toast.error(
        error instanceof ApiRequestError ? error.message : '生成报告失败'
      )
    } finally {
      setBusy(false)
    }
  }

  async function revise() {
    if (!current) return
    setBusy(true)
    try {
      await createReportRevision(current.id, {
        reason: '更新标题或重新取材',
        stage,
        config: effectiveConfig,
        idempotencyKey: newIdempotencyKey(),
      })
      setJobId(null)
      await queryClient.invalidateQueries({ queryKey: ['reports', query] })
      await queryClient.invalidateQueries({ queryKey: ['report', current.id] })
      toast.success('已生成新修订')
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '修订失败')
    } finally {
      setBusy(false)
    }
  }

  async function exportFormats() {
    if (!current?.currentRevision) return
    setBusy(true)
    try {
      const created = await exportReport(
        current.id,
        current.currentRevision.id,
        {
          formats,
          idempotencyKey: newIdempotencyKey(),
        }
      )
      queryClient.setQueryData(['export-job', created.id], created)
      setJobId(created.id)
      toast.success(
        `已排队导出 ${formats.map((format) => (format === 'docx' ? 'Word' : 'PDF')).join(' 与 ')}`
      )
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '导出失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className='space-y-4 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <div>
        <h2 className='text-title'>报告</h2>
        <p className='text-label text-muted-foreground'>
          支持单场景报告与集合汇总报告，可导出 Word 和 PDF。
        </p>
      </div>
      {reports.isError && (
        <p className='text-label text-destructive'>
          报告列表读取失败。
          <Button variant='link' onClick={() => void reports.refetch()}>
            重试读取
          </Button>
        </p>
      )}
      {allReports.length > 1 && (
        <Select
          value={current?.id}
          onValueChange={(id) => {
            setSelectedReport(id)
            setJobId(null)
            setOverride(undefined)
            setTitle('')
          }}
        >
          <SelectTrigger
            aria-label='选择报告'
            className='w-full min-w-0 [&_[data-slot=select-value]]:block [&_[data-slot=select-value]]:truncate'
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {allReports.map((report) => (
              <SelectItem key={report.id} value={report.id}>
                {report.currentRevision?.title ?? '报告'} ·{' '}
                {new Date(report.createdAt).toLocaleString('zh-CN')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {(nextCursor === undefined ? reports.data?.nextCursor : nextCursor) && (
        <Button
          variant='link'
          onClick={async () => {
            try {
              const page = await fetchReports({
                ...query,
                cursor: (nextCursor === undefined
                  ? reports.data?.nextCursor
                  : nextCursor)!,
              })
              setOlderReports([...olderReports, ...page.items])
              setNextCursor(page.nextCursor)
            } catch (error) {
              toast.error(error instanceof Error ? error.message : '读取失败')
            }
          }}
        >
          加载更早报告
        </Button>
      )}
      {canExport ? (
        <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-end'>
          <div className='grid gap-2'>
            <Label htmlFor={titleId}>报告标题</Label>
            <Input
              id={titleId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder='可留空使用默认模板'
            />
          </div>
          <Select
            value={stage}
            onValueChange={(value) => setStage(value as 'final' | 'phase')}
          >
            <SelectTrigger aria-label='报告类型'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='final'>终稿</SelectItem>
              <SelectItem value='phase'>阶段报告</SelectItem>
            </SelectContent>
          </Select>
          <Button disabled={busy} onClick={() => void generate()}>
            {current ? '按当前来源再生成' : '生成报告'}
          </Button>
          {current ? (
            <Button
              disabled={busy}
              variant='outline'
              onClick={() => void revise()}
            >
              新修订
            </Button>
          ) : null}
        </div>
      ) : (
        <p className='text-label text-muted-foreground'>
          当前角色可以查看报告，不能生成或下载文件。
        </p>
      )}
      {canExport && options.data && (
        <details className='rounded-md border p-3'>
          <summary className='cursor-pointer text-body'>高级报告配置</summary>
          <div className='mt-4'>
            <p className='mb-3 text-label text-muted-foreground'>
              默认标题：{config.title}。调整只用于本次报告或新修订。
            </p>
            <ReportConfigFields
              config={config}
              onChange={setOverride}
              targetId={options.data.targetId}
              editScope={subject.kind === 'RUN' ? 'scenario' : 'suite'}
              screenshots={options.data.screenshots}
            />
          </div>
        </details>
      )}
      {current?.currentRevision ? (
        <div className='space-y-2'>
          <p className='text-body'>
            {current.currentRevision.title}
            <span className='ms-2 text-label text-muted-foreground'>
              修订 {current.currentRevision.revisionNo}
            </span>
          </p>
          <p className='text-label text-muted-foreground'>
            {current.currentRevision.stage === 'phase' ? '阶段报告' : '终稿'}
            {current.currentRevision.sealedAt === null
              ? ' · 材料尚未封存'
              : current.currentRevision.contentCompleteness === 'partial'
                ? ' · 内容有缺项，详见报告说明'
                : ' · 内容完整'}
          </p>
          {canExport ? (
            <div className='space-y-3'>
              <fieldset className='flex flex-wrap gap-3 text-label'>
                <legend className='mb-2'>导出格式</legend>
                {(['docx', 'pdf'] as const).map((format) => (
                  <label key={format} className='flex items-center gap-2'>
                    <input
                      type='checkbox'
                      checked={formats.includes(format)}
                      onChange={(event) =>
                        setFormats(
                          event.target.checked
                            ? [...formats, format]
                            : formats.filter((item) => item !== format)
                        )
                      }
                    />
                    {format === 'docx' ? 'Word' : 'PDF'}
                  </label>
                ))}
              </fieldset>
              <Button
                disabled={
                  busy ||
                  !formats.length ||
                  current.currentRevision.sealedAt === null
                }
                variant='outline'
                onClick={() => void exportFormats()}
              >
                导出 {formats.includes('docx') ? 'Word' : ''}
                {formats.length === 2 ? ' 与 ' : ''}
                {formats.includes('pdf') ? 'PDF' : ''}
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className='text-label text-muted-foreground'>还没有报告。</p>
      )}
      {current && (
        <ReportDelivery
          key={current.id}
          report={current}
          activeJobId={jobId}
          formats={formats}
        />
      )}
      {jobId && <ExportJobCard id={jobId} initial={job.data} />}
      {current && canDelete && (
        <>
          <Button variant='ghost' size='sm' onClick={() => setDeleting(true)}>
            删除此报告
          </Button>
          <ResourceDeleteDialog
            open={deleting}
            onOpenChange={setDeleting}
            resourceType='report'
            resourceId={current.id}
            resourceName={current.currentRevision?.title ?? '报告'}
            previewFn={() => previewDeleteReport(current.id)}
            deleteFn={async () => {
              await deleteReport(current.id)
            }}
            onSuccess={() => {
              setSelectedReport(undefined)
              setOlderReports([])
              setJobId(null)
              void queryClient.invalidateQueries({ queryKey: ['reports'] })
              void queryClient.invalidateQueries({
                queryKey: ['report', current.id],
              })
            }}
          />
        </>
      )}
    </section>
  )
}
