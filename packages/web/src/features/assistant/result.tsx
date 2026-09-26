import { useNavigate } from '@tanstack/react-router'
import type { AssistantAuthoringProposal, AssistantProposal, AssistantResult } from '@cairn/shared'
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
import { AssistantFactItem } from './components/assistant-fact-badge'

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
                const type = diff.stepType
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
                const path = diff.fieldPath.join('.')
                return (
                  <div key={idx} className='space-y-1 rounded border border-border-divider bg-surface-card p-2'>
                    <div className='font-sans text-label font-medium text-text-muted'>{path}</div>
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
                  <div className='font-sans text-label font-medium text-text-muted'>
                    {path}
                  </div>
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

      <div className='flex items-center gap-1.5 text-label text-text-muted'>
        <CheckCircle2
          className='size-3.5 shrink-0 text-status-success-foreground'
          aria-hidden='true'
        />
        <span>
          静态预检：
          {proposal.executable
            ? '语法有效，满足依赖'
            : '存在原有编译提示，提案未新增错误'}
        </span>
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
  onAdopt?: (proposal: AssistantProposal | AssistantAuthoringProposal) => void
  onRollback?: (proposal: AssistantProposal | AssistantAuthoringProposal) => void
  onPreviewStep?: (stepId: string) => void
  onClarify?: (optionId: string, option?: any) => void
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
          <p className='font-medium leading-tight'>暂不支持此操作</p>
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
          <p className='font-medium leading-tight'>无访问权限</p>
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

                {/* 次行：说明文本截断 + 紧凑进入按钮 */}
                <div className='mt-1 flex min-w-0 items-center justify-between gap-2'>
                  <p
                    className='line-clamp-1 min-w-0 flex-1 text-label leading-tight text-text-secondary'
                    title={item.steps}
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
                      className='h-6 shrink-0 gap-1 px-2 text-label font-medium text-primary hover:bg-primary/5 hover:text-primary'
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
        {result.diagnostics.length > 0 ? (
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
                onNavigateCitation={(cite) => {
                  const runMatch = /^run:([0-9a-f-]{36})$/.exec(cite)
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
                          className='text-label inline-flex items-center rounded border border-border-default bg-surface-card px-1.5 py-0.5 font-mono text-text-muted'
                        >
                          {c}
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
    return (
      <div className='space-y-3 rounded-lg border border-border-default bg-surface-card p-3.5 shadow-2xs'>
        <p className='text-body font-medium text-text-primary'>{result.summary}</p>
        <section className='space-y-1.5 rounded-md border border-border-divider bg-surface-subtle p-2.5'>
          <h3 className='text-label font-medium text-text-secondary'>对比差异</h3>
          <ul className='space-y-1 text-small text-text-primary'>
            {result.differences.map((diff, index) => (
              <li key={index} className='flex items-center gap-1.5 font-mono text-label'>
                <span className='font-sans font-medium'>{diff.stepName}:</span>
                <span className='rounded bg-surface-card px-1.5 py-0.5 border border-border-default'>{diff.baseStatus ?? '空'}</span>
                <span>→</span>
                <span className='rounded bg-surface-card px-1.5 py-0.5 border border-border-default'>{diff.targetStatus ?? '空'}</span>
                {diff.errorDiff ? <span className='text-status-error-foreground font-sans'>({diff.errorDiff})</span> : null}
              </li>
            ))}
          </ul>
        </section>
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
    return (
      <div className='space-y-3 rounded-lg border border-border-default bg-surface-card p-3.5 shadow-2xs'>
        <p className='text-body font-medium text-text-primary'>{result.reason}</p>
        <p className='text-small text-text-muted'>
          知识建议已保存。请在场景中核对完整步骤与来源，再显式接受到草稿。
        </p>
        <p className='text-label font-mono text-text-muted break-all'>建议编号：{result.proposalId}</p>
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
                  <p className='text-label mt-0.5 truncate font-mono text-text-muted'>
                    ID: {c.id}
                  </p>
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
                        {claim.factKind === 'human_confirmed' && '官方规则/文档'}
                        {claim.factKind === 'inferred' && '合理推断'}
                      </span>
                      {claim.citations?.map((cit, cIdx) => (
                        <span
                          key={cIdx}
                          className='inline-flex items-center font-mono text-label text-text-muted bg-surface-base px-1.5 py-0.5 rounded border border-border-default/40'
                        >
                          {cit}
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
                      <span className='font-mono font-medium text-text-secondary'>{m.key}</span>:{' '}
                      {m.description || m.reason}
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
