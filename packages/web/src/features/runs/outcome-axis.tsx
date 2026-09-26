import {
  candidateGroupsOf,
  expectKindLabel,
  joinOutcomeEvaluations,
  loopBodyHeadersOf,
  joinRuntimeInvariantEvaluations,
  STEP_SKIP_REASON_LABELS,
  type JoinedOutcomeEvaluation,
  faceScreenshot,
  type OutcomeStatus,
  type RunDetailDto,
} from '@cairn/shared'
import { RUNTIME_INVARIANT_KIND_LABELS } from '@/features/authoring/invariant-editor'
import { StatusBadge } from '@/components/status-badge'
import type { EvidenceMetadata } from '@cairn/shared'
import {
  RUN_OUTCOME_STATUS_HINTS,
  RUN_OUTCOME_STATUS_LABELS,
  runOutcomeStatusTone,
} from './outcome-labels'

export {
  RUN_EXECUTION_AXIS_LABELS,
  RUN_OUTCOME_STATUS_HINTS,
  RUN_OUTCOME_STATUS_LABELS,
  runOutcomeStatusTone,
} from './outcome-labels'

function evidenceForOutcomeResult(
  result: { evidenceId?: string | null; attemptId?: string | null } | undefined,
  evidenceItems: EvidenceMetadata[] | undefined,
): EvidenceMetadata[] {
  if (!evidenceItems?.length || !result) return []
  if (result.evidenceId) {
    const matched = evidenceItems.filter((item) => item.id === result.evidenceId)
    if (matched.length > 0) return matched
  }
  const face = result.attemptId ? faceScreenshot(evidenceItems, result.attemptId) : undefined
  return face ? [face] : []
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '无'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '无法展示'
  }
}

function formatExpected(value: unknown, kindLabel: string): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) return kindLabel
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return kindLabel
}

function outcomeStatusHint(status: OutcomeStatus, hasContracts?: boolean): string {
  if (status !== 'NOT_EVALUATED') return RUN_OUTCOME_STATUS_HINTS[status]
  return hasContracts
    ? '业务条件还没评完（还没跑到，或历史运行未纳入结果轴）。'
    : RUN_OUTCOME_STATUS_HINTS.NOT_EVALUATED
}

export function OutcomeAxisSummary({
  executionLabel,
  outcomeStatus,
  hasContracts,
}: {
  executionLabel: string
  outcomeStatus: OutcomeStatus
  hasContracts?: boolean
}) {
  return (
    <div className='grid gap-3 sm:grid-cols-2'>
      <div className='rounded-md border border-border-card bg-muted/30 p-3' aria-label='执行轴'>
        <p className='text-label text-muted-foreground'>执行</p>
        <p className='mt-1 text-body font-medium'>{executionLabel}</p>
      </div>
      <div className='rounded-md border border-border-card bg-muted/30 p-3' aria-label='业务结果轴'>
        <p className='text-label text-muted-foreground'>业务结果</p>
        <div className='mt-1 flex flex-wrap items-center gap-2'>
          <StatusBadge tone={runOutcomeStatusTone(outcomeStatus)}>
            {RUN_OUTCOME_STATUS_LABELS[outcomeStatus]}
          </StatusBadge>
        </div>
        <p className='mt-1 text-label text-muted-foreground'>
          {outcomeStatusHint(outcomeStatus, hasContracts)}
        </p>
      </div>
    </div>
  )
}

