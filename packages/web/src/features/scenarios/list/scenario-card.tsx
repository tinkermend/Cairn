import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { ScenarioDto, ScenarioListSort, TargetDto } from '@cairn/shared'
import { ListOrdered } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UserAvatar } from '@/components/user-avatar'
import { TargetIdentityIcon } from '@/features/targets/target-identity-icon'
import { cn } from '@/lib/utils'
import { formatCalendarDate, formatRelativeTime } from '../labels'
import { RunHistoryStrip, RunVerdictLabel, type StripRun } from './run-history-strip'
import { ScenarioExceptionTags, ScheduleTag } from './scenario-tags'
import { useIsTruncated } from './use-is-truncated'

export type ScenarioItemContext = {
  target?: TargetDto
  targetLabel: string
  /** 能读目标系统时，目标名是按钮，点击后按该系统筛选。 */
  onFilterTarget?: (targetId: string) => void
  /** 最近正式运行（旧 → 新）；P0 只有一次，P1 起最多 5 次。 */
  runs: StripRun[]
  /** 是否知道完整的最近 5 次；知道时才用空段补足。 */
  historyComplete: boolean
  canOpenRun: boolean
  onOpenRun?: (runId: string) => void
  menu: ReactNode
  action?: ReactNode
  /** 当前排序依据的时间（创建 / 更新）稍作加强，切换排序时看得出依据变了。 */
  sort: ScenarioListSort
}

const fullTime = (iso: string) => new Date(iso).toLocaleString('zh-CN', { hour12: false })

export function ScenarioIdentityIcon({ target, size }: { target?: TargetDto; size: 'sm' | 'xs' }) {
  if (target) {
    return (
      <TargetIdentityIcon
        iconKey={target.iconKey}
        accentKey={target.accentKey}
        size='sm'
        className={size === 'xs' ? 'size-7 rounded-[9px] [&_svg]:size-[15px]' : 'rounded-[10px]'}
      />
    )
  }
  // 无权读取目标系统时没有身份色，退回中性图标，不伪造身份。
  return (
    <span
      aria-hidden='true'
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[10px] bg-surface-subtle text-muted-foreground',
        size === 'xs' ? 'size-7' : 'size-8',
      )}
    >
      <ListOrdered className='size-4' />
    </span>
  )
}

/** 第一行：属于哪个系统、有多大。 */
export function ScenarioMeta({
  scenario,
  context,
  showUpdated = false,
  className,
}: {
  scenario: ScenarioDto
  context: ScenarioItemContext
  /** 列表视图把更新时间放在这一行（创建人另成一列）。 */
  showUpdated?: boolean
  className?: string
}) {
  const { onFilterTarget, targetLabel } = context
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 text-label whitespace-nowrap text-muted-foreground',
        className,
      )}
    >
      {onFilterTarget ? (
        <button
          type='button'
          onClick={() => onFilterTarget(scenario.targetId)}
          title={`只看「${targetLabel}」的场景`}
          className='relative z-[1] min-w-0 truncate rounded-sm text-text-secondary outline-none hover:text-link hover:underline focus-visible:ring-2 focus-visible:ring-ring'
        >
          {targetLabel}
        </button>
      ) : (
        <span className='min-w-0 truncate'>{targetLabel}</span>
      )}
      <span aria-hidden='true' className='text-text-disabled'>
        ·
      </span>
      <span className='shrink-0 tabular-nums'>{scenario.stepCount} 个步骤</span>
      {showUpdated ? (
        <>
          <span aria-hidden='true' className='text-text-disabled'>
            ·
          </span>
          <TimeText sort={context.sort} kind='updated' iso={scenario.updatedAt} />
        </>
      ) : null}
    </div>
  )
}

function TimeText({ sort, kind, iso }: { sort: ScenarioListSort; kind: ScenarioListSort; iso: string }) {
  return (
    <span
      title={`${kind === 'created' ? '创建于' : '更新于'} ${fullTime(iso)}`}
      className={cn('shrink-0 tabular-nums', sort === kind && 'font-medium text-text-secondary')}
    >
      {kind === 'created' ? `${formatCalendarDate(iso)}创建` : `${formatRelativeTime(iso)}更新`}
    </span>
  )
}

function CreatorAvatar({ creator }: { creator: NonNullable<ScenarioDto['createdBy']> }) {
  return (
    <UserAvatar
      user={creator}
      className='size-4 shrink-0 rounded-full'
      fallbackClassName='rounded-full bg-surface-subtle text-3xs text-text-secondary'
    />
  )
}

/** 卡片第二行：谁建的、什么时候建的、最近什么时候改过。创建人为空（系统创建或账号已删除）时只显示时间。 */
export function ScenarioOwnerLine({ scenario, context }: { scenario: ScenarioDto; context: ScenarioItemContext }) {
  const creator = scenario.createdBy
  return (
    <div className='mt-1 flex min-w-0 items-center gap-1.5 text-label whitespace-nowrap text-muted-foreground'>
      {creator ? (
        <>
          <CreatorAvatar creator={creator} />
          <span className='min-w-0 truncate text-text-secondary' title={`创建人：${creator.displayName}`}>
            {creator.displayName}
          </span>
          <span aria-hidden='true' className='text-text-disabled'>
            ·
          </span>
        </>
      ) : null}
      {/* 卡片很窄时先让出创建日期，保住创建人与更新时间。 */}
      <span className='inline-flex shrink-0 items-center gap-1.5 @max-[300px]/card:hidden'>
        <TimeText sort={context.sort} kind='created' iso={scenario.createdAt} />
        <span aria-hidden='true' className='text-text-disabled'>
          ·
        </span>
      </span>
      <TimeText sort={context.sort} kind='updated' iso={scenario.updatedAt} />
    </div>
  )
}

