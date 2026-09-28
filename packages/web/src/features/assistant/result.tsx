import { useNavigate } from '@tanstack/react-router'
import {
  TARGET_CONFIG_FORM_FIELDS,
  targetConfigFieldValueLabel,
  validateTargetFormProposalChange,
  type AssistantAuthoringProposal,
  type AssistantClarifyOption,
  type AssistantProposal,
  type AssistantResult,
  type TargetFormProposal,
} from '@cairn/shared'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Compass,
  Eye,
  FileSearch,
  HelpCircle,
  Laptop,
  ListChecks,
  Monitor,
  Play,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Users,
  Workflow,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { stepTypeLabel } from '@/features/authoring/labels'
import { RUN_STATUS_LABELS, STEP_RUN_STATUS_LABELS } from '@/features/scenarios/labels'
import { RUN_OUTCOME_STATUS_LABELS } from '@/features/runs/outcome-labels'
import { AssistantFactItem } from './components/assistant-fact-badge'
import { citationDisplayLabel } from './citation-label'

const FIELD_LABELS: Record<string, string> = {
  input: '步骤输入',
  output: '步骤输出',
  outputs: '步骤输出',
  selector: '页面元素定位',
  value: '匹配内容',
  timeoutMs: '超时时间（毫秒）',
  waitAfter: '操作后等待',
  retry: '重试设置',
  maxAttempts: '最多尝试次数',
  instruction: '操作说明',
  expect: '成功条件',
  name: '步骤名称',
  type: '步骤类型',
  effect: '操作影响',
  from: '引用来源',
  fromField: '引用字段',
}

function DiffFieldHeading({ fieldPath }: { fieldPath: string[] }) {
  const label = fieldPath.map((segment) => FIELD_LABELS[segment] ?? '其他设置').join(' · ')
  const hasUnknownSegment = fieldPath.some((segment) => !FIELD_LABELS[segment])
  return (
    <div className='font-sans text-label text-text-muted'>
      <span className='font-medium'>{label || '步骤设置'}</span>
      {hasUnknownSegment ? (
        <details className='mt-0.5'>
          <summary className='w-fit cursor-pointer text-text-muted'>查看技术字段</summary>
          <code className='break-all'>{fieldPath.join('.')}</code>
        </details>
      ) : null}
    </div>
  )
}

function statusLabel(status?: string): string {
  if (!status) return '无记录'
  return STEP_RUN_STATUS_LABELS[status as keyof typeof STEP_RUN_STATUS_LABELS]
    ?? RUN_STATUS_LABELS[status as keyof typeof RUN_STATUS_LABELS]
    ?? RUN_OUTCOME_STATUS_LABELS[status as keyof typeof RUN_OUTCOME_STATUS_LABELS]
    ?? '状态待确认'
}

function formatSourceTime(iso: string): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZoneName: 'shortOffset',
  }).formatToParts(new Date(iso))
  const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')} ${value('timeZoneName')}`
}

function unsupportedTitle(reasonCode: string): string {
  if (reasonCode === 'TASK_CANCELLED') return '本次任务已取消'
  if (['PERMISSION_DENIED', 'TARGET_FORBIDDEN', 'CAPABILITY_FORBIDDEN', 'GUIDE_UNAVAILABLE'].includes(reasonCode)) return '无访问权限'
  if (['TURN_FAILED', 'REQUEST_LOST_ON_RESTART', 'MODEL_UNAVAILABLE', 'MODEL_TIMEOUT', 'MODEL_INVALID_OUTPUT', 'BUDGET_EXHAUSTED', 'COMPILER_REGRESSION'].includes(reasonCode)) return '处理失败'
  if (['TASK_UNSUPPORTED', 'STEP_TYPE_UNSUPPORTED', 'CAPABILITY_NOT_FOUND', 'INTENT_UNSUPPORTED'].includes(reasonCode)) return '暂不支持此操作'
  return '暂时无法完成'
}

function missingInfoLabel(key: string): string {
  if (key === 'knowledge_base') return '未找到相关知识资料'
  if (key === 'model_inference') return '答复生成未完成'
  if (key === 'step_timeout') return '步骤超时设置待确认'
  return '仍缺少相关信息'
}

function formatDiffValue(val: unknown): string {
  if (val === undefined || val === null) return ''
  if (typeof val === 'string') return val
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  try {
    return JSON.stringify(val, null, 2)
  } catch {
    return String(val)
  }
}