export function OutcomeConditionList({
  runId: _runId,
  run,
  evidenceItems,
  onEdit,
  onFocusEvidence,
}: {
  runId: string
  run: Pick<RunDetailDto, 'snapshot' | 'outcomeResults'> & {
    stepRuns?: RunDetailDto['stepRuns']
  }
  evidenceItems?: EvidenceMetadata[]
  onEdit?: (item: JoinedOutcomeEvaluation) => void
  onFocusEvidence?: (evidenceId: string) => void
}) {
  const rows = joinOutcomeEvaluations(
    run.snapshot.outcomeManifest,
    run.outcomeResults,
    run.stepRuns,
    candidateGroupsOf(run.snapshot),
    loopBodyHeadersOf(run.snapshot.controlFlow),
  )
  const invariantRows = joinRuntimeInvariantEvaluations(
    run.snapshot.runtimeInvariantManifest,
    run.outcomeResults,
  )
  if (rows.length === 0 && invariantRows.length === 0) {
    return <p className='text-small text-muted-foreground'>这次运行没有成功条件或运行期约束。</p>
  }
  return (
    <div className='space-y-4'>
    {rows.length > 0 ? (
    <ul className='space-y-3' aria-label='成功条件判定'>
      {rows.map((row) => {
        const evidence = evidenceForOutcomeResult(row.result, evidenceItems)
        const expectLabel =
          row.entry.rule.kind === 'deterministic'
            ? expectKindLabel(row.entry.rule.expect.kind)
            : '按业务指令判断'
        return (
          <li
            key={row.entry.contractId}
            className='space-y-2 rounded-md border border-border-card p-3'
          >
            <div className='flex flex-wrap items-start justify-between gap-2'>
              <p className='text-body font-medium'>{row.entry.meaning}</p>
              <StatusBadge tone={runOutcomeStatusTone(row.displayVerdict)}>
                {row.displayVerdict === 'NOT_EVALUATED'
                  ? '未求值'
                  : row.displayVerdict === 'UNKNOWN'
                    ? '无法判断'
                    : row.displayVerdict === 'NOT_APPLICABLE'
                      ? '不适用'
                      : RUN_OUTCOME_STATUS_LABELS[row.displayVerdict]}
              </StatusBadge>
            </div>
            <p className='text-label text-muted-foreground'>
              {expectLabel}
              {' · '}
              期望 {formatExpected(row.result?.expected ?? (row.entry.rule.kind === 'deterministic' ? row.entry.rule.expect : undefined), expectLabel)}
              {' · '}
              实际 {formatValue(row.result?.actual)}
            </p>
            {row.displayVerdict === 'NOT_EVALUATED' ? (
              <p className='text-label text-muted-foreground'>运行尚未执行到这条条件。</p>
            ) : null}
            {row.evaluationCount && row.evaluationCount > 1 ? (
              <details className='text-label text-muted-foreground'>
                <summary className='cursor-pointer'>求值 {row.evaluationCount} 次</summary>
                <ul className='mt-1 space-y-1'>
                  {(row.history ?? []).map((item, index) => (
                    <li key={`${item.attemptId ?? index}-${item.evaluatedAt ?? index}`}>
                      第 {index + 1} 次：{item.verdict}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {row.displayVerdict === 'NOT_APPLICABLE' ? (
              <p className='text-label text-muted-foreground'>
                不适用（{row.notApplicableReason ? STEP_SKIP_REASON_LABELS[row.notApplicableReason] : '已跳过'}）
              </p>
            ) : null}
            {row.displayVerdict === 'UNKNOWN' ? (
              <p className='text-label text-muted-foreground'>
                取值或定位没有完成，不能把这种情况记成业务不通过。
              </p>
            ) : null}
            {evidence && evidence.length > 0 ? (
              <button
                type='button'
                className='text-label text-primary hover:underline'
                onClick={() => evidence[0] && onFocusEvidence?.(evidence[0].id)}
              >
                查看对应步骤证据
              </button>
            ) : null}
            {onEdit && row.displayVerdict === 'FAIL' ? (
              <button
                type='button'
                className='text-label text-primary hover:underline'
                onClick={() => onEdit(row)}
              >
                修改这条规则
              </button>
            ) : null}
          </li>
        )
      })}
    </ul>
    ) : null}
    {invariantRows.length > 0 ? (
      <ul className='space-y-3' aria-label='运行期约束判定'>
        {invariantRows.map((row) => {
          const evidence = evidenceForOutcomeResult(row.result, evidenceItems)
          return (
            <li key={row.entry.id} className='space-y-2 rounded-md border border-border-card p-3'>
              <div className='flex flex-wrap items-start justify-between gap-2'>
                <p className='text-body font-medium'>{row.entry.meaning}</p>
                <StatusBadge tone={runOutcomeStatusTone(row.displayVerdict)}>
                  {row.displayVerdict === 'NOT_EVALUATED'
                    ? '未求值'
                    : row.displayVerdict === 'UNKNOWN'
                      ? '无法判断'
                      : row.displayVerdict === 'NOT_APPLICABLE'
                        ? '不适用'
                        : RUN_OUTCOME_STATUS_LABELS[row.displayVerdict]}
                </StatusBadge>
              </div>
              <p className='text-label text-muted-foreground'>
                {RUNTIME_INVARIANT_KIND_LABELS[row.entry.kind]}
                {' · '}
                期望 {formatExpected(row.result?.expected, RUNTIME_INVARIANT_KIND_LABELS[row.entry.kind])}
                {' · '}
                实际 {formatValue(row.result?.actual)}
              </p>
              {row.displayVerdict === 'NOT_EVALUATED' ? (
                <p className='text-label text-muted-foreground'>这次运行还没有观察到这条约束。</p>
              ) : null}
              {row.displayVerdict === 'NOT_APPLICABLE' ? (
                <p className='text-label text-muted-foreground'>所在步骤已被跳过或停用，此约束不适用。</p>
              ) : null}
              {evidence && evidence.length > 0 ? (
                <button
                  type='button'
                  className='text-label text-primary hover:underline'
                  onClick={() => evidence[0] && onFocusEvidence?.(evidence[0].id)}
                >
                  查看对应步骤证据
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
    ) : null}
    </div>
  )
}
