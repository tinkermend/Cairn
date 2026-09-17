import type { KeyboardEvent } from 'react'
import type { RecordingItem, RecordingItemStatus } from '@cairn/shared'
import {
  AlertCircle,
  CheckCircle2,
  Compass,
  KeyRound,
  Keyboard,
  Layers,
  ListFilter,
  MousePointerClick,
  PenTool,
  PlayCircle,
  Search,
} from 'lucide-react'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export type FilterOption = 'all' | RecordingItemStatus | 'sensitive'

type Props = {
  items: RecordingItem[]
  selectedIndex: number
  onSelectIndex: (index: number) => void
  statusFilter: FilterOption
  onStatusFilterChange: (filter: FilterOption) => void
  searchQuery: string
  onSearchQueryChange: (query: string) => void
}

function getStepIcon(action: string, candidateType?: string) {
  const type = candidateType ?? action
  switch (type) {
    case 'navigate':
      return <Compass className='size-4 text-primary shrink-0' />
    case 'click':
      return <MousePointerClick className='size-4 text-primary shrink-0' />
    case 'fill':
      return <PenTool className='size-4 text-status-success-foreground shrink-0' />
    case 'select':
      return <ListFilter className='size-4 text-primary-500 shrink-0' />
    case 'keyboard':
    case 'press':
      return <Keyboard className='size-4 text-ai-foreground shrink-0' />
    case 'assert':
      return <CheckCircle2 className='size-4 text-status-warning-foreground shrink-0' />
    default:
      return <PlayCircle className='size-4 text-muted-foreground shrink-0' />
  }
}

function extractTargetSummary(item: RecordingItem): string | null {
  if (!item.input || typeof item.input !== 'object') return null
  const input = item.input as Record<string, unknown>
  if (typeof input.targetUrl === 'string') return input.targetUrl
  if (typeof input.selector === 'string') return input.selector
  if (typeof input.value === 'string' && item.sensitive) return '••••••'
  if (typeof input.value === 'string') return `"${input.value}"`
  if (typeof input.key === 'string') return `按键: ${input.key}`
  return null
}

const STATUS_CONFIG: Record<RecordingItemStatus, { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  mapped: { label: '可导入', tone: 'success' },
  parameterized: { label: '需补参数', tone: 'warning' },
  unresolved: { label: '待处理', tone: 'neutral' },
}

