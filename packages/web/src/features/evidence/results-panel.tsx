import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  RUN_STATUSES,
  type OutcomeStatus,
  type RunStatus,
  type RunSummaryDto,
} from '@cairn/shared'
import { ExternalLink, ListOrdered, Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { fetchRuns } from '@/lib/runs-api'
import { fetchTargets } from '@/lib/targets-api'
import { fetchScenarios } from '@/lib/scenarios-api'
import { StepTimeline } from '@/features/runs/step-timeline'
import { useRunObservation } from '@/features/runs/use-run-observation'
import {
  RUN_EVIDENCE_STATUS_LABELS,
  RUN_STATUS_LABELS,
  formatDuration,
  runEvidenceStatusTone,
  runStatusTone,
} from '@/features/runs/labels'
import {
  RUN_OUTCOME_STATUS_LABELS,
  runOutcomeStatusTone,
} from '@/features/runs/outcome-labels'
import { formatWhen } from './labels'
import type { EvidencePageSearch } from './search-state'

function RunDetailDrawerContent({ runSummary }: { runSummary: RunSummaryDto }) {
  const { run, evidence, query } = useRunObservation(runSummary.id)

  return (
    <div className='flex h-full flex-col gap-4 overflow-y-auto pr-1'>
      <div className='space-y-2 rounded-lg border border-border-card bg-surface-subtle/50 p-4 text-label'>
        <div className='flex flex-wrap items-center gap-2'>
          <StatusBadge tone={runStatusTone(runSummary.status)}>
            {RUN_STATUS_LABELS[runSummary.status]}
          </StatusBadge>
          {runSummary.outcomeStatus !== 'NOT_EVALUATED' ? (
            <StatusBadge tone={runOutcomeStatusTone(runSummary.outcomeStatus)}>
              {RUN_OUTCOME_STATUS_LABELS[runSummary.outcomeStatus as OutcomeStatus]}
            </StatusBadge>
          ) : null}
          {runSummary.scenarioVersionKind === 'trial' ? (
            <StatusBadge tone='neutral'>试跑</StatusBadge>
          ) : null}
        </div>
        <p className='font-medium text-foreground'>
          {runSummary.targetName} · {runSummary.scenarioName}
        </p>
        <p className='text-muted-foreground'>
          触发时间：{formatWhen(runSummary.createdAt)}
          {runSummary.startedAt && runSummary.finishedAt ? (
            <> · 耗时 {formatDuration(runSummary.startedAt, runSummary.finishedAt)}</>
          ) : null}
        </p>
        <div className='pt-2'>
          <Button asChild variant='outline' size='sm' className='h-8 gap-1.5 text-label'>
            <Link to='/runs/$runId' params={{ runId: runSummary.id }}>
              <span>前往完整运行工作台</span>
              <ExternalLink className='size-3.5' />
            </Link>
          </Button>
        </div>
      </div>

      <section className='space-y-2.5'>
        <div className='flex items-center gap-2'>
          <ListOrdered className='size-4 text-primary' />
          <h3 className='font-semibold text-body'>全景执行流水线</h3>
          {run ? (
            <span className='rounded-full bg-surface-subtle px-2 py-0.5 text-label text-muted-foreground'>
              共 {run.stepRuns.length} 步
            </span>
          ) : null}
        </div>

        {query.isPending ? (
          <div className='flex items-center justify-center gap-2 rounded-lg border border-border-card bg-surface-subtle/40 p-8 text-label text-muted-foreground'>
            <Loader2 className='size-4 animate-spin text-primary' />
            <span>正在加载运行流水线与步骤详情...</span>
          </div>
        ) : query.isError || !run ? (
          <p className='rounded-lg border border-border-card bg-surface-subtle/40 p-4 text-label text-muted-foreground'>
            无法加载本次运行的完整步骤。你可以点击上方按钮直接前往运行工作台。
          </p>
        ) : (
          <div className='rounded-lg border border-border-card bg-card p-3 shadow-xs'>
            <StepTimeline run={run} evidenceItems={evidence?.items ?? []} />
          </div>
        )}
      </section>
    </div>
  )
}

export function ResultsCenterPanel({
  search,
  patch,
}: {
  search: EvidencePageSearch
  patch: (next: Partial<EvidencePageSearch>, options?: { replace?: boolean }) => void
}) {
  const [selectedRun, setSelectedRun] = useState<RunSummaryDto | null>(null)

  const targets = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
  })

  const scenarios = useQuery({
    queryKey: ['scenarios', { limit: 100 }],
    queryFn: () => fetchScenarios({ limit: 100 }),
  })

  const targetId = search.targetId
  const scenarioId = search.scenarioId
  const status = search.runStatuses ? (search.runStatuses.split(',')[0] as RunStatus) : undefined
  const cursor = search.cursor

  const runsQuery = useQuery({
    queryKey: ['runs', 'results-center', { targetId, scenarioId, status, cursor }],
    queryFn: () =>
      fetchRuns({
        targetId,
        scenarioId,
        status,
        limit: 20,
        cursor,
      }),
  })

  const items = runsQuery.data?.items ?? []
  const hasFilter = Boolean(targetId || scenarioId || status)

  return (
    <div className='flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden'>
      {/* 筛选栏 */}
      <div className='flex shrink-0 flex-wrap items-center gap-2.5'>
        {/* 目标筛选 */}
        <Select
          value={targetId ?? 'all'}
          onValueChange={(val) => patch({ targetId: val === 'all' ? undefined : val, cursor: undefined })}
        >
          <SelectTrigger className='h-8 w-40' aria-label='目标系统'>
            <SelectValue placeholder='全部目标' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>全部目标</SelectItem>
            {(targets.data?.items ?? []).map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 场景筛选 */}
        <Select
          value={scenarioId ?? 'all'}
          onValueChange={(val) => patch({ scenarioId: val === 'all' ? undefined : val, cursor: undefined })}
        >
          <SelectTrigger className='h-8 w-44' aria-label='业务场景'>
            <SelectValue placeholder='全部场景' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>全部场景</SelectItem>
            {(scenarios.data?.items ?? []).map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* 运行状态筛选 */}
        <Select
          value={status ?? 'all'}
          onValueChange={(val) => patch({ runStatuses: val === 'all' ? undefined : val, cursor: undefined })}
        >
          <SelectTrigger className='h-8 w-32' aria-label='运行状态'>
            <SelectValue placeholder='全部状态' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='all'>全部状态</SelectItem>
            {RUN_STATUSES.map((st) => (
              <SelectItem key={st} value={st}>
                {RUN_STATUS_LABELS[st]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasFilter ? (
          <Button
            size='sm'
            variant='ghost'
            className='h-8 gap-1 text-label text-muted-foreground hover:text-foreground'
            onClick={() => patch({ targetId: undefined, scenarioId: undefined, runStatuses: undefined, cursor: undefined })}
          >
            <RotateCcw className='size-3' />
            <span>重置</span>
          </Button>
        ) : null}
      </div>

      {/* 主表格 */}
      {runsQuery.isPending ? (
        <PageSkeleton />
      ) : runsQuery.isError ? (
        <QueryErrorState title='无法加载执行结果' onRetry={() => void runsQuery.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title='暂无符合条件的运行结果'
          description='尝试调整筛选条件，或在场景工作台中发起新的运行。'
        />
      ) : (
        <section
          aria-label='运行结果列表'
          className='min-h-0 min-w-0 flex-1 overflow-auto rounded-lg border border-border-card bg-card shadow-card'
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-28'>运行状态</TableHead>
                <TableHead>目标与场景</TableHead>
                <TableHead className='w-24'>执行耗时</TableHead>
                <TableHead className='whitespace-nowrap'>触发时间</TableHead>
                <TableHead className='w-28'>证据完整性</TableHead>
                <TableHead className='w-32 text-right'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const duration = formatDuration(item.startedAt, item.finishedAt)
                return (
                  <TableRow
                    key={item.id}
                    tabIndex={0}
                    aria-label={`${item.targetName} ${item.scenarioName}`}
                    className='cursor-pointer'
                    onClick={() => setSelectedRun(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedRun(item)
                      }
                    }}
                  >
                    <TableCell>
                      <div className='flex flex-col items-start gap-1'>
                        <StatusBadge tone={runStatusTone(item.status)}>
                          {RUN_STATUS_LABELS[item.status]}
                        </StatusBadge>
                        {item.outcomeStatus !== 'NOT_EVALUATED' ? (
                          <StatusBadge tone={runOutcomeStatusTone(item.outcomeStatus)}>
                            {RUN_OUTCOME_STATUS_LABELS[item.outcomeStatus as OutcomeStatus]}
                          </StatusBadge>
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell>
                      <p className='font-medium text-label'>{item.targetName}</p>
                      <p className='text-label text-muted-foreground'>
                        {item.scenarioName}
                        {item.scenarioVersionKind === 'trial' ? ' · 试跑' : ''}
                      </p>
                    </TableCell>

                    <TableCell className='text-label text-muted-foreground'>
                      {duration ?? (item.startedAt ? '执行中...' : '排队中')}
                    </TableCell>

                    <TableCell className='whitespace-nowrap text-label text-muted-foreground'>
                      {formatWhen(item.createdAt)}
                    </TableCell>

                    <TableCell>
                      <StatusBadge tone={runEvidenceStatusTone(item.evidenceStatus, item.status)}>
                        {RUN_EVIDENCE_STATUS_LABELS[item.evidenceStatus]}
                      </StatusBadge>
                    </TableCell>

                    <TableCell className='whitespace-nowrap text-right'>
                      <div
                        className='inline-flex items-center justify-end gap-1'
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant='ghost'
                          size='sm'
                          className='h-7 px-2 text-label text-primary hover:text-primary-700'
                          onClick={() => setSelectedRun(item)}
                        >
                          查看流水线
                        </Button>
                        <Link
                          to='/runs/$runId'
                          params={{ runId: item.id }}
                          className='inline-flex h-7 items-center px-1.5 text-label text-muted-foreground hover:text-primary hover:underline'
                          title='查看运行工作台'
                        >
                          去运行
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </section>
      )}

      {/* 底部翻页 */}
      {items.length > 0 || search.cursor ? (
        <CursorPagination
          className='shrink-0'
          pageIndex={search.cursor ? 1 : 0}
          pageSize={20}
          sizes={[20]}
          hasPreviousPage={Boolean(search.cursor)}
          hasNextPage={Boolean(runsQuery.data?.nextCursor)}
          updating={runsQuery.isFetching && runsQuery.isPlaceholderData}
          onPageSizeChange={() => undefined}
          onPreviousPage={() => patch({ cursor: undefined })}
          onNextPage={() => {
            if (runsQuery.data?.nextCursor) {
              patch({ cursor: runsQuery.data.nextCursor })
            }
          }}
        />
      ) : null}

      {/* 侧边流水线抽屉 */}
      <Sheet
        open={Boolean(selectedRun)}
        onOpenChange={(open) => {
          if (!open) setSelectedRun(null)
        }}
      >
        <SheetContent className='w-full sm:max-w-2xl' side='right'>
          <SheetHeader>
            <SheetTitle>运行详情与现场流水线</SheetTitle>
            <SheetDescription>
              检查本次运行的完整步骤序列、每步尝试耗时、报错定位与现场截图。
            </SheetDescription>
          </SheetHeader>
          <div className='min-h-0 flex-1 overflow-hidden px-6 pb-6 pt-2'>
            {selectedRun ? <RunDetailDrawerContent runSummary={selectedRun} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
