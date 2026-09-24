import { useEffect, useMemo, useState } from 'react'
import {
  candidateGroupsOf,
  isAiStepType,
  isSelectionDecision,
  skipReasonForStep,
  STEP_SKIP_REASON_LABELS,
  type ExecutableStepType,
  type ModuleManifestEntry,
  type RunDetailDto,
  type RunEvidenceListResponse,
  type StepRunDto,
  type StepRunStatus,
} from '@cairn/shared'
import { ChevronDown, ChevronRight, Layers, MessageSquare } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Can } from '@/components/rbac/can'
import { cn } from '@/lib/utils'
import { useAssistantStore } from '@/stores/assistant-store'
import { buildStepQuote } from '@/features/assistant/quote-helper'
import { StatusBadge } from '@/components/status-badge'
import { MODULE_EXECUTION_MODE_LABELS } from '@/features/action-modules/labels'
import { AiAttemptSummary } from './ai-evidence'
import { AttemptEvidenceList } from './evidence-viewer'
import { StepFaceScreenshot, stepFaceScreenshot } from './run-video'
import {
  ATTEMPT_STATUS_LABELS,
  formatDuration,
  STEP_RUN_STATUS_LABELS,
  STEP_TYPE_LABELS,
  stepRunStatusTone,
} from './labels'

type EvidenceItem = RunEvidenceListResponse['items'][number]

type StepTimelineProps = {
  run: RunDetailDto
  evidenceItems: EvidenceItem[]
  focusInvocationId?: string
  focusStepRunId?: string
  focusAttemptId?: string
  focusEvidenceId?: string
  currentStepRunId?: string | null
  onSelectStep?: (stepRunId: string, attemptId?: string) => void
}

type TimelineGroup =
  | { kind: 'module'; entry: ModuleManifestEntry; stepRuns: StepRunDto[] }
  | { kind: 'step'; stepRun: StepRunDto }

function computeGroupStatus(stepRuns: StepRunDto[]): StepRunStatus {
  if (stepRuns.some((s) => s.status === 'FAILED') && !stepRuns.some((s) => s.status === 'SUCCEEDED')) return 'FAILED'
  if (stepRuns.some((s) => s.status === 'FAILED') && stepRuns.some((s) => s.status === 'SUCCEEDED')) return 'SUCCEEDED'
  if (stepRuns.some((s) => s.status === 'RUNNING')) return 'RUNNING'
  if (stepRuns.some((s) => s.status === 'CANCELLED')) return 'CANCELLED'
  if (stepRuns.length > 0 && stepRuns.every((s) => s.status === 'SUCCEEDED' || s.status === 'SKIPPED')) {
    return stepRuns.some((s) => s.status === 'SUCCEEDED') ? 'SUCCEEDED' : 'PENDING'
  }
  if (stepRuns.length > 0 && stepRuns.every((s) => s.status === 'SUCCEEDED')) return 'SUCCEEDED'
  return 'PENDING'
}

const SKIP_REASON_LABELS = {
  fallback: '回退跳过',
  not_attempted: '未尝试',
  not_needed: '不再需要',
} as const