export function assistantHrefTo(href: string) {
  try {
    const url = new URL(href, 'https://cairn.local')
    const pathname = url.pathname
    const search: Record<string, string> = {}
    url.searchParams.forEach((value, key) => {
      search[key] = value
    })

    const hasSearch = Object.keys(search).length > 0

    const runsMatch = /^\/runs\/([^/?#]+)$/i.exec(pathname)
    if (runsMatch) {
      return {
        to: '/runs/$runId' as const,
        params: { runId: runsMatch[1]! },
        ...(hasSearch ? { search } : {}),
      }
    }

    const scenariosMatch = /^\/scenarios\/([^/?#]+)$/i.exec(pathname)
    if (scenariosMatch) {
      return {
        to: '/scenarios/$scenarioId' as const,
        params: { scenarioId: scenariosMatch[1]! },
        ...(hasSearch ? { search } : {}),
      }
    }

    const targetsMatch = /^\/targets\/([^/?#]+)$/i.exec(pathname)
    if (targetsMatch) {
      return {
        to: '/targets/$targetId' as const,
        params: { targetId: targetsMatch[1]! },
        ...(hasSearch ? { search } : {}),
      }
    }

    if (pathname === '/platform-config') {
      return {
        to: '/platform-config' as const,
        ...(hasSearch ? { search } : {}),
      }
    }

    return {
      to: pathname as '/platform-config' | '/runs' | '/scenarios' | '/targets',
      ...(hasSearch ? { search } : {}),
    }
  } catch {
    return {
      to: href as '/platform-config' | '/runs' | '/scenarios' | '/targets',
    }
  }
}

function ProposalDiffViewer({
  proposal,
  onPreviewStep,
  onAdopt,
  onRollback,
  adopting,
  isAdopted,
  canRollback,
}: {
  proposal: AssistantProposal | AssistantAuthoringProposal
  onPreviewStep?: (stepId: string) => void
  onAdopt?: (proposal: AssistantProposal | AssistantAuthoringProposal) => void
  onRollback?: (proposal: AssistantProposal | AssistantAuthoringProposal) => void
  adopting?: boolean
  isAdopted?: boolean
  canRollback?: boolean
}) {
  const isV2 = proposal.kind === 'authoring_proposal'
  const reason = isV2 ? '已按要求生成受限编排候选' : proposal.reason
  const diagnostics = isV2 ? (proposal.diagnostics ?? []) : []
  const mapSourceWarnings = diagnostics.filter((item) => item.code.startsWith('MAP_SOURCE_'))
  const firstInsert = isV2 ? proposal.operations.find((op) => op.kind === 'insert_step') : null
  const firstWithStepId = isV2 ? proposal.operations.find((op): op is Extract<typeof op, { stepId: string }> => 'stepId' in op) : null
  const stepId = isV2
    ? firstInsert?.step.id ?? firstWithStepId?.stepId
    : proposal.stepId
  const stepName = isV2
    ? (firstInsert?.step.name ?? proposal.diffs.find((d) => d.stepName)?.stepName)
    : null

  return (
    <div className='space-y-3 rounded-lg border border-border-default bg-surface-card p-3.5 shadow-2xs'>
      <div>
        <p className='text-body font-medium text-text-primary'>{reason}</p>
        {stepName ? (
          <p className='mt-0.5 text-small text-text-muted'>
            {isV2 ? '涉及步骤' : '建议修改步骤'} · {stepName}
          </p>
        ) : stepId ? (
          <p className='mt-0.5 font-mono text-small text-text-muted'>
            {isV2 ? '涉及步骤' : '建议修改步骤'} · {stepId.slice(0, 8)}…
          </p>
        ) : null}
      </div>

      <div className='space-y-2 rounded-md border border-border-default bg-surface-subtle p-3'>
        <div className='border-b border-border-divider pb-1 text-label font-medium text-text-secondary'>
          变更比对
        </div>
        <div className='space-y-2 font-mono text-small'>
          {isV2 ? (
            proposal.diffs.map((diff, idx) => {
              if (diff.type === 'add') {
                const name = diff.stepName
                const resolvedType = stepTypeLabel(diff.stepType)
                const type = resolvedType === diff.stepType ? '其他类型' : resolvedType
                return (
                  <div key={idx} className='space-y-1 rounded border border-border-divider bg-surface-card p-2'>
                    <div className='font-sans text-label font-medium text-status-success-foreground'>
                      + 新增节点：{name} ({type})
                    </div>
                    {diff.detail ? <div className='text-label text-text-muted'>{diff.detail}</div> : null}
                  </div>
                )
              }
              if (diff.type === 'remove') {
                const name = diff.stepName
                return (
                  <div key={idx} className='space-y-1 rounded border border-border-divider bg-surface-card p-2'>
                    <div className='font-sans text-label font-medium text-status-error-foreground line-through'>
                      - 删除节点：{name}
                    </div>
                    {diff.detail ? <div className='text-label text-text-muted'>{diff.detail}</div> : null}
                  </div>
                )
              }
              if (diff.type === 'modify') {
                return (
                  <div key={idx} className='space-y-1 rounded border border-border-divider bg-surface-card p-2'>
                    <DiffFieldHeading fieldPath={diff.fieldPath} />
                    <div className='rounded bg-status-error-background px-2 py-1 break-all text-status-error-foreground line-through whitespace-pre-wrap'>
                      - {formatDiffValue(diff.from)}
                    </div>
                    <div className='rounded bg-status-success-background px-2 py-1 font-medium break-all text-status-success-foreground whitespace-pre-wrap'>
                      + {formatDiffValue(diff.to)}
                    </div>
                  </div>
                )
              }
              if (diff.type === 'move') {
                const name = diff.stepName
                return (
                  <div key={idx} className='space-y-1 rounded border border-border-divider bg-surface-card p-2'>
                    <div className='font-sans text-label font-medium text-status-info-foreground'>
                      ↕ 移动节点：{name}（从第 {diff.fromIndex + 1} 位移至第 {diff.toIndex + 1} 位）
                    </div>
                    {diff.detail ? <div className='text-label text-text-muted'>{diff.detail}</div> : null}
                  </div>
                )
              }
              return null
            })
          ) : (
            proposal.diffs.map((item, idx) => {
              const path = item.fieldPath.join('.')
              const changeType =
                item.changeType ??
                (item.from === undefined
                  ? 'add'
                  : item.to === undefined
                    ? 'remove'
                    : 'modify')
              return (
                <div
                  key={`${path}-${idx}`}
                  className='space-y-1 rounded border border-border-divider bg-surface-card p-2'
                >
                  <DiffFieldHeading fieldPath={item.fieldPath} />
                  {changeType === 'remove' ? (
                    <div className='rounded bg-status-error-background px-2 py-1 break-all text-status-error-foreground line-through whitespace-pre-wrap'>
                      - {formatDiffValue(item.from)}
                    </div>
                  ) : changeType === 'add' ? (
                    <div className='rounded bg-status-success-background px-2 py-1 font-medium break-all text-status-success-foreground whitespace-pre-wrap'>
                      + {formatDiffValue(item.to)}
                    </div>
                  ) : (
                    <div className='space-y-1'>
                      <div className='rounded bg-status-error-background px-2 py-1 break-all text-status-error-foreground line-through whitespace-pre-wrap'>
                        - {formatDiffValue(item.from)}
                      </div>
                      <div className='rounded bg-status-success-background px-2 py-1 font-medium break-all text-status-success-foreground whitespace-pre-wrap'>
                        + {formatDiffValue(item.to)}
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className='space-y-1.5 text-label text-text-muted'>
        <div className='flex items-start gap-1.5'>
          {proposal.executable ? (
            <CheckCircle2 className='mt-0.5 size-3.5 shrink-0 text-status-success-foreground' aria-hidden='true' />
          ) : (
            <AlertTriangle className='mt-0.5 size-3.5 shrink-0 text-status-warning-foreground' aria-hidden='true' />
          )}
          <span>
            静态预检：{proposal.executable ? '语法有效，满足依赖' : '已有编译问题仍需处理'}。
            {isV2 ? ' 尚未验证当前页面定位和业务结果，采纳后请核对并试跑。' : null}
          </span>
        </div>
        {mapSourceWarnings.length > 0 ? (
          <p className='rounded-md border border-status-warning-foreground/20 bg-status-warning-background p-2 text-status-warning-foreground'>
            地图来源待核对：{mapSourceWarnings[0]?.message}
            {mapSourceWarnings.length > 1 ? ` 另有 ${mapSourceWarnings.length - 1} 处，见下方提示。` : null}
          </p>
        ) : null}
        {diagnostics.length > 0 ? (
          <details className='rounded-md border border-status-warning-foreground/20 bg-status-warning-background p-2 text-status-warning-foreground'>
            <summary className='cursor-pointer font-medium'>场景还有 {diagnostics.length} 条校验提示，展开核对</summary>
            <ul className='mt-1.5 max-h-32 space-y-1 overflow-y-auto ps-4 list-disc'>
              {diagnostics.map((item, index) => <li key={`${item.code}-${item.stepId ?? index}`}>{item.message}</li>)}
            </ul>
          </details>
        ) : null}
      </div>

      <div className='flex flex-wrap items-center gap-2 border-t border-border-divider pt-1'>
        {onPreviewStep && stepId ? (
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='gap-1.5 text-label text-text-secondary hover:text-text-primary'
            onClick={() => onPreviewStep(stepId)}
          >
            <Eye className='size-3.5' aria-hidden='true' />在 Studio 中定位
          </Button>
        ) : null}

        {isAdopted ? (
          <div className='flex items-center gap-2'>
            <span className='inline-flex items-center gap-1 text-label font-medium text-status-success-foreground'>
              <Check className='size-3.5' aria-hidden='true' />
              已放入草稿
            </span>
            {onRollback ? (
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={!canRollback}
                title={
                  canRollback
                    ? '撤销本次采纳'
                    : '草稿已有后续修改，请在画布中使用快捷键撤销'
                }
                className='gap-1 text-label text-text-secondary hover:text-text-primary'
                onClick={() => onRollback(proposal)}
              >
                <Undo2 className='size-3.5' aria-hidden='true' />
                撤销采纳
              </Button>
            ) : null}
          </div>
        ) : (
          <Button
            type='button'
            disabled={!onAdopt || adopting}
            loading={adopting}
            size='sm'
            className='gap-1.5 text-label font-medium'
            onClick={() => onAdopt?.(proposal)}
          >
            <Sparkles className='size-3.5' aria-hidden='true' />
            采纳到本地草稿
          </Button>
        )}
      </div>
    </div>
  )
}

function TargetFormProposalViewer({
  proposal,
  onAdopt,
  onRollback,
  adopting,
  isAdopted,
  canRollback = true,
}: {
  proposal: TargetFormProposal
  onAdopt?: (proposal: TargetFormProposal) => void
  onRollback?: (proposal: TargetFormProposal) => void
  adopting?: boolean
  isAdopted?: boolean
  canRollback?: boolean
}) {
  const hasValidationError = proposal.changes.some(
    (c) => Boolean(validateTargetFormProposalChange(c, proposal.mode)),
  )

  return (
    <div
      className='space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4 shadow-sm'
      data-testid='target-form-proposal-card'
    >
      <div className='flex items-center gap-2 text-small font-medium text-text-primary'>
        <Sparkles className='size-4 text-primary-600 shrink-0' aria-hidden='true' />
        <span>目标系统配置建议</span>
        <span className='ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-label text-primary font-mono'>
          {proposal.mode === 'edit' ? '编辑模式' : '新建模式'}
        </span>
      </div>

      <p className='text-label text-text-secondary leading-relaxed'>
        {proposal.summary}
      </p>

      <div className='rounded-lg border border-border-default bg-surface-card p-3 space-y-2 text-label'>
        <div className='font-medium text-text-primary text-label'>拟修改字段：</div>
        <ul className='space-y-1.5 text-text-secondary list-none'>
          {proposal.changes.map((c) => {
            const field = TARGET_CONFIG_FORM_FIELDS.find((f) => f.id === c.fieldId)
            const label = field?.label ?? c.fieldId
            const displayVal = targetConfigFieldValueLabel(c.fieldId, c.value)
            const validationError = validateTargetFormProposalChange(c, proposal.mode)
            return (
              <li key={c.fieldId} className='flex items-center justify-between gap-2 flex-wrap'>
                <div className='flex items-center gap-1.5'>
                  <span className='font-medium text-text-primary'>{label}</span>
                  <span className='text-text-muted'>→</span>
                  <span className='text-primary-600 font-mono'>{displayVal}</span>
                </div>
                {validationError ? (
                  <span className='text-label text-status-error-foreground bg-status-error-background/60 border border-status-error-foreground/20 rounded px-1.5 py-0.5'>
                    {validationError}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ul>
      </div>

      {proposal.pendingFields && proposal.pendingFields.length > 0 ? (
        <div
          className='flex items-center gap-2 rounded-lg border border-status-warning-foreground/20 bg-status-warning-background/60 px-3 py-2 text-label text-status-warning-foreground'
          data-testid='target-form-pending-warning'
        >
          <AlertTriangle className='size-3.5 shrink-0' aria-hidden='true' />
          <span>
            待补充核心必填项：
            {proposal.pendingFields
              .map((f) => TARGET_CONFIG_FORM_FIELDS.find((item) => item.id === f)?.label ?? f)
              .join('、')}
          </span>
        </div>
      ) : null}

      {proposal.clarifyPrompt ? (
        <div
          className='flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-label font-medium text-primary-600'
          data-testid='target-form-clarify-prompt'
        >
          <HelpCircle className='size-3.5 shrink-0' aria-hidden='true' />
          <span>{proposal.clarifyPrompt}</span>
        </div>
      ) : null}

      <div className='flex items-center justify-end gap-2 pt-1'>
        {isAdopted ? (
          <div className='flex items-center gap-2'>
            <span className='inline-flex items-center gap-1.5 rounded-md bg-status-success-subtle px-2.5 py-1 text-label font-medium text-status-success-foreground'>
              <Check className='size-3.5' />
              已应用到表单
            </span>
            {onRollback ? (
              <Button
                type='button'
                variant='outline'
                size='sm'
                disabled={!canRollback}
                title={canRollback ? '撤销本次采纳' : '表单已有后续修改，无法一键撤销'}
                className='gap-1 text-label text-text-secondary hover:text-text-primary'
                onClick={() => onRollback(proposal)}
                data-testid='target-form-rollback-btn'
              >
                <Undo2 className='size-3.5' aria-hidden='true' />
                撤销采纳
              </Button>
            ) : null}
          </div>
        ) : (
          <Button
            type='button'
            size='sm'
            disabled={!onAdopt || adopting || hasValidationError}
            loading={adopting}
            title={hasValidationError ? '提案中包含不合法的字段修改，无法采纳' : undefined}
            className='gap-1.5 text-label font-medium'
            onClick={() => onAdopt?.(proposal)}
            data-testid='target-form-adopt-btn'
          >
            <Sparkles className='size-3.5' aria-hidden='true' />
            {proposal.pendingFields && proposal.pendingFields.length > 0 ? '采纳并前往补齐 ➔' : '采纳到表单'}
          </Button>
        )}
      </div>
    </div>
  )
}

function getGuideIcon(topic: string) {
  switch (topic) {
    case 'targets':
      return Monitor
    case 'accounts':
      return Users
    case 'scenarios':
      return ListChecks
    case 'studio':
      return Workflow
    case 'runs':
      return Play
    case 'evidence':
      return FileSearch
    case 'browser':
      return Laptop
    case 'platform-config':
      return SlidersHorizontal
    default:
      return Compass
  }
}

function getAvailabilityInfo(availability?: string) {
  switch (availability) {
    case 'forbidden':
      return {
        label: '无权限',
        dotClass: 'bg-status-warning-foreground',
        textClass: 'text-status-warning-foreground',
      }
    case 'disabled':
      return {
        label: '已禁用',
        dotClass: 'bg-text-muted',
        textClass: 'text-text-muted',
      }
    case 'unsupported':
      return {
        label: '暂不支持',
        dotClass: 'bg-text-muted',
        textClass: 'text-text-muted',
      }
    case 'available':
    default:
      return {
        label: '可用',
        dotClass: 'bg-status-success-foreground',
        textClass: 'text-status-success-foreground',
      }
  }
}

export function AssistantResultView({
  result,
  onAdopt,
  onRollback,
  onPreviewStep,
  onClarify,
  onCancelTask,
  onNextPage,
  onNavigate,
  adopting,
  isAdopted,
  canRollback = true,
}: {
  result: AssistantResult
  onAdopt?: (proposal: AssistantProposal | AssistantAuthoringProposal | TargetFormProposal) => void
  onRollback?: (proposal: AssistantProposal | AssistantAuthoringProposal | TargetFormProposal) => void
  onPreviewStep?: (stepId: string) => void
  onClarify?: (optionId: string, option?: AssistantClarifyOption) => void
  onCancelTask?: () => void
  onNextPage?: (nextCursor: string) => void
  onNavigate?: () => void
  adopting?: boolean
  isAdopted?: boolean
  canRollback?: boolean
}) {
  const navigate = useNavigate()
  const go = (href: string) => {
    const target = assistantHrefTo(href)
    const res = navigate(target as never)
    if (res && typeof (res as Promise<unknown>).then === 'function') {
      void (res as Promise<unknown>).then(() => onNavigate?.())
    } else {
      onNavigate?.()
    }
  }
  if (result.kind === 'clarify') {
    return (
      <div
        className='space-y-2.5 rounded-xl border border-border-default bg-surface-card p-3.5 shadow-2xs'
        data-testid='clarify-card'
      >
        <div className='flex items-center gap-2 text-small font-medium text-text-primary'>
          <HelpCircle
            className='text-primary-600 size-4 shrink-0'
            aria-hidden='true'
          />
          <span>{result.question}</span>
        </div>
        {result.options?.length ? (
          <div className='grid grid-cols-1 gap-2 pt-1 @[440px]:grid-cols-2'>
            {result.options.map((item) => (
              <button
                key={item.id}
                type='button'
                onClick={() => onClarify?.(item.id, item)}
                className='group hover:border-primary-400 hover:text-primary-600 flex items-center justify-between rounded-lg border border-border-default bg-surface-subtle px-3 py-2 text-start text-small text-text-secondary shadow-2xs transition-colors select-none hover:bg-surface-card'
              >
                <div className='min-w-0 flex-1'>
                  <div className='truncate font-medium'>{item.label}</div>
                  {'targetName' in item && item.targetName ? (
                    <div className='truncate text-label text-text-muted'>目标：{item.targetName}</div>
                  ) : null}
                </div>
                <ArrowRight
                  className='group-hover:text-primary-600 ms-1 size-3.5 shrink-0 text-text-muted transition-transform group-hover:translate-x-0.5'
                  aria-hidden='true'
                />
              </button>
            ))}
          </div>
        ) : null}
        {onCancelTask ? (
          <div className='flex justify-end border-t border-border-divider pt-1'>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='h-7 text-label text-text-muted hover:text-status-error-foreground'
              onClick={onCancelTask}
              data-testid='clarify-cancel-btn'
            >
              取消本次任务
            </Button>
          </div>
        ) : null}
      </div>
    )
  }
  if (result.kind === 'unsupported') {
    return (
      <div
        className='flex items-start gap-2.5 rounded-lg border border-status-warning-foreground/20 bg-status-warning-background p-3 text-small text-status-warning-foreground'
        data-testid='unsupported-card'
      >
        <AlertTriangle className='size-4 shrink-0 mt-0.5' aria-hidden='true' />
        <div className='space-y-1 min-w-0 flex-1'>
          <p className='font-medium leading-tight'>{unsupportedTitle(result.reasonCode)}</p>
          <p className='text-label leading-normal opacity-90'>{result.message}</p>
        </div>
      </div>
    )
  }
  if (result.kind === 'inaccessible') {
    return (
      <div
        className='flex items-start gap-2.5 rounded-lg border border-status-warning-foreground/20 bg-status-warning-background p-3 text-small text-status-warning-foreground'
        data-testid='inaccessible-card'
      >
        <AlertTriangle className='size-4 shrink-0 mt-0.5' aria-hidden='true' />
        <div className='space-y-1 min-w-0 flex-1'>
          <p className='font-medium leading-tight'>
            {result.reasonCode === 'UNVERIFIED_HISTORY' ? '历史回答需复核' : '无访问权限'}
          </p>
          <p className='text-label leading-normal opacity-90'>{result.message}</p>
        </div>
      </div>
    )
  }
  if (result.kind === 'guide') {
    return (
      <div className='@container w-full'>
        <ul
          role='list'
          aria-label='功能导览推荐'
          className='grid grid-cols-1 gap-2 @[440px]:grid-cols-2'
          data-testid='guide-grid'
        >
          {result.items.map((item, idx) => {
            const Icon = getGuideIcon(item.topic)
            const avail = getAvailabilityInfo(item.availability)
            const hasHref = Boolean(item.href)

            return (
              <li
                key={`${item.topic}-${idx}`}
                data-testid={`guide-item-${item.topic}`}
                className={cn(
                  'group relative flex flex-col justify-between rounded-lg border border-border-default bg-surface-card px-2.5 py-1.5 shadow-2xs transition-[border-color,box-shadow]',
                  hasHref &&
                    'hover:border-primary-400 cursor-pointer hover:shadow-xs'
                )}
                onClick={() => {
                  if (item.href) go(item.href)
                }}
              >
                {/* 首行整合：左侧语义图标 + 标题，右侧状态微徽章/小圆点 */}
                <div className='flex min-w-0 items-center justify-between gap-1.5'>
                  <div className='flex min-w-0 flex-1 items-center gap-1.5'>
                    <Icon
                      className='text-primary-600 size-3.5 shrink-0'
                      aria-hidden='true'
                    />
                    <span
                      className='truncate text-small font-medium leading-tight text-text-primary'
                      title={item.title}
                    >
                      {item.title}
                    </span>
                  </div>
                  <span
                    className={cn(
                      'text-label inline-flex shrink-0 items-center gap-1',
                      avail.textClass
                    )}
                  >
                    <span
                      className={cn('size-1.5 rounded-full', avail.dotClass)}
                      aria-hidden='true'
                    />
                    {avail.label}
                  </span>
                </div>

                {/* 操作说明必须完整可读，尤其是含多步路径的上手指引。 */}
                <div className='mt-1.5 flex min-w-0 flex-col items-start gap-2'>
                  <p
                    className='w-full break-words whitespace-pre-wrap text-small leading-relaxed text-text-secondary'
                  >
                    {item.steps}
                  </p>
                  {hasHref ? (
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      aria-label='打开入口'
                      title='打开入口'
                      className='h-6 self-end gap-1 px-2 text-label font-medium text-primary hover:bg-primary/5 hover:text-primary'
                      onClick={(e) => {
                        e.stopPropagation()
                        go(item.href!)
                      }}
                    >
                      进入
                      <ArrowRight className='size-2.5' aria-hidden='true' />
                    </Button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }
  if (result.kind === 'explanation') {
    return (
      <div className='space-y-2.5 rounded-lg border border-border-default bg-surface-card p-3.5 shadow-2xs'>
        <p className='text-body text-text-primary leading-relaxed'>{result.summary}</p>
        {result.stepSummary ? (
          <p className='text-small text-text-secondary'>{result.stepSummary}</p>
        ) : null}
        {(result.diagnostics?.length ?? 0) > 0 ? (
          <div className='rounded-md border border-border-divider bg-surface-subtle p-2.5 space-y-1.5'>
            <div className='text-label font-medium text-text-secondary'>诊断分析</div>
            <ul className='space-y-1 text-label text-text-muted'>
              {result.diagnostics.map((item) => (
                <li key={`${item.code}-${item.stepId ?? ''}`} className='flex items-start gap-1.5'>
                  <span className='size-1.5 rounded-full bg-status-warning-foreground mt-1.5 shrink-0' />
                  <span>
                    {item.baseline ? '原有问题：' : ''}
                    {item.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    )
  }
  if (result.kind === 'diagnosis') {
    return (
      <div className='space-y-3.5'>
        {result.observedAt ? (
          <div className='text-label flex items-center gap-1.5 border-b border-border-divider pb-1 text-text-muted'>
            <span>数据观测基准时间：</span>
            <span className='font-mono font-medium'>
              {new Date(result.observedAt).toLocaleString()}
            </span>
          </div>
        ) : null}

        <section>
          <div className='mb-1.5 flex items-center justify-between'>
            <h3 className='text-label font-medium text-text-primary'>
              已确认事实
            </h3>
            <span className='text-label text-text-muted'>
              {result.facts.length} 条事实依据
            </span>
          </div>
          <div className='space-y-2'>
            {result.facts.map((item) => (
              <AssistantFactItem
                key={item.id}
                fact={item}
                canNavigateCitation={(cite) => /^run:[0-9a-f-]{36}$/i.test(cite)}
                onNavigateCitation={(cite) => {
                  const runMatch = /^run:([0-9a-f-]{36})$/i.exec(cite)
                  if (runMatch) {
                    go(`/runs/${runMatch[1]}`)
                  }
                }}
              />
            ))}
          </div>
        </section>

        {result.hypotheses.length > 0 ? (
          <section>
            <h3 className='mb-1.5 text-label font-medium text-text-primary'>
              可能原因与假设
            </h3>
            <div className='space-y-2'>
              {result.hypotheses.map((item) => (
                <div
                  key={item.text}
                  className='space-y-1 rounded-md border border-border-default bg-surface-subtle p-2.5 text-small'
                >
                  <p className='leading-snug text-text-primary'>{item.text}</p>
                  {item.citations?.length ? (
                    <div className='flex flex-wrap gap-1 pt-1'>
                      {item.citations.map((c) => (
                        <span
                          key={c}
                          className='text-label inline-flex items-center rounded border border-border-default bg-surface-card px-1.5 py-0.5 text-text-muted'
                          title={c}
                        >
                          {citationDisplayLabel(c)}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {result.missingInformation.length > 0 ? (
          <div className='border-status-warning-border/40 rounded-md border bg-status-warning-background/20 p-2.5 text-small text-status-warning-foreground'>
            <span className='font-medium'>尚缺失信息：</span>
            <span>{result.missingInformation.join('；')}</span>
          </div>
        ) : null}

        {result.nextActions.length > 0 ? (
          <section>
            <h3 className='mb-2 text-label font-medium text-text-primary'>
              建议后续操作
            </h3>
            <div className='flex flex-wrap gap-2'>
              {result.nextActions.map((item) => (
                <Button
                  key={item.kind}
                  variant='outline'
                  size='sm'
                  onClick={() => go(item.href)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    )
  }
  if (result.kind === 'compare') {
    const visibleMissing = result.missingInformation?.filter((item) =>
      result.comparability?.comparable !== false || !item.startsWith('运行对比存在不可比因素'))
    return (
      <div className='space-y-3 rounded-lg border border-border-default bg-surface-card p-3.5 shadow-2xs'>
        <p className='text-body font-medium text-text-primary'>{result.summary}</p>
        {result.comparability && !result.comparability.comparable ? (
          <section className='rounded-md border border-status-warning-foreground/20 bg-status-warning-background p-2.5 text-small text-status-warning-foreground'>
            <h3 className='font-medium'>这两次运行不宜逐步比较</h3>
            {result.comparability.incomparableFactors.length > 0 ? (
              <ul className='mt-1 list-disc space-y-1 pl-4'>
                {result.comparability.incomparableFactors.map((factor) => (
                  <li key={factor}>{factor.replace(/^[A-Z_]+:\s*/, '')}</li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
        {result.differences.length > 0 ? (
          <section className='space-y-1.5 rounded-md border border-border-divider bg-surface-subtle p-2.5'>
            <h3 className='text-label font-medium text-text-secondary'>对比差异</h3>
            <ul className='space-y-1 text-small text-text-primary'>
              {result.differences.map((diff, index) => (
                <li key={index} className='flex items-center gap-1.5 font-mono text-label'>
                  <span className='font-sans font-medium'>{diff.stepName}:</span>
                  <span className='rounded bg-surface-card px-1.5 py-0.5 border border-border-default'>{statusLabel(diff.baseStatus)}</span>
                  <span>→</span>
                  <span className='rounded bg-surface-card px-1.5 py-0.5 border border-border-default'>{statusLabel(diff.targetStatus)}</span>
                  {diff.errorDiff ? <span className='text-status-error-foreground font-sans'>({diff.errorDiff})</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {(result.facts?.length ?? 0) > 0 ? (
          <details className='rounded-md border border-border-divider p-2.5'>
            <summary className='cursor-pointer text-label font-medium text-text-secondary'>
              查看对比依据（{result.facts.length} 条）
            </summary>
            <div className='mt-2 space-y-2'>
              {result.facts.map((fact) => <AssistantFactItem key={fact.id} fact={fact} />)}
            </div>
          </details>
        ) : null}
        {visibleMissing?.length ? (
          <p className='rounded-md border border-status-warning-foreground/20 bg-status-warning-background p-2.5 text-small text-status-warning-foreground'>
            仍缺少：{visibleMissing.join('；')}
          </p>
        ) : null}
        {result.nextActions.length > 0 ? (
          <section>
            <h3 className='text-label font-medium text-text-secondary mb-1.5'>建议操作</h3>
            <div className='flex flex-wrap gap-2'>
              {result.nextActions.map((item) => (
                <Button
                  key={item.kind}
                  variant='outline'
                  size='sm'
                  onClick={() => go(item.href)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    )
  }
  if (result.kind === 'knowledge_proposal') {
    const hasEditableChanges = result.status === 'proposed' && result.executable && result.diffs.length > 0
    return (
      <div className='space-y-3 rounded-lg border border-border-default bg-surface-card p-3.5 shadow-2xs'>
        <p className='text-body font-medium text-text-primary'>{result.reason}</p>
        <p className='text-small text-text-muted'>
          {hasEditableChanges
            ? '可编辑建议已生成，尚未应用。请在场景中核对完整步骤与来源，再显式接受到草稿。'
            : result.status === 'needs_input'
              ? '尚未生成可编辑变更。请补齐上方所列信息后重试；当前草稿没有被修改。'
              : '本次没有生成可应用的草稿变更；当前草稿没有被修改。'}
        </p>
        <p className='text-label font-mono text-text-muted break-all'>
          {hasEditableChanges ? '建议编号' : '请求记录编号'}：{result.proposalId}
        </p>
        {result.diffs.length ? (
          <details className='rounded-md border border-border-divider bg-surface-subtle p-2 text-label'>
            <summary className='cursor-pointer font-medium text-text-secondary hover:text-text-primary'>查看具体变更 ({result.diffs.length} 项)</summary>
            <pre className='mt-2 max-h-80 overflow-auto font-mono text-label break-all whitespace-pre-wrap text-text-secondary'>
              {JSON.stringify(result.diffs, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    )
  }

  if (result.kind === 'discovery') {
    return (
      <div className='space-y-3' data-testid='discovery-result'>
        <p className='text-small text-text-secondary'>{result.message}</p>
        {result.candidates.length > 0 ? (
          <ul
            role='list'
            aria-label='场景发现候选列表'
            className='max-h-60 space-y-2 overflow-y-auto pr-1'
            data-testid='discovery-candidates-list'
          >
            {result.candidates.map((c) => (
              <li
                key={`${c.kind}-${c.id}`}
                className='hover:border-primary-400 flex items-center justify-between rounded-lg border border-border-default bg-surface-card p-2.5 shadow-2xs transition-colors'
              >
                <div className='min-w-0 flex-1 pe-2'>
                  <div className='flex items-center gap-1.5'>
                    <span
                      className='truncate text-small font-medium text-text-primary'
                      title={c.name}
                    >
                      {c.name}
                    </span>
                    <span
                      className='text-label shrink-0 rounded bg-surface-subtle px-1.5 py-0.5 text-text-muted'
                      title={c.targetName}
                    >
                      {c.targetName}
                    </span>
                    {c.versionOrRevision ? (
                      <span className='text-label shrink-0 font-mono text-text-muted'>
                        v{c.versionOrRevision}
                      </span>
                    ) : null}
                  </div>
                  <details className='text-label mt-0.5 text-text-muted'>
                    <summary className='w-fit cursor-pointer'>查看技术编号</summary>
                    <code className='break-all'>{c.id}</code>
                  </details>
                </div>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='h-7 px-2.5 text-label shrink-0'
                  onClick={() =>
                    c.kind === 'scenario'
                      ? go(`/scenarios/${c.id}`)
                      : go(`/targets/${c.targetId}`)
                  }
                >
                  查看
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className='text-small text-text-muted'>未找到匹配的项目。</p>
        )}
        <div className='flex items-center justify-between pt-1'>
          <span className='text-label text-text-muted'>
            当前显示 {result.candidates.length} 条
          </span>
          {result.coverage.hasMore && onNextPage ? (
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='h-6 px-2 text-label text-primary-600 hover:text-primary-700'
              onClick={() => onNextPage(result.coverage.nextCursor ?? '')}
              data-testid='discovery-next-page-btn'
            >
              下一页 / 继续找
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  if (result.kind === 'proposal' || result.kind === 'authoring_proposal') {
    return (
      <ProposalDiffViewer
        proposal={result}
        onPreviewStep={onPreviewStep}
        onAdopt={onAdopt}
        onRollback={onRollback}
        adopting={adopting}
        isAdopted={isAdopted}
        canRollback={canRollback}
      />
    )
  }

  if (result.kind === 'target_form') {
    return (
      <TargetFormProposalViewer
        proposal={result}
        onAdopt={onAdopt}
        onRollback={onRollback}
        adopting={adopting}
        isAdopted={isAdopted}
        canRollback={canRollback}
      />
    )
  }

  if (result.kind === 'in_page_guidance') {
    return (
      <div className='space-y-2.5 rounded-xl border border-border-default bg-surface-card p-3 shadow-2xs' data-testid='in-page-guidance-card'>
        <div className='flex items-start gap-2.5 text-small text-text-primary leading-relaxed'>
          <Compass className='size-4 text-primary-600 shrink-0 mt-0.5' aria-hidden='true' />
          <div className='space-y-1.5 min-w-0 flex-1'>
            <p className='font-medium text-text-primary'>{result.directAnswer}</p>
            {result.visualPath?.length ? (
              <ol className='space-y-1 text-label text-text-secondary list-none pt-1'>
                {result.visualPath.map((step, idx) => (
                  <li key={idx} className='flex items-center gap-1.5'>
                    <span className='size-1 rounded-full bg-primary-500 shrink-0' />
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            ) : null}
            {result.shortcutHint ? (
              <p className='text-label text-text-muted font-mono pt-0.5'>
                快捷键：{result.shortcutHint}
              </p>
            ) : null}
          </div>
        </div>
        {result.actionChip ? (
          <div className='flex justify-end pt-1.5 border-t border-border-divider'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              className='h-6 gap-1 px-2 text-label font-medium text-primary hover:bg-primary/5'
              onClick={() => {
                window.dispatchEvent(
                  new CustomEvent('cairn:assistant-action', {
                    detail: result.actionChip,
                  }),
                )
              }}
            >
              <Sparkles className='size-3 text-primary-600' />
              {result.actionChip.label}
            </Button>
          </div>
        ) : null}
      </div>
    )
  }

  if (result.kind === 'knowledge_answer') {
    return (
      <div
        className='space-y-3 rounded-xl border border-border-default bg-surface-card p-3.5 shadow-2xs'
        data-testid='knowledge-answer-card'
      >
        <div className='flex items-start gap-2.5 text-small text-text-primary leading-relaxed'>
          <Sparkles className='size-4 text-primary-600 shrink-0 mt-0.5' aria-hidden='true' />
          <div className='space-y-2 min-w-0 flex-1'>
            <p className='font-medium text-text-primary whitespace-pre-wrap'>{result.summary}</p>
            {result.sourceAsOf ? (
              <p className='text-label text-text-muted' data-testid='knowledge-source-as-of'>
                来源数据查询基准时间：{formatSourceTime(result.sourceAsOf)}
              </p>
            ) : null}

            {result.claims?.length ? (
              <div className='space-y-2 pt-1' data-testid='knowledge-claims-list'>
                {result.claims.map((claim, idx) => (
                  <div
                    key={idx}
                    className='rounded-lg border border-border-default/60 bg-surface-subtle/50 p-2.5 space-y-1.5'
                  >
                    <div className='flex items-center gap-1.5 flex-wrap'>
                      <span
                        className={cn(
                          'inline-flex items-center rounded px-1.5 py-0.5 text-label font-medium',
                          claim.factKind === 'observed' &&
                            'bg-status-success-background text-status-success-foreground border border-status-success-foreground/20',
                          claim.factKind === 'human_confirmed' &&
                            'bg-primary/10 text-primary border border-primary/20',
                          claim.factKind === 'inferred' &&
                            'bg-status-warning-background text-status-warning-foreground border border-status-warning-foreground/20',
                        )}
                      >
                        {claim.factKind === 'observed' && '系统观测'}
                        {claim.factKind === 'human_confirmed' && '已确认资料'}
                        {claim.factKind === 'inferred' && '合理推断'}
                      </span>
                      {claim.citations?.map((cit, cIdx) => (
                        <span
                          key={cIdx}
                          className='inline-flex items-center text-label text-text-muted bg-surface-base px-1.5 py-0.5 rounded border border-border-default/40'
                          title={cit}
                        >
                          {citationDisplayLabel(cit)}
                        </span>
                      ))}
                    </div>
                    <p className='text-small text-text-secondary leading-normal'>{claim.text}</p>
                    {claim.premises?.length ? (
                      <p className='text-label text-text-muted'>
                        依据前提: {claim.premises.join('; ')}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {result.missing?.length ? (
              <div
                className='rounded-lg border border-status-warning-foreground/20 bg-status-warning-background p-2.5 text-label space-y-1'
                data-testid='knowledge-missing-list'
              >
                <p className='font-medium text-status-warning-foreground flex items-center gap-1'>
                  <HelpCircle className='size-3 text-status-warning-foreground' />
                  未决或缺失信息
                </p>
                <ul className='list-disc list-inside text-text-muted space-y-0.5'>
                  {result.missing.map((m, idx) => (
                    <li key={idx}>
                      <span className='text-text-secondary'>{m.description || missingInfoLabel(m.key)}</span>
                      <details className='ms-4 text-text-muted'>
                        <summary className='w-fit cursor-pointer'>查看技术原因</summary>
                        <code className='break-all'>{m.key} · {m.reason}</code>
                      </details>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {result.nextActions?.length ? (
              <div className='flex items-center gap-2 flex-wrap pt-2 border-t border-border-divider'>
                <span className='text-label text-text-muted'>推荐操作:</span>
                {result.nextActions.map((action, idx) => (
                  <Button
                    key={idx}
                    type='button'
                    variant='outline'
                    size='sm'
                    className='h-6 gap-1 px-2 text-label font-medium text-primary hover:bg-primary/5'
                    onClick={() => {
                      if (action.href) go(action.href)
                    }}
                  >
                    <ArrowRight className='size-3 text-primary-600' />
                    {action.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return null
}
