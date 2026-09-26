import { Link } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, ArrowUpDown, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TargetIdentityIcon } from './target-identity-icon'
import { TARGET_STATUS_LABELS } from './labels'
import { type OverviewSort, type OverviewSortColumn, type TargetOverviewItem, formatOverviewTime, readinessLabel, readinessTone } from './target-overview-display'

const sortableColumns: ReadonlyArray<{ key: OverviewSortColumn; label: string; sortLabel: string; className: string }> = [
  { key: 'system', label: '系统', sortLabel: '系统名称', className: 'target-col-system' },
  { key: 'readiness', label: '运行准备', sortLabel: '运行准备优先级', className: 'target-col-readiness' },
  { key: 'accounts', label: '目标账号', sortLabel: '已登录账号数', className: 'target-col-accounts' },
  { key: 'scenarios', label: '关联场景', sortLabel: '关联场景数', className: 'target-col-scenarios' },
  { key: 'activity', label: '最近活动', sortLabel: '最近活动时间', className: 'target-col-activity' },
]

function ReadinessCell({ item }: { item: TargetOverviewItem }) {
  return <StatusBadge tone={readinessTone(item)}>{readinessLabel(item)}</StatusBadge>
}

function AccountsCell({ item }: { item: TargetOverviewItem }) {
  if (item.accounts.state === 'forbidden') return <span className='text-label text-muted-foreground'>无权限查看</span>
  const accounts = item.accounts.value
  if (accounts.eligibleBusinessTotal === 0) return <div className='text-label text-muted-foreground'>暂无浏览器业务账号<span className='mt-0.5 block'>已配置 {accounts.configuredTotal} 个</span></div>
  return <div className='min-w-0'>
    <p className='whitespace-nowrap font-medium tabular-nums text-text-primary'>{accounts.readyAccounts} / {accounts.eligibleBusinessTotal} <span className='text-label font-normal text-muted-foreground'>个已登录</span></p>
    <div role='meter' aria-label={item.target.name + '已登录业务账号'} aria-valuemin={0} aria-valuemax={accounts.eligibleBusinessTotal} aria-valuenow={accounts.readyAccounts} className='mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle'>
      <span className='block h-full rounded-full bg-primary' style={{ width: 100 * accounts.readyAccounts / accounts.eligibleBusinessTotal + '%' }} />
    </div>
    <p className='mt-1 truncate text-label text-muted-foreground'>已配置 {accounts.configuredTotal} 个</p>
  </div>
}

function ActivityCell({ item }: { item: TargetOverviewItem }) {
  if (item.activities.state === 'forbidden') return <span className='text-label text-muted-foreground'>无权限查看</span>
  const activity = item.activities.value.items[0]
  if (!activity) return <span className='text-label text-muted-foreground'>暂无可见活动</span>
  const content = <>
    <span className='block truncate text-small font-medium text-text-primary' title={activity.title}>{activity.title}</span>
    <time className='mt-0.5 block text-label text-muted-foreground' dateTime={activity.occurredAt} title={new Date(activity.occurredAt).toLocaleString('zh-CN')}>{formatOverviewTime(activity.occurredAt)}</time>
  </>
  if (activity.runId) return <Link to='/runs/$runId' params={{ runId: activity.runId }} className='block min-w-0 hover:underline'>{content}</Link>
  if (activity.targetAccountId) return <Link to='/sessions/$targetId/$accountId' params={{ targetId: item.target.id, accountId: activity.targetAccountId }} className='block min-w-0 hover:underline'>{content}</Link>
  return <div className='min-w-0'>{content}</div>
}

export function TargetOverviewList({
  items, selectedId, sort, onSort, onSelect, onPreview,
}: {
  items: TargetOverviewItem[]
  selectedId?: string
  sort: OverviewSort
  onSort: (column: OverviewSortColumn) => void
  onSelect: (id: string, trigger: HTMLButtonElement) => void
  onPreview: (id: string, trigger: HTMLButtonElement) => void
}) {
  return <div className='overflow-x-auto'>
    <Table className='target-overview-table w-full table-fixed'>
      <TableHeader><TableRow>{sortableColumns.map(({ key, label, sortLabel, className }) => {
        const active = sort.startsWith(key + '-')
        const direction = active && sort.endsWith('-asc') ? 'ascending' : active ? 'descending' : 'none'
        const SortIcon = direction === 'ascending' ? ArrowUp : direction === 'descending' ? ArrowDown : ArrowUpDown
        return <TableHead key={key} className={className} aria-sort={direction}>
          <button type='button' onClick={() => onSort(key)} aria-label={'按' + sortLabel + '排序'} className='flex h-10 w-full items-center gap-1 rounded-sm text-left font-medium hover:text-text-primary focus-visible:outline-2 focus-visible:outline-ring'>
            <span>{label}</span><SortIcon className='size-3.5 shrink-0' aria-hidden='true' />
          </button>
        </TableHead>
      })}</TableRow></TableHeader>
      <TableBody>{items.map((item) => <TableRow
        key={item.target.id}
        data-state={selectedId === item.target.id ? 'selected' : undefined}
        className='cursor-pointer'
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a,button,input,[role=combobox]')) return
          const trigger = event.currentTarget.querySelector<HTMLButtonElement>('[data-target-name-button]')
          if (trigger) onSelect(item.target.id, trigger)
        }}
      >
        <TableCell className='target-col-system py-3'>
          <div className='flex min-w-0 items-center gap-2.5'>
            <TargetIdentityIcon iconKey={item.target.iconKey} accentKey={item.target.accentKey} size='lg' />
            <div className='target-system-label flex min-w-0 flex-1 items-center gap-1.5'>
                <button type='button' data-target-name-button aria-pressed={selectedId === item.target.id} aria-controls='target-overview' onClick={(event) => onSelect(item.target.id, event.currentTarget)} className='min-w-0 flex-1 truncate rounded-sm text-left text-small font-semibold text-text-primary hover:text-link focus-visible:outline-2 focus-visible:outline-ring' title={item.target.name}>{item.target.name}</button>
                <StatusBadge tone={item.target.status === 'active' ? 'success' : 'neutral'} className='shrink-0'>{TARGET_STATUS_LABELS[item.target.status]}</StatusBadge>
            </div>
            <Button variant='ghost' size='icon' className='target-row-preview size-7 shrink-0' onClick={(event) => onPreview(item.target.id, event.currentTarget)} aria-label={'预览' + item.target.name} title={'预览' + item.target.name}><Eye className='size-4' aria-hidden='true' /></Button>
          </div>
        </TableCell>
        <TableCell className='target-col-readiness'><ReadinessCell item={item} /></TableCell>
        <TableCell className='target-col-accounts'><AccountsCell item={item} /></TableCell>
        <TableCell className='target-col-scenarios'>
          {item.scenarios.state === 'forbidden' ? <span className='text-label text-muted-foreground'>无权限查看</span> : <Link to='/scenarios' search={{ targetId: item.target.id }} className='block hover:underline'><span className='font-medium tabular-nums text-text-primary'>{item.scenarios.value.total} 个场景</span><span className='mt-1 block text-label text-muted-foreground'>{item.scenarios.value.active} 个启用</span></Link>}
        </TableCell>
        <TableCell className='target-col-activity'><ActivityCell item={item} /></TableCell>
      </TableRow>)}</TableBody>
    </Table>
  </div>
}