export function RecordingStepStream({
  items,
  selectedIndex,
  onSelectIndex,
  statusFilter,
  onStatusFilterChange,
  searchQuery,
  onSearchQueryChange,
}: Props) {
  const mappedCount = items.filter((i) => i.status === 'mapped').length
  const parameterizedCount = items.filter((i) => i.status === 'parameterized').length
  const unresolvedCount = items.filter((i) => i.status === 'unresolved').length

  const filteredItems = items.filter((item) => {
    // 状态过滤
    if (statusFilter === 'mapped' && item.status !== 'mapped') return false
    if (statusFilter === 'parameterized' && item.status !== 'parameterized') return false
    if (statusFilter === 'unresolved' && item.status !== 'unresolved') return false
    if (statusFilter === 'sensitive' && !item.sensitive) return false

    // 搜索过滤
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      const matchName = item.name.toLowerCase().includes(q)
      const matchAction = item.sourceAction.toLowerCase().includes(q)
      const targetSummary = extractTargetSummary(item)?.toLowerCase() ?? ''
      const matchTarget = targetSummary.includes(q)
      if (!matchName && !matchAction && !matchTarget) return false
    }

    return true
  })

  const handleKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    if (filteredItems.length === 0) return
    const currentFilteredIdx = filteredItems.findIndex((i) => i.index === selectedIndex)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const nextIdx = Math.min(filteredItems.length - 1, (currentFilteredIdx === -1 ? 0 : currentFilteredIdx) + 1)
      onSelectIndex(filteredItems[nextIdx].index)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prevIdx = Math.max(0, (currentFilteredIdx === -1 ? 0 : currentFilteredIdx) - 1)
      onSelectIndex(filteredItems[prevIdx].index)
    }
  }

  return (
    <div className='flex flex-col gap-3'>
      {/* 快捷过滤工具条 */}
      <div className='flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-border-card bg-card p-2.5 shadow-card'>
        <div className='flex flex-wrap items-center gap-1'>
          <Button
            size='sm'
            variant={statusFilter === 'all' ? 'secondary' : 'ghost'}
            className='h-7 px-2.5 text-label'
            onClick={() => onStatusFilterChange('all')}
          >
            全部 ({items.length})
          </Button>
          <Button
            size='sm'
            variant={statusFilter === 'unresolved' ? 'secondary' : 'ghost'}
            className={cn(
              'h-7 px-2.5 text-label',
              unresolvedCount > 0 && statusFilter !== 'unresolved' && 'text-status-error-foreground',
            )}
            onClick={() => onStatusFilterChange(statusFilter === 'unresolved' ? 'all' : 'unresolved')}
          >
            待处理 ({unresolvedCount})
          </Button>
          <Button
            size='sm'
            variant={statusFilter === 'parameterized' ? 'secondary' : 'ghost'}
            className={cn(
              'h-7 px-2.5 text-label',
              parameterizedCount > 0 && statusFilter !== 'parameterized' && 'text-status-warning-foreground',
            )}
            onClick={() => onStatusFilterChange(statusFilter === 'parameterized' ? 'all' : 'parameterized')}
          >
            待补参 ({parameterizedCount})
          </Button>
          <Button
            size='sm'
            variant={statusFilter === 'mapped' ? 'secondary' : 'ghost'}
            className='h-7 px-2.5 text-label'
            onClick={() => onStatusFilterChange(statusFilter === 'mapped' ? 'all' : 'mapped')}
          >
            已就绪 ({mappedCount})
          </Button>
        </div>

        {/* 关键字搜索输入框 */}
        <div className='relative w-full sm:w-52'>
          <Search className='absolute left-2.5 top-2 size-3.5 text-muted-foreground' />
          <Input
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder='搜索步骤或选择器…'
            className='h-7 pl-8 pr-2.5 text-label'
            aria-label='搜索录制步骤'
          />
        </div>
      </div>

      {/* 步骤时间线列表 */}
      {filteredItems.length === 0 ? (
        <div className='rounded-lg border border-border-card bg-card p-8 text-center shadow-card'>
          <p className='text-body font-medium text-muted-foreground'>没有匹配的录制步骤</p>
          <p className='mt-1 text-label text-muted-foreground'>尝试更改状态筛选或清除搜索关键词</p>
          {(statusFilter !== 'all' || searchQuery) && (
            <Button
              size='sm'
              variant='outline'
              className='mt-3'
              onClick={() => {
                onStatusFilterChange('all')
                onSearchQueryChange('')
              }}
            >
              重置过滤条件
            </Button>
          )}
        </div>
      ) : (
        <ol
          className='space-y-2 focus:outline-none'
          tabIndex={0}
          onKeyDown={handleKeyDown}
          aria-label='录制操作步骤列表，可用方向上下键切换'
        >
          {filteredItems.map((item) => {
            const isSelected = item.index === selectedIndex
            const targetSummary = extractTargetSummary(item)
            const statusInfo = STATUS_CONFIG[item.status]

            return (
              <li key={`${item.index}-${item.sourceAction}`}>
                <button
                  type='button'
                  onClick={() => onSelectIndex(item.index)}
                  className={cn(
                    'w-full text-left rounded-lg border p-3 shadow-card transition-colors flex items-start gap-3',
                    isSelected
                      ? 'border-primary bg-primary-50/80 ring-1 ring-primary/40'
                      : 'border-border-card bg-card hover:border-border-card-hover hover:bg-muted/40',
                  )}
                >
                  {/* 步号指示器 */}
                  <div
                    className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-md text-label font-semibold tracking-tight',
                      isSelected
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-surface-subtle text-muted-foreground border border-border-divider',
                    )}
                  >
                    {String(item.index + 1).padStart(2, '0')}
                  </div>

                  {/* 步骤正文内容 */}
                  <div className='min-w-0 flex-1 space-y-1'>
                    <div className='flex items-center justify-between gap-2'>
                      <div className='flex items-center gap-2 min-w-0'>
                        {getStepIcon(item.sourceAction, item.candidateStepType)}
                        <span className='text-body font-medium text-foreground truncate'>{item.name}</span>
                      </div>
                      <StatusBadge tone={statusInfo.tone}>{statusInfo.label}</StatusBadge>
                    </div>

                    {/* 目标选择器或URL语义提炼 */}
                    {targetSummary ? (
                      <div className='flex items-center gap-1.5 text-label text-muted-foreground font-mono truncate'>
                        <span className='truncate'>{targetSummary}</span>
                      </div>
                    ) : null}

                    {/* 辅助属性徽标行 */}
                    <div className='flex flex-wrap items-center gap-2 pt-0.5 text-label text-muted-foreground'>
                      <span>来源动作: {item.sourceAction}</span>
                      {item.candidateStepType ? (
                        <span>· 候选类型: <code className='text-primary font-mono'>{item.candidateStepType}</code></span>
                      ) : null}
                      {item.sensitive ? (
                        <span className='inline-flex items-center gap-1 text-status-warning-foreground font-medium'>
                          <KeyRound className='size-3' />
                          敏感脱敏
                        </span>
                      ) : null}
                      {item.framePath && item.framePath.length > 0 ? (
                        <span className='inline-flex items-center gap-1 text-muted-foreground'>
                          <Layers className='size-3' />
                          iframe ({item.framePath.length}层)
                        </span>
                      ) : null}
                      {item.diagnostics.length > 0 ? (
                        <span className='inline-flex items-center gap-1 text-status-warning-foreground'>
                          <AlertCircle className='size-3' />
                          {item.diagnostics.length} 项告警
                        </span>
                      ) : null}
                    </div>
                  </div>
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