/** 列表视图的创建人列。 */
export function CreatorCell({ scenario, context }: { scenario: ScenarioDto; context: ScenarioItemContext }) {
  const creator = scenario.createdBy
  return (
    <div className='flex min-w-0 items-center gap-2'>
      {creator ? <CreatorAvatar creator={creator} /> : null}
      <div className='min-w-0'>
        <p className='truncate text-small text-text-secondary'>{creator?.displayName ?? '—'}</p>
        <p className='text-label text-muted-foreground'>
          <TimeText sort={context.sort} kind='created' iso={scenario.createdAt} />
        </p>
      </div>
    </div>
  )
}

function CardTitle({ scenario }: { scenario: ScenarioDto }) {
  const [ref, truncated] = useIsTruncated<HTMLAnchorElement>(scenario.name)
  // Tooltip 常驻、只条件渲染内容：若按截断与否切换树形状，锚点 DOM 会被 React 重建，
  // useIsTruncated 的 ResizeObserver 随之失联，截断态会被清掉且不再恢复。
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          ref={ref}
          data-card-link=''
          to='/scenarios/$scenarioId'
          params={{ scenarioId: scenario.id }}
          className={cn(
            'relative z-[1] line-clamp-2 text-body font-semibold [text-wrap:pretty] outline-none transition-colors duration-150 group-hover/card:text-link',
            scenario.status === 'disabled' ? 'text-text-secondary' : 'text-text-primary',
          )}
        >
          {scenario.name}
        </Link>
      </TooltipTrigger>
      {truncated ? (
        <TooltipContent side='top' className='max-w-sm text-left'>
          {scenario.name}
        </TooltipContent>
      ) : null}
    </Tooltip>
  )
}

/**
 * 场景卡：整卡可点（底层覆盖一个不进 Tab 顺序的链接，真实焦点落在标题链接上），
 * 卡内按钮叠在其上，不嵌套交互元素。
 */
export function ScenarioCard({ scenario, context }: { scenario: ScenarioDto; context: ScenarioItemContext }) {
  const latest = context.runs[context.runs.length - 1]
  const evidenceIncomplete = latest?.evidenceStatus === 'INCOMPLETE'
  const hasTags = scenario.status === 'disabled' || scenario.draftDirty || evidenceIncomplete || Boolean(scenario.schedule)

  return (
    <article
      aria-label={scenario.name}
      className={cn(
        'group/card @container/card relative flex flex-col gap-2.5 rounded-lg border border-border-card bg-card p-4 shadow-card',
        'transition-[translate,box-shadow,border-color] duration-150 ease-[var(--ease-standard)]',
        'hover:-translate-y-0.5 hover:border-border-menu hover:shadow-popover pointer-coarse:hover:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0',
        'has-[[data-card-link]:focus-visible]:ring-2 has-[[data-card-link]:focus-visible]:ring-ring has-[[data-card-link]:focus-visible]:ring-offset-2 has-[[data-card-link]:focus-visible]:ring-offset-surface-page',
      )}
    >
      <Link
        to='/scenarios/$scenarioId'
        params={{ scenarioId: scenario.id }}
        tabIndex={-1}
        aria-hidden='true'
        className='absolute inset-0 rounded-[inherit]'
      />
      <div className='flex items-start gap-3'>
        <ScenarioIdentityIcon target={context.target} size='sm' />
        <div className='min-w-0 flex-1'>
          <CardTitle scenario={scenario} />
          <ScenarioMeta scenario={scenario} context={context} className='mt-0.5' />
          <ScenarioOwnerLine scenario={scenario} context={context} />
        </div>
        <div className='relative z-[1] -mt-1.5 -mr-2 opacity-0 transition-opacity duration-150 group-focus-within/card:opacity-100 group-hover/card:opacity-100 has-[[aria-expanded=true]]:opacity-100 pointer-coarse:opacity-100'>
          {context.menu}
        </div>
      </div>
      {hasTags ? (
        <div className='flex flex-wrap gap-1.5 pl-11'>
          <ScenarioExceptionTags scenario={scenario} evidenceIncomplete={evidenceIncomplete} />
          {scenario.schedule ? <ScheduleTag schedule={scenario.schedule} /> : null}
        </div>
      ) : null}
      <div className='mt-auto flex items-center gap-2 border-t border-border-divider pt-3'>
        <div className='flex min-w-0 flex-1 items-center gap-2'>
          <RunHistoryStrip runs={context.runs} slots={context.historyComplete ? 5 : undefined} canOpenRun={context.canOpenRun} />
          <RunVerdictLabel run={latest} canOpenRun={context.canOpenRun} onOpenRun={context.onOpenRun} />
        </div>
        {context.action ? <div className='relative z-[1] shrink-0'>{context.action}</div> : null}
      </div>
    </article>
  )
}
