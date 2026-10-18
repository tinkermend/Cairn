import { Link } from '@tanstack/react-router'
import type { ScenarioDto } from '@cairn/shared'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RunHistoryStrip, RunVerdictLabel } from './run-history-strip'
import { CreatorCell, ScenarioIdentityIcon, ScenarioMeta, type ScenarioItemContext } from './scenario-card'
import { ScenarioExceptionTags, ScheduleTag } from './scenario-tags'
import { useIsTruncated } from './use-is-truncated'

function NameLink({ scenario }: { scenario: ScenarioDto }) {
  const [ref, truncated] = useIsTruncated<HTMLAnchorElement>(scenario.name)
  // 与卡片标题同理：Tooltip 常驻保持锚点 DOM 稳定，避免截断态被 RO 的死节点回调清掉。
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          ref={ref}
          to='/scenarios/$scenarioId'
          params={{ scenarioId: scenario.id }}
          className='block truncate rounded-sm text-body font-medium text-text-primary outline-none hover:text-link focus-visible:ring-2 focus-visible:ring-ring'
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

/** 紧凑列表：降噪后的表格，适合晨检时纵向扫读与逐行比对。 */
export function ScenarioCompactTable({
  items,
  contextOf,
}: {
  items: ScenarioDto[]
  contextOf: (scenario: ScenarioDto) => ScenarioItemContext
}) {
  // 固定布局：其余列定宽，名称列吃剩余宽度并截断，操作列始终在可视范围内。
  return (
    <Table className='min-w-[900px] table-fixed'>
      <TableHeader>
        <TableRow className='hover:bg-transparent'>
          <TableHead className='pl-4'>场景</TableHead>
          <TableHead className='w-[120px]'>状态</TableHead>
          <TableHead className='w-[252px]'>最近运行</TableHead>
          <TableHead className='w-[148px]'>定时调度</TableHead>
          <TableHead className='w-[140px]'>创建人</TableHead>
          <TableHead className='w-[132px] pr-4 text-right'>操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((scenario) => {
          const context = contextOf(scenario)
          const latest = context.runs[context.runs.length - 1]
          return (
            <TableRow key={scenario.id} className='group/row hover:bg-action-hover'>
              <TableCell className='py-2.5 pl-4'>
                <div className='flex min-w-0 items-center gap-3'>
                  <ScenarioIdentityIcon target={context.target} size='xs' />
                  <div className='min-w-0 flex-1'>
                    <NameLink scenario={scenario} />
                    <ScenarioMeta scenario={scenario} context={context} showUpdated />
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <div className='flex flex-wrap gap-1.5'>
                  <ScenarioExceptionTags scenario={scenario} evidenceIncomplete={latest?.evidenceStatus === 'INCOMPLETE'} />
                </div>
              </TableCell>
              <TableCell>
                <div className='flex min-w-0 items-center gap-2'>
                  <RunHistoryStrip runs={context.runs} slots={context.historyComplete ? 5 : undefined} canOpenRun={context.canOpenRun} />
                  <RunVerdictLabel run={latest} canOpenRun={context.canOpenRun} onOpenRun={context.onOpenRun} />
                </div>
              </TableCell>
              <TableCell>{scenario.schedule ? <ScheduleTag schedule={scenario.schedule} /> : null}</TableCell>
              <TableCell>
                <CreatorCell scenario={scenario} context={context} />
              </TableCell>
              <TableCell className='pr-4'>
                <div className='flex items-center justify-end gap-1'>
                  {context.action}
                  {context.menu}
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
