import { useEffect, useMemo, useState } from 'react'
import {
  candidateGroupsOf,
  isAiStepType,
  isSelectionDecision,
  skipReasonForStep,
  stepRunFor,
  STEP_SKIP_REASON_LABELS,
  type ExecutableStepType,
  type ControlFlowIfBlock,
  type ModuleManifestEntry,
  type RunDetailDto,
  type RunEvidenceListResponse,
  type StepRunDto,
  type StepRunStatus,
} from '@cairn/shared'
import { ChevronDown, ChevronRight, GitBranch, Layers, MessageSquare } from 'lucide-react'
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
import { LoopIterationsPanel } from './loop-iterations'
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
  | { kind: 'if'; block: ControlFlowIfBlock; stepRuns: StepRunDto[] }

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

  const ifBlocks = useMemo(() => topLevelIfBlocks(run), [run.snapshot])

  const groups = useMemo<TimelineGroup[]>(() => {
    // 顶层条件块：判定步骤与两段分支在快照里连续，归成一组；块外步骤仍按模块或单步分组。
    const blockOfStep = new Map<string, ControlFlowIfBlock>()
    for (const block of ifBlocks) {
      blockOfStep.set(block.decideStepId, block)
      for (const branch of block.branches) for (const stepId of branch.stepIds) blockOfStep.set(stepId, block)
    }
    if (entries.length === 0 && blockOfStep.size === 0) {
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
      const block = blockOfStep.get(stepRun.stepId)
      if (block) {
        if (currentModuleGroup) {
          result.push({ kind: 'module', ...currentModuleGroup })
          currentModuleGroup = null
        }
        const last = result[result.length - 1]
        if (last?.kind === 'if' && last.block.blockId === block.blockId) last.stepRuns.push(stepRun)
        else result.push({ kind: 'if', block, stepRuns: [stepRun] })
        continue
      }
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
  }, [entries, ifBlocks, run.stepRuns])

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
          if (group.kind === 'if') {
            return (
              <IfBlockGroup
                key={group.block.blockId}
                block={group.block}
                stepRuns={group.stepRuns}
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
          if (group.kind === 'step') {
            const item = (
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
            if (group.stepRun.type !== 'loop') return item
            // 循环体的步骤记录按项存放，不在运行详情里；在循环头下面按需展开。
            return [
              item,
              <LoopIterationsPanel
                key={`${group.stepRun.id}-iterations`}
                run={run}
                headerStepRun={group.stepRun}
                evidenceItems={evidenceItems}
                focusStepRunId={focusStepRunId}
                focusAttemptId={focusAttemptId}
                focusEvidenceId={focusEvidenceId}
                currentStepRunId={currentStepRunId}
                onSelectStep={onSelectStep}
              />,
            ]
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

export function StepRunItem({
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
            <Badge variant='outline' className='border-transparent bg-status-info-background text-status-info-foreground'>
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
                      ? 'border-transparent bg-status-success-background text-status-success-foreground'
                      : 'border-transparent bg-status-warning-background text-status-warning-foreground'
                  )}
                >
                  {lastOutput.branch === 'then'
                    ? '判定成立 → 执行满足分支'
                    : lastOutput.branch === 'else'
                      ? '判定不成立 → 执行否则分支'
                      : '判定不成立 → 跳过满足分支'}
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
                      ? 'border-transparent bg-status-success-background text-status-success-foreground'
                      : 'border-border bg-muted text-muted-foreground'
                  )}
                >
                  {lastOutput.matched ? '页面检查通过 (已找到)' : '页面检查未匹配 (不存在)'}
                </Badge>
              )
            }
            // 计算值步骤的输出就是结果本身（数字、文本、列表……），不是 { value } 包装。
            if (step.type === 'compute' && lastAttempt?.status === 'SUCCEEDED' && lastOutput !== undefined) {
              const shown = typeof lastOutput === 'object' && lastOutput !== null ? JSON.stringify(lastOutput) : String(lastOutput)
              return (
                <Badge
                  variant='outline'
                  className='text-3xs font-medium border-transparent bg-status-info-background text-status-info-foreground'
                >
                  计算值: {shown.length > 80 ? `${shown.slice(0, 77)}...` : shown}
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

function topLevelIfBlocks(run: RunDetailDto): ControlFlowIfBlock[] {
  return (run.snapshot.controlFlow?.blocks ?? []).filter(
    (block): block is ControlFlowIfBlock => block.kind === 'if' && !block.parentBlockId,
  )
}

type DecideOutput = { branch?: 'then' | 'else' | 'none'; value?: boolean }

function decideOutputOf(stepRun: StepRunDto | undefined): DecideOutput | undefined {
  const succeeded = stepRun?.attempts.filter((item) => item.status === 'SUCCEEDED') ?? []
  const output = succeeded[succeeded.length - 1]?.output
  return output && typeof output === 'object' && !Array.isArray(output) ? (output as DecideOutput) : undefined
}

/** 条件块分组：判定结果在标题上，未走的分支默认折叠并写明跳过原因。 */
function IfBlockGroup({
  block,
  stepRuns,
  runId,
  evidenceItems,
  focusStepRunId,
  focusAttemptId,
  focusEvidenceId,
  currentStepRunId,
  onSelectStep,
}: {
  block: ControlFlowIfBlock
  stepRuns: StepRunDto[]
  runId: string
  evidenceItems: EvidenceItem[]
  focusStepRunId?: string
  focusAttemptId?: string
  focusEvidenceId?: string
  currentStepRunId?: string | null
  onSelectStep?: (stepRunId: string, attemptId?: string) => void
}) {
  const decide = stepRunFor(stepRuns, block.decideStepId)
  const output = decideOutputOf(decide)
  const takenKey = output?.branch === 'then' || output?.branch === 'else' ? output.branch : undefined
  const branches = (['then', 'else'] as const).map((key) => {
    const ids = new Set(block.branches.find((item) => item.key === key)?.stepIds ?? [])
    return { key, stepRuns: stepRuns.filter((item) => ids.has(item.stepId)) }
  })
  const skippedCount = branches
    .filter((item) => item.key !== takenKey)
    .reduce((sum, item) => sum + item.stepRuns.length, 0)
  const [openUntaken, setOpenUntaken] = useState(false)
  const containsFocus = stepRuns.some((item) => item.id === focusStepRunId)

  const headline = !output
    ? decide?.status === 'FAILED'
      ? '条件无法判定'
      : '等待判定'
    : takenKey === 'then'
      ? '条件成立 → 执行'
      : takenKey === 'else'
        ? '条件不成立 → 执行否则分支'
        : `条件不成立 → 跳过 ${skippedCount} 步`

  const renderStep = (step: StepRunDto) => (
    <StepRunItem
      key={step.id}
      step={step}
      runId={runId}
      evidenceItems={evidenceItems}
      focusStepRunId={focusStepRunId}
      focusAttemptId={focusAttemptId}
      focusEvidenceId={focusEvidenceId}
      currentStepRunId={currentStepRunId}
      onSelectStep={onSelectStep}
    />
  )

  return (
    <li className='rounded-md border border-border-card bg-card/60 p-3 shadow-xs' data-testid='if-block-group'>
      <div className='flex flex-wrap items-center gap-2'>
        <GitBranch className='size-4 text-primary' />
        <span className='font-medium text-body'>{decide?.name ?? '满足条件时执行'}</span>
        <span className='text-label text-muted-foreground'>{headline}</span>
      </div>
      <ol className='mt-3 space-y-2 border-t border-border-card/60 pt-3 ps-2'>
        {decide ? renderStep(decide) : null}
        {branches.map((branch) => {
          if (branch.stepRuns.length === 0) return null
          const taken = branch.key === takenKey
          const open = taken || !output || openUntaken || containsFocus
          const label = branch.key === 'then' ? '满足条件时' : '否则'
          return (
            <li key={branch.key} className='space-y-2'>
              <button
                type='button'
                aria-expanded={open}
                disabled={taken || !output}
                onClick={() => setOpenUntaken((prev) => !prev)}
                className='flex items-center gap-1.5 text-label text-muted-foreground disabled:cursor-default'
              >
                {open ? <ChevronDown className='size-3.5' /> : <ChevronRight className='size-3.5' />}
                <span className='font-medium text-foreground'>{label}</span>
                {!taken && output ? (
                  <span>
                    已跳过 {branch.stepRuns.length} 步（{STEP_SKIP_REASON_LABELS.condition_not_met}）
                  </span>
                ) : null}
              </button>
              {open ? <ol className='space-y-2 ps-4'>{branch.stepRuns.map(renderStep)}</ol> : null}
            </li>
          )
        })}
      </ol>
    </li>
  )
}
