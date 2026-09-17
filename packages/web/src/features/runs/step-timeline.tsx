import { useEffect, useMemo, useState } from 'react'
import {
  candidateGroupsOf,
  isAiStepType,
  isSelectionDecision,
  skipReasonForStep,
  type ExecutableStepType,
  type ModuleManifestEntry,
  type RunDetailDto,
  type RunEvidenceListResponse,
  type StepRunDto,
  type StepRunStatus,
} from '@cairn/shared'
import { ChevronDown, ChevronRight, Layers } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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

export function StepTimeline({ run, evidenceItems, focusInvocationId }: StepTimelineProps) {
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
        const shouldExpand = groupStatus !== 'SUCCEEDED' || g.entry.invocationId === focusInvocationId
        state[g.entry.invocationId] = shouldExpand
      }
    }
    return state
  }, [groups, run.status, focusInvocationId])

  const [expanded, setExpanded] = useState<Record<string, boolean>>(initialExpanded)

  useEffect(() => {
    if (!focusInvocationId) return
    setExpanded((prev) => ({ ...prev, [focusInvocationId]: true }))
    document.getElementById(`module-group-${focusInvocationId}`)?.scrollIntoView({ block: 'nearest' })
  }, [focusInvocationId])

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
}: {
  entry: ModuleManifestEntry
  stepRuns: StepRunDto[]
  run: RunDetailDto
  evidenceItems: EvidenceItem[]
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
      <StepRunItem key={step.id} step={step} runId={run.id} evidenceItems={evidenceItems} />
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
}: {
  step: StepRunDto
  runId: string
  evidenceItems: EvidenceItem[]
  skipReason?: keyof typeof SKIP_REASON_LABELS
}) {
  return (
    <li className='rounded-md border border-border-card bg-background p-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='font-medium'>
          {step.ordinal + 1}. {step.name}
        </span>
        <StatusBadge tone={stepRunStatusTone(step.status)}>
          {STEP_RUN_STATUS_LABELS[step.status]}
        </StatusBadge>
        {skipReason ? (
          <Badge variant='outline'>{SKIP_REASON_LABELS[skipReason]}</Badge>
        ) : null}
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
        <div key={attempt.id} className='mt-2 rounded-sm bg-muted/40 p-2 text-label'>
          <p>
            Attempt #{attempt.attemptNo} · {ATTEMPT_STATUS_LABELS[attempt.status]}
            {formatDuration(attempt.startedAt, attempt.finishedAt)
              ? ` · ${formatDuration(attempt.startedAt, attempt.finishedAt)}`
              : ''}
          </p>
          {attempt.error ? (
            <p className='mt-1 text-destructive'>
              {attempt.error.code}: {attempt.error.safeMessage}
            </p>
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
          />
        </div>
      ))}
    </li>
  )
}
