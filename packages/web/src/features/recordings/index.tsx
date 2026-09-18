import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Edit2, Search, Trash2 } from 'lucide-react'
import { hasPermission, recordingSourceLabel, type RecordingDraftDto } from '@cairn/shared'
import { deleteRecording, fetchRecordings } from '@/lib/recordings-api'
import { fetchTargets } from '@/lib/targets-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { useAuthStore } from '@/stores/auth-store'
import { CursorPagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DateRangePicker, type DateRange } from '@/components/date-range-picker'
import { dateRange, rangeToDayKeys } from '@/features/audit/range'
import { RecordingRenameDialog } from './rename-dialog'

export function RecordingsPage() {
  const page = useCursorPage()
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.auth.user)
  const isAdmin = Boolean(user?.roles.includes('admin'))
  const canReadTargets = useCan('target:read')

  const targets = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canReadTargets,
  })

  const [search, setSearch] = useState('')
  const [targetId, setTargetId] = useState('all')
  const [hasPending, setHasPending] = useState<'all' | 'true'>('all')
  const [imported, setImported] = useState<'all' | 'true' | 'false'>('all')
  const [range, setRange] = useState<DateRange | undefined>()
  const [renaming, setRenaming] = useState<RecordingDraftDto | null>(null)
  const [removing, setRemoving] = useState<RecordingDraftDto | null>(null)

  const filters = useMemo(() => {
    const days = rangeToDayKeys(range)
    const bounds = dateRange(days.fromDay, days.toDay)
    return {
      search: search.trim() || undefined,
      targetId: targetId === 'all' ? undefined : targetId,
      hasPending: hasPending === 'all' ? undefined : true,
      imported: imported === 'all' ? undefined : imported === 'true',
      from: bounds.from?.toISOString(),
      to: bounds.to?.toISOString(),
      limit: page.pageSize,
      cursor: page.cursor,
    }
  }, [search, targetId, hasPending, imported, range, page.pageSize, page.cursor])

  const query = useQuery({
    queryKey: ['recordings', filters],
    queryFn: () => fetchRecordings(filters),
    placeholderData: keepPreviousData,
  })

  const handleSearchChange = (val: string) => {
    setSearch(val)
    page.reset()
  }

  const handleTargetChange = (val: string) => {
    setTargetId(val)
    page.reset()
  }

  const handleHasPendingChange = (val: 'all' | 'true') => {
    setHasPending(val)
    page.reset()
  }

  const items = query.data?.items ?? []

  const canEditItem = (item: RecordingDraftDto) =>
    hasPermission(user?.permissions ?? [], 'workflow:write') &&
    (isAdmin || item.createdBy.id === user?.id)

  const canDeleteItem = (item: RecordingDraftDto) =>
    hasPermission(user?.permissions ?? [], 'workflow:delete') &&
    (isAdmin || item.createdBy.id === user?.id)

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title='录制草稿'
          description='插件上传的操作序列。这里是 Authoring 草稿，还不是可运行场景。'
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError ? (
          <QueryErrorState title='无法加载录制草稿' onRetry={() => void query.refetch()} />
        ) : (
          <div className='overflow-hidden rounded-lg border border-border-card bg-card shadow-card'>
            <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-4'>
              <div className='flex flex-wrap items-center gap-2'>
                <Button
                  variant={hasPending === 'true' ? 'secondary' : 'ghost'}
                  size='sm'
                  aria-pressed={hasPending === 'true'}
                  onClick={() => handleHasPendingChange(hasPending === 'true' ? 'all' : 'true')}
                >
                  待处理
                </Button>
                <Button
                  variant={imported === 'true' ? 'secondary' : 'ghost'}
                  size='sm'
                  aria-pressed={imported === 'true'}
                  onClick={() => {
                    setImported(imported === 'true' ? 'all' : 'true')
                    page.reset()
                  }}
                >
                  已回填
                </Button>
                <DateRangePicker
                  value={range}
                  onChange={(next) => {
                    setRange(next)
                    page.reset()
                  }}
                />
                {canReadTargets && targets.data?.items && targets.data.items.length > 0 ? (
                  <Select value={targetId} onValueChange={handleTargetChange}>
                    <SelectTrigger className='h-8 w-44' aria-label='目标系统筛选'>
                      <SelectValue placeholder='全部目标系统' />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='all'>全部目标系统</SelectItem>
                      {targets.data.items.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
              <div className='relative w-full sm:w-72'>
                <Search
                  aria-hidden='true'
                  className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground'
                />
                <Input
                  aria-label='搜索录制草稿'
                  placeholder='搜索草稿名称'
                  value={search}
                  onChange={(event) => handleSearchChange(event.target.value)}
                  className='pl-9'
                />
              </div>
            </div>

            {items.length === 0 ? (
              <EmptyState
                title='没有匹配的录制草稿'
                description='在识途录制器里登录控制台账号、选择目标系统后上传，或调整筛选条件。'
                action={
                  search || targetId !== 'all' || hasPending !== 'all' || imported !== 'all' || range ? (
                    <Button
                      variant='outline'
                      onClick={() => {
                        setSearch('')
                        setTargetId('all')
                        setHasPending('all')
                        setImported('all')
                        setRange(undefined)
                        page.reset()
                      }}
                    >
                      清除筛选
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>场景名称</TableHead>
                    <TableHead>目标系统</TableHead>
                    <TableHead>来源</TableHead>
                    <TableHead>步骤</TableHead>
                    <TableHead>待处理</TableHead>
                    <TableHead>上传人</TableHead>
                    <TableHead>时间</TableHead>
                    <TableHead>
                      <span className='sr-only'>操作</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <Link
                          to='/recordings/$recordingId'
                          params={{ recordingId: item.id }}
                          className='font-medium text-primary hover:underline'
                        >
                          {item.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Link
                          to='/targets/$targetId'
                          params={{ targetId: item.targetId }}
                          className='text-primary hover:underline'
                        >
                          {item.targetName}
                        </Link>
                      </TableCell>
                      <TableCell>{recordingSourceLabel(item.sourceVersion)}</TableCell>
                      <TableCell>{item.itemCount}</TableCell>
                      <TableCell>{item.unresolvedCount}</TableCell>
                      <TableCell>{item.createdBy.displayName}</TableCell>
                      <TableCell className='text-muted-foreground'>
                        {new Date(item.createdAt).toLocaleString('zh-CN')}
                      </TableCell>
                      <TableCell>
                        <div className='flex items-center justify-end gap-1'>
                          {canEditItem(item) ? (
                            <Button
                              variant='ghost'
                              size='icon'
                              aria-label={`重命名${item.name}`}
                              onClick={() => setRenaming(item)}
                            >
                              <Edit2 className='size-4' />
                            </Button>
                          ) : null}
                          {canDeleteItem(item) ? (
                            <Button
                              variant='ghost'
                              size='icon'
                              className='text-destructive'
                              aria-label={`删除${item.name}`}
                              onClick={() => setRemoving(item)}
                            >
                              <Trash2 className='size-4' />
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <div className='flex flex-wrap items-center justify-between border-t border-border-divider px-4 py-3 gap-3'>
              <p role='status' className='text-label text-muted-foreground'>
                本页 {items.length} 条
              </p>
              <CursorPagination
                pageIndex={page.pageIndex}
                pageSize={page.pageSize}
                hasPreviousPage={page.pageIndex > 0}
                hasNextPage={Boolean(query.data?.nextCursor)}
                updating={query.isFetching && query.isPlaceholderData}
                onPageSizeChange={page.setPageSize}
                onPreviousPage={page.goPrev}
                onNextPage={() => {
                  if (query.data?.nextCursor) page.goNext(query.data.nextCursor)
                }}
              />
            </div>
          </div>
        )}
      </Main>

      <RecordingRenameDialog
        open={Boolean(renaming)}
        onOpenChange={(open) => {
          if (!open) setRenaming(null)
        }}
        recording={renaming}
        onRenamed={() => {
          setRenaming(null)
          void queryClient.invalidateQueries({ queryKey: ['recordings'] })
        }}
      />

      <ResourceDeleteDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
        resourceId={removing?.id ?? ''}
        resourceName={removing?.name ?? ''}
        resourceType='recording'
        deleteFn={() => (removing ? deleteRecording(removing.id) : Promise.resolve())}
        onSuccess={() => {
          setRemoving(null)
          if (items.length <= 1 && page.pageIndex > 0) page.goPrev()
          void queryClient.invalidateQueries({ queryKey: ['recordings'] })
        }}
      />
    </>
  )
}
