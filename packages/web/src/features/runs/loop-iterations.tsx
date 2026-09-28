import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { JsonValue, RunDetailDto, RunEvidenceListResponse, StepIterationDto, StepRunDto } from '@cairn/shared'
import { Repeat } from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { cn } from '@/lib/utils'
import { fetchRunIteration, fetchRunIterations } from '@/lib/runs-api'
import { STEP_RUN_STATUS_LABELS, stepRunStatusTone } from './labels'
import { StepRunItem } from './step-timeline'

type EvidenceItem = RunEvidenceListResponse['items'][number]

type LoopIterationsPanelProps = {
  run: RunDetailDto
  headerStepRun: StepRunDto
  evidenceItems: EvidenceItem[]
  focusStepRunId?: string
  focusAttemptId?: string
  focusEvidenceId?: string
  currentStepRunId?: string | null
  onSelectStep?: (stepRunId: string, attemptId?: string) => void
}

const MAX_ITERATIONS = 200

/** 循环头下的迭代视图：汇总、逐项状态条，选中一项后才加载该项的步骤与尝试。 */
export function LoopIterationsPanel({
  run,
  headerStepRun,
  evidenceItems,
  focusStepRunId,
  focusAttemptId,
  focusEvidenceId,
  currentStepRunId,
  onSelectStep,
}: LoopIterationsPanelProps) {
  const block = run.snapshot.controlFlow?.blocks.find(
    (item) => (item.kind === 'for_each' || item.kind === 'repeat') && item.headerStepId === headerStepRun.stepId,
  )
  const blockId = block?.blockId
  const summary = blockId ? run.iterationsSummary?.[blockId] : undefined
  // 汇总变化（新一项开始或结束）时重新取列表；SSE 推动运行详情刷新后这里随之更新。
  const summaryKey = summary
    ? `${summary.total}-${summary.succeeded}-${summary.failed}-${summary.skipped}-${summary.running}`
    : 'none'

  const listQuery = useQuery({
    queryKey: ['run-iterations', run.id, blockId, summaryKey],
    queryFn: () => fetchRunIterations(run.id, { blockId, limit: MAX_ITERATIONS, offset: 0 }),
    enabled: Boolean(blockId),
  })
  const iterations = listQuery.data?.iterations ?? []

  const defaultSelection = useMemo(() => pickDefaultIteration(iterations), [iterations])
  // 用户选中的迭代不在当前列表里（首次加载或列表刷新）时回落到默认迭代。
  const [pickedId, setSelectedId] = useState<string | undefined>(undefined)
  const selectedId =
    pickedId && iterations.some((item) => item.id === pickedId) ? pickedId : defaultSelection

  const selected = iterations.find((item) => item.id === selectedId)
  const detailQuery = useQuery({
    queryKey: ['run-iteration', run.id, selectedId, selected?.status],
    queryFn: () => fetchRunIteration(run.id, selectedId!),
    enabled: Boolean(selectedId),
  })

  if (!blockId) return null
  const kindLabel = block?.kind === 'repeat' ? '重复执行' : '逐项处理'

  return (
    <li className='rounded-md border border-border-card bg-card/60 p-3 shadow-xs' data-testid='loop-iterations'>
      <div className='flex flex-wrap items-center gap-2'>
        <Repeat className='size-4 text-primary' />
        <span className='font-medium text-body'>
          {kindLabel} {summary?.total ?? iterations.length} 项
        </span>
        {summary ? (
          <span className='text-label text-muted-foreground'>
            成功 {summary.succeeded} · 失败 {summary.failed} · 未执行 {summary.skipped}
            {summary.running > 0 ? ` · 进行中 ${summary.running}` : ''}
          </span>
        ) : null}
        {summary?.stoppedEarly ? <StatusBadge tone='neutral'>提前结束</StatusBadge> : null}
        {summary?.limitReached ? <StatusBadge tone='warning'>达到上限</StatusBadge> : null}
      </div>

      {listQuery.isError ? (
        <p className='mt-2 text-label text-destructive'>迭代记录加载失败</p>
      ) : iterations.length === 0 ? (
        <p className='mt-2 text-label text-muted-foreground'>
          {listQuery.isLoading ? '正在加载迭代记录…' : '本次没有执行任何一项'}
        </p>
      ) : (
        <div className='mt-3 flex flex-wrap gap-1.5' role='listbox' aria-label='迭代'>
          {iterations.map((item) => (
            <button
              key={item.id}
              type='button'
              role='option'
              aria-selected={item.id === selectedId}
              title={`第 ${item.iterationIndex + 1} 项 · ${STEP_RUN_STATUS_LABELS[item.status]}`}
              onClick={() => setSelectedId(item.id)}
              className={cn(
                'min-w-8 rounded-sm border px-1.5 py-0.5 text-label tabular-nums',
                iterationChipTone(item),
                item.id === selectedId && 'ring-2 ring-primary/40',
              )}
            >
              {item.iterationIndex + 1}
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <div className='mt-3 space-y-2 border-t border-border-card/60 pt-3'>
          <div className='flex flex-wrap items-center gap-2 text-label text-muted-foreground'>
            <span className='font-medium text-foreground'>第 {selected.iterationIndex + 1} 项</span>
            <StatusBadge tone={stepRunStatusTone(selected.status)}>{STEP_RUN_STATUS_LABELS[selected.status]}</StatusBadge>
            {selected.item !== undefined ? <span className='truncate'>当前项：{summarize(selected.item)}</span> : null}
            {stopDecisionText(selected.stopDecision) ? <span>{stopDecisionText(selected.stopDecision)}</span> : null}
          </div>
          {detailQuery.isError ? (
            <p className='text-label text-destructive'>该项步骤加载失败</p>
          ) : !detailQuery.data ? (
            <p className='text-label text-muted-foreground'>正在加载该项步骤…</p>
          ) : (
            <ol className='space-y-2 ps-2'>
              {detailQuery.data.stepRuns.map((step) => (
                <StepRunItem
                  key={step.id}
                  step={step}
                  runId={run.id}
                  evidenceItems={evidenceItems}
                  focusStepRunId={focusStepRunId}
                  focusAttemptId={focusAttemptId}
                  focusEvidenceId={focusEvidenceId}
                  currentStepRunId={currentStepRunId}
                  onSelectStep={onSelectStep}
                />
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </li>
  )
}

/** 默认选中第一个失败项；没有失败项时选中最近的一项。 */
function pickDefaultIteration(iterations: readonly StepIterationDto[]): string | undefined {
  const failed = iterations.find((item) => item.status === 'FAILED')
  return (failed ?? iterations[iterations.length - 1])?.id
}

function iterationChipTone(item: StepIterationDto): string {
  // 与 StatusBadge 同一组语义状态 Token
  if (item.status === 'FAILED') return 'border-transparent bg-status-error-background text-status-error-foreground'
  if (item.status === 'SUCCEEDED') return 'border-transparent bg-status-success-background text-status-success-foreground'
  if (item.status === 'RUNNING') return 'border-transparent bg-status-info-background text-status-info-foreground'
  return 'border-border-card bg-muted/40 text-muted-foreground'
}

function summarize(value: JsonValue): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

function stopDecisionText(decision: JsonValue | undefined): string | undefined {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return undefined
  const record = decision as Record<string, JsonValue>
  if (record.evaluated === false) return `结束条件无法判定：${String(record.error ?? '')}`
  if (record.stoppedEarly) return '满足提前结束条件'
  if (record.untilMet) return '满足结束条件'
  if (record.limitReached) return '达到上限'
  if (record.evaluated === true) return '结束条件未满足'
  return undefined
}
