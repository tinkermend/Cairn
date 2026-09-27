import { useMemo, useState } from 'react'
import {
  HEALTH_GRADE_LABELS,
  SUITE_GRID_STATUS_LABELS,
  projectSuiteSummaryForDisplay,
  suiteSummaryBlockSchema,
  type ReportDocument,
  type SuiteGridRow,
  type SuiteAggregatedFinding,
  type SuiteSummaryBlock,
} from '@cairn/shared'
import {
  AlertTriangle,
  Clock,
  Copy,
  Maximize2,
  RotateCcw,
  Zap,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export function SuiteReportView({
  document,
  onExport,
}: {
  document: ReportDocument
  onExport?: () => void
}) {
  const [filter, setFilter] = useState<'ALL' | 'ANOMALOUS' | 'WARNING' | 'NORMAL' | 'UNDETERMINED'>('ALL')
  const [activeLightbox, setActiveLightbox] = useState<{
    imageUrl: string
    title: string
    caption?: string
  } | null>(null)
  const [zoomLevel, setZoomLevel] = useState(1)

  const reportSummary = useMemo(() => {
    const raw = document.sections
      .flatMap((s) => s.blocks)
      .find((b) => b.type === 'suite_business_summary')
    if (!raw) return null
    const parsed = suiteSummaryBlockSchema.safeParse(raw)
    if (!parsed.success) {
      console.error('Failed to parse suite_business_summary:', parsed.error)
      return null
    }
    const legacy = !Object.prototype.hasOwnProperty.call(raw, 'undeterminedCount')
    const projected = legacy
      ? projectSuiteSummaryForDisplay(parsed.data, document.source)
      : { summary: parsed.data, unverifiedCount: 0, reclassifiedCount: 0 }
    return { ...projected, legacy }
  }, [document])
  const summaryBlock: SuiteSummaryBlock | null = reportSummary?.summary ?? null

  const materialsMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of document.materials ?? []) {
      if (m.evidenceId && m.artifactId) {
        map.set(m.evidenceId, `/api/artifacts/${m.artifactId}/content`)
      }
    }
    return map
  }, [document.materials])

  if (!summaryBlock) {
    return null
  }

  const filteredRows = summaryBlock.gridRows.filter((row) => {
    if (filter === 'ALL') return true
    if (filter === 'ANOMALOUS') return row.status === 'ANOMALOUS'
    if (filter === 'WARNING') return row.status === 'WARNING'
    if (filter === 'NORMAL') return row.status === 'NORMAL'
    if (filter === 'UNDETERMINED') return row.status === 'UNDETERMINED'
    return true
  })

  // 历史封存报告仍保留原始分数；旧版 incomplete 结论在当前界面不展示为健康评级。
  const scoreAvailable = summaryBlock.healthScore != null && summaryBlock.healthGrade != null &&
    summaryBlock.undeterminedCount === 0 && summaryBlock.skippedCount === 0 && document.verdict !== 'incomplete'
  const gradeLabel = scoreAvailable && summaryBlock.healthGrade
    ? HEALTH_GRADE_LABELS[summaryBlock.healthGrade]
    : null

  function copyRichSummary() {
    if (!summaryBlock) return
    const lines = [
      `【${document.title}】`,
      `业务检查得分：${scoreAvailable ? `${summaryBlock.healthScore}分 (${gradeLabel})` : '未评分（业务结果未完整判定）'}`,
      `覆盖模块：${summaryBlock.totalCount} | 正常：${summaryBlock.normalCount} | 警告：${summaryBlock.warningCount} | 异常：${summaryBlock.anomalousCount} | 未判定：${summaryBlock.undeterminedCount} | 跳过：${summaryBlock.skippedCount}`,
      `实际耗时：${(summaryBlock.wallClockMs / 1000).toFixed(1)}s (累计耗时 ${(summaryBlock.childDurationMs / 1000).toFixed(1)}s，节省 ${summaryBlock.savedPercent}%)`,
    ]
    if (summaryBlock.aggregatedFindings.length > 0) {
      lines.push('\n【核心异常与发现】')
      summaryBlock.aggregatedFindings.forEach((f, idx) => {
        lines.push(`${idx + 1}. [${f.displayName}] ${f.title} (${f.severity}) - ${f.detail ?? '无详细说明'}`)
      })
    }
    void navigator.clipboard.writeText(lines.join('\n')).then(() => {
      toast.success('已复制巡检总结至剪贴板')
    })
  }

  return (
    <div className='flex flex-col gap-6'>
      {/* 顶部报告元数据与操作条 */}
      <div className='flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <div>
          <h2 className='text-title text-foreground'>{document.title}</h2>
          <p className='text-label text-muted-foreground'>
            生成时间：{new Date(document.generatedAt).toLocaleString()}（时区：{document.timeZone}）
            {document.organization ? ` · 组织：${document.organization}` : ''}
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button variant='outline' size='sm' onClick={copyRichSummary}>
            <Copy className='mr-1.5 size-3.5' />
            复制总结
          </Button>
          {onExport ? (
            <Button variant='default' size='sm' onClick={onExport}>
              导出报告
            </Button>
          ) : null}
        </div>
      </div>

      {reportSummary?.legacy ? (
        <p role='status' className='rounded-lg border border-warning/30 bg-warning/10 p-3 text-label text-foreground'>
          这是旧版封存报告。本页按来源运行重新分类 {reportSummary.reclassifiedCount} 项，原报告数据未改。
          {reportSummary.unverifiedCount > 0
            ? `另有 ${reportSummary.unverifiedCount} 项缺少可核验来源；旧版“正常”分类不能据此认定业务正常。`
            : null}
        </p>
      ) : null}

      {/* L0: 决策与执行总览 */}
      <section className='grid gap-4 sm:grid-cols-12'>
        {/* 业务检查评分与判定覆盖 */}
        <div className='flex flex-col items-center justify-center rounded-lg border border-border-card bg-card p-6 shadow-card sm:col-span-4'>
          <p className='text-label text-muted-foreground'>业务检查得分</p>
          <div className='my-3 flex items-baseline gap-2'>
            <span
              className={`text-stat font-extrabold tracking-tight ${
                !scoreAvailable
                  ? 'text-muted-foreground'
                  : summaryBlock.healthScore! >= 90
                  ? 'text-success'
                  : summaryBlock.healthScore! >= 75
                    ? 'text-info'
                    : summaryBlock.healthScore! >= 60
                      ? 'text-warning'
                      : 'text-destructive'
              }`}
            >
              {scoreAvailable ? summaryBlock.healthScore : '—'}
            </span>
            {scoreAvailable ? <span className='text-label text-muted-foreground'>/ 100</span> : null}
          </div>
          <Badge
            className={`px-3 py-0.5 text-label font-semibold ${
              !scoreAvailable
                ? 'bg-muted text-muted-foreground border-border'
                : summaryBlock.healthGrade === 'EXCELLENT'
                ? 'bg-success/15 text-success border-success/30'
                : summaryBlock.healthGrade === 'GOOD'
                  ? 'bg-info/15 text-info border-info/30'
                  : summaryBlock.healthGrade === 'FAIR'
                    ? 'bg-warning/15 text-warning border-warning/30'
                    : 'bg-destructive/15 text-destructive border-destructive/30'
            }`}
          >
            {scoreAvailable ? `评级：${gradeLabel}` : '业务结果未完整判定，暂不评分'}
          </Badge>
        </div>

        {/* 模块计数与耗时对比 */}
        <div className='flex flex-col justify-between gap-4 rounded-lg border border-border-card bg-card p-6 shadow-card sm:col-span-8'>
          <div className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6'>
            <div className='rounded-md border border-border/50 bg-muted/40 p-3'>
              <p className='text-label text-muted-foreground'>总巡检项</p>
              <p className='text-section font-bold'>{summaryBlock.totalCount}</p>
            </div>
            <div className='rounded-md border border-success/30 bg-success/10 p-3'>
              <p className='text-label text-success'>正常模块</p>
              <p className='text-section font-bold text-success'>{summaryBlock.normalCount}</p>
            </div>
            <div className='rounded-md border border-warning/30 bg-warning/10 p-3'>
              <p className='text-label text-warning'>警告模块</p>
              <p className='text-section font-bold text-warning'>{summaryBlock.warningCount}</p>
            </div>
            <div className='rounded-md border border-destructive/30 bg-destructive/10 p-3'>
              <p className='text-label text-destructive'>异常模块</p>
              <p className='text-section font-bold text-destructive'>{summaryBlock.anomalousCount}</p>
            </div>
            <div className='rounded-md border border-border/50 bg-muted/40 p-3'>
              <p className='text-label text-muted-foreground'>未判定模块</p>
              <p className='text-section font-bold text-muted-foreground'>{summaryBlock.undeterminedCount}</p>
            </div>
            <div className='rounded-md border border-border/50 bg-muted/40 p-3'>
              <p className='text-label text-muted-foreground'>跳过模块</p>
              <p className='text-section font-bold text-muted-foreground'>{summaryBlock.skippedCount}</p>
            </div>
          </div>

          <div className='flex flex-wrap items-center justify-between gap-2 border-t border-border-divider pt-3'>
            <div className='flex items-center gap-2 text-label text-muted-foreground'>
              <Clock className='size-4' />
              <span>整次耗时：{(summaryBlock.wallClockMs / 1000).toFixed(1)} 秒</span>
              <span>·</span>
              <span>累计工时：{(summaryBlock.childDurationMs / 1000).toFixed(1)} 秒</span>
            </div>
            {summaryBlock.savedPercent > 0 ? (
              <Badge className='bg-success/15 text-success border-success/30 flex items-center gap-1'>
                <Zap className='size-3.5' />
                并发节约 {summaryBlock.savedPercent}% 耗时
              </Badge>
            ) : null}
          </div>
        </div>
      </section>

      {/* L1: 核心业务巡检对照总表 */}
      <section className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
        <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
          <div>
            <h3 className='text-title'>核心业务巡检对照总表</h3>
            <p className='text-label text-muted-foreground'>
              横向汇总各子场景的业务指标、抓取数据与结论。
            </p>
          </div>
          {/* 状态筛选切换 */}
          <div className='flex items-center gap-1 rounded-lg border border-border bg-muted/50 p-1'>
            <Button
              variant={filter === 'ALL' ? 'secondary' : 'ghost'}
              size='sm'
              className='h-7 text-label'
              onClick={() => setFilter('ALL')}
            >
              全部 ({summaryBlock.gridRows.length})
            </Button>
            <Button
              variant={filter === 'ANOMALOUS' ? 'secondary' : 'ghost'}
              size='sm'
              className='h-7 text-label text-destructive'
              onClick={() => setFilter('ANOMALOUS')}
            >
              仅看异常 ({summaryBlock.anomalousCount})
            </Button>
            <Button
              variant={filter === 'WARNING' ? 'secondary' : 'ghost'}
              size='sm'
              className='h-7 text-label text-warning'
              onClick={() => setFilter('WARNING')}
            >
              仅看警告 ({summaryBlock.warningCount})
            </Button>
            <Button
              variant={filter === 'NORMAL' ? 'secondary' : 'ghost'}
              size='sm'
              className='h-7 text-label text-success'
              onClick={() => setFilter('NORMAL')}
            >
              仅看正常 ({summaryBlock.normalCount})
            </Button>
            <Button
              variant={filter === 'UNDETERMINED' ? 'secondary' : 'ghost'}
              size='sm'
              className='h-7 text-label'
              onClick={() => setFilter('UNDETERMINED')}
            >
              仅看未判定 ({summaryBlock.undeterminedCount})
            </Button>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-14 text-center'>序号</TableHead>
              <TableHead className='w-40'>子系统 / 场景</TableHead>
              <TableHead className='w-44'>检查项</TableHead>
              <TableHead className='w-24'>状态</TableHead>
              <TableHead>核心业务数据 / 指标</TableHead>
              <TableHead className='w-52'>结论与耗时</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredRows.map((row: SuiteGridRow) => {
              const metricsEntries = Object.entries(row.metrics ?? {})
              const dataRowEntries = Object.entries(row.dataRow ?? {})
              return (
                <TableRow key={row.memberId}>
                  <TableCell className='text-center font-mono text-label text-muted-foreground'>
                    {row.ordinal + 1}
                  </TableCell>
                  <TableCell>
                    <div className='font-medium text-foreground'>{row.scenarioName}</div>
                    <div className='text-label text-muted-foreground'>{row.memberId}</div>
                  </TableCell>
                  <TableCell>
                    <div className='text-body text-foreground'>{row.displayName}</div>
                  </TableCell>
                  <TableCell>
                    <Badge
                      className={
                        row.status === 'NORMAL'
                          ? 'bg-success/15 text-success border-success/30'
                          : row.status === 'WARNING'
                            ? 'bg-warning/15 text-warning border-warning/30'
                            : row.status === 'ANOMALOUS'
                              ? 'bg-destructive/15 text-destructive border-destructive/30'
                              : 'bg-muted text-muted-foreground'
                      }
                    >
                      {SUITE_GRID_STATUS_LABELS[row.status] ?? row.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className='flex flex-wrap gap-1.5'>
                      {metricsEntries.map(([k, v]) => (
                        <span
                          key={k}
                          className='inline-flex items-center rounded border border-border bg-muted/60 px-1.5 py-0.5 text-label'
                        >
                          <span className='font-mono text-muted-foreground mr-1'>{k}:</span>
                          <span className='font-semibold'>{String(v)}</span>
                        </span>
                      ))}
                      {dataRowEntries.map(([k, v]) => (
                        <span
                          key={k}
                          className='inline-flex items-center rounded border border-info/30 bg-info/10 px-1.5 py-0.5 text-label text-info'
                        >
                          <span className='mr-1'>{k}:</span>
                          <span>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                        </span>
                      ))}
                      {metricsEntries.length === 0 && dataRowEntries.length === 0 ? (
                        <span className='text-label text-muted-foreground'>-</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className='text-body text-foreground'>{row.summary || '-'}</div>
                    {row.durationMs != null ? (
                      <div className='mt-0.5 text-label text-muted-foreground'>
                        耗时：{(row.durationMs / 1000).toFixed(1)}s
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </section>

      {/* L2: 异常透视与证据画廊 */}
      {summaryBlock.aggregatedFindings.length > 0 ? (
        <section className='space-y-4 rounded-lg border border-destructive/30 bg-destructive/5 p-5 shadow-card'>
          <div className='flex items-center gap-2'>
            <AlertTriangle className='size-5 text-destructive' />
            <h3 className='text-title text-destructive'>
              异常透视与现场证据画廊 ({summaryBlock.aggregatedFindings.length})
            </h3>
          </div>
          <div className='grid gap-4 sm:grid-cols-2'>
            {summaryBlock.aggregatedFindings.map((finding: SuiteAggregatedFinding) => {
              const evidenceUrl = finding.evidenceId ? materialsMap.get(finding.evidenceId) : undefined
              return (
                <div
                  key={`${finding.memberId}-${finding.id}`}
                  className='flex flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4 shadow-sm'
                >
                  <div className='space-y-2'>
                    <div className='flex items-start justify-between gap-2'>
                      <div>
                        <span className='text-label font-medium text-muted-foreground'>
                          {finding.displayName}
                        </span>
                        <h4 className='text-body font-semibold text-foreground'>{finding.title}</h4>
                      </div>
                      <Badge
                        className={
                          finding.severity === 'FATAL' || finding.severity === 'HIGH'
                            ? 'bg-destructive/15 text-destructive border-destructive/30'
                            : 'bg-warning/15 text-warning border-warning/30'
                        }
                      >
                        {finding.severity}
                      </Badge>
                    </div>
                    {finding.detail ? (
                      <p className='text-label text-muted-foreground'>{finding.detail}</p>
                    ) : null}
                  </div>

                  {evidenceUrl ? (
                    <div className='relative group overflow-hidden rounded-md border border-border'>
                      <img
                        src={evidenceUrl}
                        alt={finding.title}
                        className='h-36 w-full object-cover transition-transform group-hover:scale-105'
                      />
                      <button
                        type='button'
                        className='absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 text-white gap-1.5 text-label font-medium'
                        onClick={() => {
                          setActiveLightbox({
                            imageUrl: evidenceUrl,
                            title: `${finding.displayName} - ${finding.title}`,
                            caption: finding.detail,
                          })
                          setZoomLevel(1)
                        }}
                      >
                        <Maximize2 className='size-4' />
                        查看高清原图
                      </button>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        </section>
      ) : null}

      {/* L3: 技术明细与执行追溯（默认折叠） */}
      <section className='rounded-lg border border-border-card bg-card p-4 shadow-card'>
        <details className='group'>
          <summary className='flex cursor-pointer items-center justify-between font-medium text-foreground'>
            <span>【L3: 技术明细与执行追溯】(点击展开原子执行步骤与 Attempt 流水)</span>
            <span className='text-label text-muted-foreground group-open:hidden'>展开</span>
            <span className='text-label text-muted-foreground hidden group-open:inline'>收起</span>
          </summary>
          <div className='mt-4 space-y-4 border-t border-border-divider pt-4'>
            {document.sections
              .flatMap((s) => s.blocks)
              .filter((b) => b.type === 'result')
              .map((_, idx) => (
                <div key={idx} className='text-label text-muted-foreground'>
                  <p>详细步骤与证据流水已归档至系统报告快照。如需深入调试步骤 Attempt，请访问单场景详情。</p>
                </div>
              ))}
          </div>
        </details>
      </section>

      {/* Lightbox 原图全屏查看弹窗 */}
      <Dialog open={!!activeLightbox} onOpenChange={(open) => !open && setActiveLightbox(null)}>
        <DialogContent className='max-w-4xl p-4'>
          <DialogHeader>
            <DialogTitle>{activeLightbox?.title ?? '证据截图预览'}</DialogTitle>
          </DialogHeader>
          <div className='relative flex min-h-[400px] max-h-[75vh] items-center justify-center overflow-auto rounded bg-black/90 p-2'>
            {activeLightbox?.imageUrl ? (
              <img
                src={activeLightbox.imageUrl}
                alt={activeLightbox.title}
                style={{ transform: `scale(${zoomLevel})` }}
                className='max-h-full max-w-full object-contain transition-transform duration-150'
              />
            ) : null}
          </div>
          <div className='flex items-center justify-between pt-2'>
            <p className='text-label text-muted-foreground'>{activeLightbox?.caption}</p>
            <div className='flex items-center gap-1'>
              <Button
                variant='outline'
                size='icon'
                className='size-8'
                aria-label='缩小'
                onClick={() => setZoomLevel((z) => Math.max(0.5, z - 0.25))}
              >
                <ZoomOut className='size-4' />
              </Button>
              <Button
                variant='outline'
                size='icon'
                className='size-8'
                aria-label='重置'
                onClick={() => setZoomLevel(1)}
              >
                <RotateCcw className='size-3.5' />
              </Button>
              <Button
                variant='outline'
                size='icon'
                className='size-8'
                aria-label='放大'
                onClick={() => setZoomLevel((z) => Math.min(3, z + 0.25))}
              >
                <ZoomIn className='size-4' />
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
