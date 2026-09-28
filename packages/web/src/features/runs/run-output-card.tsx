import { useState } from 'react'
import { projectRunOutput, type FindingSeverity, type OutcomeStatus, type OutputStatus, type RunFinding, type RunOutput, type RunStatus } from '@cairn/shared'
import {
  Activity,
  Camera,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FileSpreadsheet,
  TrendingUp,
} from 'lucide-react'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Button } from '@/components/ui/button'

const OUTPUT_STATUS_MAP: Record<OutputStatus, { label: string; tone: StatusTone }> = {
  NORMAL: { label: '业务正常', tone: 'success' },
  WARNING: { label: '业务警告', tone: 'warning' },
  ANOMALOUS: { label: '业务异常', tone: 'error' },
  UNDETERMINED: { label: '业务未判定', tone: 'neutral' },
}

const FINDING_SEVERITY_MAP: Record<FindingSeverity, { label: string; tone: StatusTone }> = {
  INFO: { label: '提示', tone: 'info' },
  WARN: { label: '警告', tone: 'warning' },
  HIGH: { label: '严重', tone: 'error' },
  FATAL: { label: '致命', tone: 'error' },
}

export type RunOutputCardProps = {
  output?: RunOutput | null
  runStatus: RunStatus
  outcomeStatus: OutcomeStatus
  onFocusEvidence?: (evidenceId: string) => void
  onFocusStep?: (stepOrdinal: number) => void
}

export function RunOutputCard({ output, runStatus, outcomeStatus, onFocusEvidence, onFocusStep }: RunOutputCardProps) {
  const [dataRowExpanded, setDataRowExpanded] = useState(false)

  if (!output) {
    return null
  }

  const projectedOutput = projectRunOutput(output, runStatus, outcomeStatus)
  const statusConfig = OUTPUT_STATUS_MAP[projectedOutput.status]
  const summary = projectedOutput.summary

  const metricEntries = Object.entries(output.metrics || {})
  const hasMetrics = metricEntries.length > 0
  const findings = output.findings || []
  const hasFindings = findings.length > 0
  const dataRowEntries = Object.entries(output.dataRow || {})
  const hasDataRow = dataRowEntries.length > 0

  let formattedDate: string
  try {
    formattedDate = new Date(output.assembledAt).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
  } catch {
    formattedDate = output.assembledAt
  }

  return (
    <section
      data-testid='run-output-card'
      className='space-y-4 rounded-lg border border-border-card bg-card p-5 shadow-card'
    >
      {/* 1. 标题栏与评价状态 */}
      <div className='flex flex-wrap items-center justify-between gap-2 border-b border-border-card/60 pb-3'>
        <div className='flex items-center gap-2'>
          <ClipboardCheck className='size-5 text-primary' />
          <h2 className='text-section font-semibold text-foreground'>业务产出与巡检指标</h2>
        </div>
        <div className='flex items-center gap-3'>
          {formattedDate && (
            <span className='text-label text-muted-foreground'>装配于 {formattedDate}</span>
          )}
          <StatusBadge tone={statusConfig.tone}>{statusConfig.label}</StatusBadge>
        </div>
      </div>

      {/* 2. 一句话业务结论 */}
      <div className='rounded-md border border-border-card/80 bg-muted/30 p-4'>
        <div className='text-label font-medium text-muted-foreground mb-1'>业务结论</div>
        <p className='text-body font-medium text-foreground leading-relaxed' data-testid='run-output-summary'>
          {summary}
        </p>
      </div>

      {/* 3. 核心业务指标矩阵 */}
      {hasMetrics && (
        <div className='space-y-2'>
          <div className='flex items-center gap-1.5 text-label font-medium text-muted-foreground'>
            <TrendingUp className='size-4 text-primary' />
            <span>核心指标 ({metricEntries.length})</span>
          </div>
          <div className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'>
            {metricEntries.map(([key, val]) => (
              <div
                key={key}
                data-testid={`metric-card-${key}`}
                className='flex flex-col justify-between rounded-md border border-border-card bg-muted/20 p-3 shadow-sm'
              >
                <span className='text-label text-muted-foreground truncate' title={key}>
                  {key}
                </span>
                <span className='mt-1 text-section font-bold font-mono text-foreground'>
                  {typeof val === 'boolean' ? (val ? '是' : '否') : String(val)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 4. 业务发现项清单 */}
      {hasFindings && (
        <div className='space-y-2'>
          <div className='flex items-center gap-1.5 text-label font-medium text-muted-foreground'>
            <Activity className='size-4 text-primary' />
            <span>业务发现项 ({findings.length})</span>
          </div>
          <div className='space-y-2'>
            {findings.map((finding: RunFinding) => {
              const sev = FINDING_SEVERITY_MAP[finding.severity] ?? {
                label: finding.severity,
                tone: 'neutral' as StatusTone,
              }
              return (
                <div
                  key={finding.id}
                  data-testid={`finding-item-${finding.id}`}
                  className='flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-md border border-border-card/80 bg-muted/15 p-3'
                >
                  <div className='space-y-1 min-w-0 flex-1'>
                    <div className='flex items-center gap-2'>
                      <StatusBadge tone={sev.tone}>{sev.label}</StatusBadge>
                      {finding.stepOrdinal !== undefined && (
                        <button
                          type='button'
                          onClick={() => onFocusStep?.(finding.stepOrdinal!)}
                          className='rounded bg-muted px-1.5 py-0.5 text-label font-mono text-muted-foreground hover:text-foreground'
                        >
                          第 {finding.stepOrdinal + 1} 步
                        </button>
                      )}
                      <span className='font-semibold text-body text-foreground truncate'>
                        {finding.title}
                      </span>
                    </div>
                    {finding.detail && (
                      <p className='text-label text-muted-foreground line-clamp-2'>
                        {finding.detail}
                      </p>
                    )}
                  </div>
                  {finding.evidenceId && (
                    <div className='shrink-0'>
                      <Button
                        variant='outline'
                        size='sm'
                        className='h-7 text-label gap-1'
                        onClick={() => onFocusEvidence?.(finding.evidenceId!)}
                      >
                        <Camera className='size-3.5' />
                        查看现场
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 5. 单行提取数据宽表 */}
      {hasDataRow && (
        <div className='space-y-2 border-t border-border-card/60 pt-3'>
          <button
            type='button'
            onClick={() => setDataRowExpanded(!dataRowExpanded)}
            className='flex items-center gap-1.5 text-label font-medium text-muted-foreground hover:text-foreground transition-colors'
          >
            <FileSpreadsheet className='size-4 text-primary' />
            <span>提取数据 ({dataRowEntries.length} 字段)</span>
            {dataRowExpanded ? <ChevronDown className='size-3.5' /> : <ChevronRight className='size-3.5' />}
          </button>
          {dataRowExpanded && (
            <div className='mt-2 rounded-md border border-border-card bg-muted/20 overflow-x-auto'>
              <table className='w-full text-label'>
                <thead>
                  <tr className='border-b border-border-card/80 bg-muted/40'>
                    <th className='px-3 py-2 text-left font-semibold text-muted-foreground'>字段键</th>
                    <th className='px-3 py-2 text-left font-semibold text-muted-foreground'>数据值</th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-border-card/40'>
                  {dataRowEntries.map(([k, v]) => (
                    <tr key={k} className='hover:bg-muted/30 transition-colors'>
                      <td className='px-3 py-2 font-mono font-medium text-foreground whitespace-nowrap'>{k}</td>
                      <td className='px-3 py-2 text-foreground break-all'>
                        {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