export function StepTimeline({
  run,
  evidenceItems,
  focusInvocationId,
  focusStepRunId,
  focusAttemptId,
  focusEvidenceId,
  currentStepRunId,
  onSelectStep,
}: StepTimelineProps) {
  const manifest = run.snapshot?.moduleManifest
  const entries = manifest?.entries ?? []

  const groups = useMemo<TimelineGroup[]>(() => {
    if (entries.length === 0) {
      return run.stepRuns.map((stepRun) => ({ kind: 'step', stepRun }))
    }

    const stepIdToEntry = new Map<string, ModuleManifestEntry>()
    for (const entry of entries) {
      for (const stepId of entry.expandedStepIds) {
        stepIdToEntry.set(stepId, entry)
      }
    }

    const result: TimelineGroup[] = []
    let currentModuleGroup: { entry: ModuleManifestEntry; stepRuns: StepRunDto[] } | null = null

    for (const stepRun of run.stepRuns) {
      const entry = stepIdToEntry.get(stepRun.stepId)
      if (entry) {
        if (currentModuleGroup && currentModuleGroup.entry.invocationId === entry.invocationId) {
          currentModuleGroup.stepRuns.push(stepRun)
        } else {
          if (currentModuleGroup) {
            result.push({ kind: 'module', ...currentModuleGroup })
          }
          currentModuleGroup = { entry, stepRuns: [stepRun] }
        }
      } else {
        if (currentModuleGroup) {
          result.push({ kind: 'module', ...currentModuleGroup })
          currentModuleGroup = null
        }
        result.push({ kind: 'step', stepRun })
      }
    }
    if (currentModuleGroup) {
      result.push({ kind: 'module', ...currentModuleGroup })
    }
    return result
  }, [entries, run.stepRuns])

  const initialExpanded = useMemo(() => {
    const state: Record<string, boolean> = {}
    for (const g of groups) {
      if (g.kind === 'module') {
        const groupStatus = computeGroupStatus(g.stepRuns)
        const shouldExpand =
          groupStatus !== 'SUCCEEDED' ||
          g.entry.invocationId === focusInvocationId ||
          g.stepRuns.some((step) => step.id === focusStepRunId)
        state[g.entry.invocationId] = shouldExpand
      }
    }
    return state
  }, [groups, run.status, focusInvocationId, focusStepRunId])

  const [expanded, setExpanded] = useState<Record<string, boolean>>(initialExpanded)

  useEffect(() => {
    if (focusInvocationId) {
      setExpanded((prev) => ({ ...prev, [focusInvocationId]: true }))
    }
    const target =
      (focusEvidenceId && document.getElementById(`evidence-${focusEvidenceId}`)) ||
      (focusAttemptId && document.getElementById(`attempt-${focusAttemptId}`)) ||
      (focusStepRunId && document.getElementById(`step-run-${focusStepRunId}`)) ||
      (focusInvocationId && document.getElementById(`module-group-${focusInvocationId}`))
    if (target) target.scrollIntoView({ block: 'nearest' })
  }, [focusInvocationId, focusStepRunId, focusAttemptId, focusEvidenceId])

  const toggleGroup = (invocationId: string) => {
    setExpanded((prev) => ({ ...prev, [invocationId]: !prev[invocationId] }))
  }

  const expandAll = () => {
    const next: Record<string, boolean> = {}
    for (const g of groups) {
      if (g.kind === 'module') next[g.entry.invocationId] = true
    }
    setExpanded(next)
  }

  const collapseAll = () => {
    const next: Record<string, boolean> = {}
    for (const g of groups) {
      if (g.kind === 'module') next[g.entry.invocationId] = false
    }
    setExpanded(next)
  }

  const hasModuleGroups = groups.some((g) => g.kind === 'module')

  return (
    <div className='space-y-3'>
      {hasModuleGroups && (
        <div className='flex items-center justify-between gap-2 text-label text-muted-foreground'>
          <span>步骤已按动作模块分组展示</span>
          <div className='flex items-center gap-2'>
            <Button variant='ghost' size='sm' onClick={expandAll}>
              展开全部
            </Button>
            <Button variant='ghost' size='sm' onClick={collapseAll}>
              折叠全部
            </Button>
          </div>
        </div>
      )}

      <ol className='space-y-3'>
        {groups.map((group, groupIndex) => {
          if (group.kind === 'step') {
            return (
              <StepRunItem
                key={group.stepRun.id}
                step={group.stepRun}
                runId={run.id}
                evidenceItems={evidenceItems}
                focusStepRunId={focusStepRunId}
                focusAttemptId={focusAttemptId}
                focusEvidenceId={focusEvidenceId}
                currentStepRunId={currentStepRunId}
                onSelectStep={onSelectStep}
              />
            )
          }

          const entry = group.entry
          const groupStatus = computeGroupStatus(group.stepRuns)
          const isOpen = expanded[entry.invocationId] ?? false

          return (
            <li
              key={entry.invocationId || groupIndex}
              id={`module-group-${entry.invocationId}`}
              data-focused={focusInvocationId === entry.invocationId ? 'true' : undefined}
              className='rounded-md border border-border-card bg-card/60 p-3 shadow-xs'
            >
              <button
                type='button'
                aria-expanded={isOpen}
                onClick={() => toggleGroup(entry.invocationId)}
                className='flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 text-left'
              >
                <div className='flex flex-wrap items-center gap-2'>
                  {isOpen ? (
                    <ChevronDown className='size-4 text-muted-foreground' />
                  ) : (
                    <ChevronRight className='size-4 text-muted-foreground' />
                  )}
                  <Layers className='size-4 text-primary' />
                  <span className='font-medium text-body'>{entry.name}</span>
                  <Badge variant='outline' className='text-label'>
                    {entry.moduleKey}
                    {entry.versionNo ? `@v${entry.versionNo}` : entry.moduleDraftRevision != null ? ` · 草稿 r${entry.moduleDraftRevision}` : ''}
                  </Badge>
                  <Badge variant='secondary' className='text-label'>
                    {MODULE_EXECUTION_MODE_LABELS[entry.executionMode] ?? entry.executionMode}
                  </Badge>
                  <span className='text-label text-muted-foreground'>
                    步骤 {group.stepRuns.length} · 断言{' '}
                    {group.stepRuns.filter((item) => item.type === 'assert' || item.type === 'ai_assert').length}
                  </span>
                </div>
                <div className='flex items-center gap-2'>
                  <StatusBadge tone={stepRunStatusTone(groupStatus)}>
                    {STEP_RUN_STATUS_LABELS[groupStatus]}
                  </StatusBadge>
                </div>
              </button>

              {isOpen && (
                <ol className='mt-3 space-y-2 border-t border-border-card/60 pt-3 ps-2'>
                  {renderModuleSteps({
                    entry,
                    stepRuns: group.stepRuns,
                    run,
                    evidenceItems,
                    focusStepRunId,
                    focusAttemptId,
                    focusEvidenceId,
                    currentStepRunId,
                    onSelectStep,
                  })}
                </ol>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function renderModuleSteps({
  entry,
  stepRuns,
  run,
  evidenceItems,
  focusStepRunId,
  focusAttemptId,
  focusEvidenceId,
  currentStepRunId,
  onSelectStep,
}: {
  entry: ModuleManifestEntry
  stepRuns: StepRunDto[]
  run: RunDetailDto
  evidenceItems: EvidenceItem[]
  focusStepRunId?: string
  focusAttemptId?: string
  focusEvidenceId?: string
  currentStepRunId?: string | null
  onSelectStep?: (stepRunId: string, attemptId?: string) => void
}) {
  const group = candidateGroupsOf(run.snapshot).find((item) => item.invocationId === entry.invocationId)
  const decision = evidenceItems.map((item) => item.payload).find(isSelectionDecision)
  const selected = decision && decision.invocationId === entry.invocationId ? decision.selected : undefined
  const attemptedKeys =
    decision && decision.invocationId === entry.invocationId
      ? decision.attempts.filter((item) => item.outcome !== 'skipped').map((item) => item.implementationKey)
      : []
  if (!group) {
    return stepRuns.map((step) => (
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
    ))
  }
  return group.alternatives.map((alternative) => {
    const altSteps = stepRuns.filter((step) => alternative.stepIds.includes(step.stepId))
    const selectedAlt = selected === alternative.implementationKey
    return (
      <li key={alternative.implementationKey} className='space-y-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-label font-medium'>实现 {alternative.implementationKey}</span>
          {selectedAlt ? <Badge>最终选中</Badge> : null}
        </div>
        <ol className='space-y-2'>
          {altSteps.map((step) => (
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
              skipReason={skipReasonForStep({
                stepId: step.stepId,
                group,
                stepStatus: step.status,
                selected,
                attemptedKeys,
              })}
            />
          ))}
        </ol>
      </li>
    )
  })
}

function StepRunItem({
  step,
  runId,
  evidenceItems,
  skipReason,
  focusStepRunId,
  focusAttemptId,
  focusEvidenceId,
  currentStepRunId,
  onSelectStep,
}: {
  step: StepRunDto
  runId: string
  evidenceItems: EvidenceItem[]
  skipReason?: keyof typeof SKIP_REASON_LABELS
  focusStepRunId?: string
  focusAttemptId?: string
  focusEvidenceId?: string
  currentStepRunId?: string | null
  onSelectStep?: (stepRunId: string, attemptId?: string) => void
}) {
  const isCurrent = currentStepRunId === step.id
  const setQuote = useAssistantStore((s) => s.setQuote)
  return (
    <li
      id={`step-run-${step.id}`}
      data-focused={focusStepRunId === step.id ? 'true' : undefined}
      data-current={isCurrent ? 'true' : undefined}
      onClick={() => onSelectStep?.(step.id)}
      className={`rounded-md border p-3 transition-colors ${
        isCurrent
          ? 'border-primary ring-2 ring-primary/30 bg-card'
          : 'border-border-card bg-background'
      } ${onSelectStep ? 'cursor-pointer' : ''}`}
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='font-medium'>
            {step.ordinal + 1}. {step.name}
          </span>
          <StatusBadge tone={stepRunStatusTone(step.status)}>
            {STEP_RUN_STATUS_LABELS[step.status]}
          </StatusBadge>
          {step.skipReason === 'optional_absent' ? (
            <Badge variant='outline' className='border-sky-300 bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'>
              未出现，已跳过
            </Badge>
          ) : step.skipReason === 'condition_not_met' ? (
            <Badge variant='outline' className='border-border bg-muted text-muted-foreground'>
              条件不满足，已跳过
            </Badge>
          ) : step.skipReason ? (
            <Badge variant='outline'>{STEP_SKIP_REASON_LABELS[step.skipReason] ?? step.skipReason}</Badge>
          ) : skipReason ? (
            <Badge variant='outline'>{SKIP_REASON_LABELS[skipReason]}</Badge>
          ) : null}
          {(() => {
            const lastAttempt = step.attempts[step.attempts.length - 1]
            const lastOutput = lastAttempt?.output as any
            if (step.type === 'decide' && lastOutput?.branch) {
              return (
                <Badge
                  variant='outline'
                  className={cn(
                    'text-3xs font-medium',
                    lastOutput.branch === 'then'
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                      : 'border-amber-300 bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300'
                  )}
                >
                  {lastOutput.branch === 'then' ? '判定成立 → 执行满足分支' : '判定不成立 → 执行否则分支'}
                </Badge>
              )
            }
            if (step.type === 'probe' && lastOutput && typeof lastOutput.matched === 'boolean') {
              return (
                <Badge
                  variant='outline'
                  className={cn(
                    'text-3xs font-medium',
                    lastOutput.matched
                      ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                      : 'border-border bg-muted text-muted-foreground'
                  )}
                >
                  {lastOutput.matched ? '页面检查通过 (已找到)' : '页面检查未匹配 (不存在)'}
                </Badge>
              )
            }
            if (step.type === 'compute' && lastOutput && 'value' in lastOutput) {
              return (
                <Badge
                  variant='outline'
                  className='text-3xs font-medium border-purple-300 bg-purple-50 text-purple-700 dark:bg-purple-950 dark:text-purple-300'
                >
                  计算值: {typeof lastOutput.value === 'object' ? JSON.stringify(lastOutput.value) : String(lastOutput.value)}
                </Badge>
              )
            }
            return null
          })()}
        </div>
        <Can allOf={['ai:assist']}>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-6 px-1.5 text-label text-muted-foreground hover:text-foreground'
            title='引用到识途助手'
            onClick={(e) => {
              e.stopPropagation()
              const lastAttempt = step.attempts[step.attempts.length - 1]
              const err = lastAttempt?.error ? `${lastAttempt.error.code}: ${lastAttempt.error.safeMessage}` : undefined
              setQuote(buildStepQuote(step, err))
            }}
          >
            <MessageSquare className='mr-1 size-3' />
            引用
          </Button>
        </Can>
      </div>
      <p className='mt-1 text-label text-muted-foreground'>
        {isAiStepType(step.type) ? (
          <StatusBadge tone='ai'>
            {step.type in STEP_TYPE_LABELS
              ? STEP_TYPE_LABELS[step.type as ExecutableStepType]
              : step.type}
          </StatusBadge>
        ) : step.type in STEP_TYPE_LABELS ? (
          STEP_TYPE_LABELS[step.type as ExecutableStepType]
        ) : (
          step.type
        )}
      </p>
      {(() => {
        const face = stepFaceScreenshot(step.attempts, evidenceItems)
        return face ? <StepFaceScreenshot runId={runId} item={face} /> : null
      })()}
      {step.attempts.length === 0 ? (
        <p className='mt-2 text-label text-muted-foreground'>尚未开始尝试。</p>
      ) : null}
      {step.attempts.map((attempt) => (
        <div
          key={attempt.id}
          id={`attempt-${attempt.id}`}
          data-focused={focusAttemptId === attempt.id ? 'true' : undefined}
          onClick={(e) => {
            if (onSelectStep) {
              e.stopPropagation()
              onSelectStep(step.id, attempt.id)
            }
          }}
          className={`mt-2 rounded-sm bg-muted/40 p-2 text-label ${
            onSelectStep ? 'cursor-pointer hover:bg-muted/60' : ''
          }`}
        >
          <p>
            第 {attempt.attemptNo} 次尝试 · {ATTEMPT_STATUS_LABELS[attempt.status]}
            {formatDuration(attempt.startedAt, attempt.finishedAt)
              ? ` · ${formatDuration(attempt.startedAt, attempt.finishedAt)}`
              : ''}
          </p>
          {attempt.error ? (
            <div className='mt-1 flex items-start justify-between gap-2'>
              <p className='text-destructive'>
                {attempt.error.code}: {attempt.error.safeMessage}
                {attempt.error.code === 'ASSERT_TEMPLATE_INVALID' ? (
                  <span className='ml-1 text-label text-muted-foreground'>
                    （快照模板语法非法或根节点非序列，不可重试）
                  </span>
                ) : null}
              </p>
              <Can allOf={['ai:assist']}>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='h-5 shrink-0 px-1.5 text-caption text-destructive hover:bg-muted'
                  title='向助手询问此错误'
                  onClick={(e) => {
                    e.stopPropagation()
                    setQuote(
                      buildStepQuote(
                        step,
                        `第 ${attempt.attemptNo} 次尝试报错 [${attempt.error?.code}]: ${attempt.error?.safeMessage}`
                      )
                    )
                  }}
                >
                  <MessageSquare className='mr-1 size-3' />
                  诊断此错误
                </Button>
              </Can>
            </div>
          ) : null}
          {typeof attempt.output === 'object' &&
          attempt.output !== null &&
          'diff' in attempt.output &&
          typeof (attempt.output as { diff?: unknown }).diff === 'string' ? (
            <div className='mt-2 rounded border border-border/50 bg-background/80 p-2 font-mono text-label'>
              <p className='mb-1 font-sans text-label font-medium text-muted-foreground'>
                Aria 快照比对差异 (Diff):
              </p>
              <pre className='overflow-x-auto whitespace-pre leading-relaxed text-foreground'>
                {(attempt.output as { diff: string }).diff}
              </pre>
            </div>
          ) : null}
          {isAiStepType(step.type) ? (
            <AiAttemptSummary
              output={attempt.output}
              evidence={evidenceItems.filter((item) => item.attemptId === attempt.id)}
            />
          ) : null}
          <AttemptEvidenceList
            runId={runId}
            items={evidenceItems.filter((item) => item.attemptId === attempt.id)}
            focusEvidenceId={focusEvidenceId}
          />
        </div>
      ))}
    </li>
  )
}
