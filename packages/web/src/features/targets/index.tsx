import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import type { TargetDto, TargetOverviewQuery, TargetOverviewResponse } from '@cairn/shared'
import { Plus, RefreshCw, Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchTarget, fetchTargetOverview, previewDeleteTarget, deleteTarget } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { canCreateTarget } from '@/lib/rbac'
import { useAuthStore } from '@/stores/auth-store'
import { CursorPagination } from '@/components/data-table'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { QueryErrorState } from '@/components/query-error-state'
import { TargetFormDialog } from './target-form-dialog'
import { TargetOverviewPanel } from './target-overview-panel'
import { TargetOverviewList } from './target-overview-list'
import { TargetOverviewSummary } from './target-overview-summary'
import { type OverviewFilter, type OverviewSort, type OverviewSortColumn, type TargetOverviewItem, overviewSortDefaultDirection, sortOverviewItems } from './target-overview-display'
import './target-overview-page.css'

const route = getRouteApi('/_authenticated/targets/')
const filterLabels: Record<OverviewFilter, string> = {
  all: '全部系统', ready: '空闲已登录', need_login: '需要登录', running: '执行中',
}
const pageSizes = [10, 20, 50] as const

function LoadingState() {
  return <>
    <div className='grid grid-cols-2 gap-3 lg:grid-cols-4' aria-label='正在加载运行概览'>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className='h-28 rounded-xl' />)}</div>
    <div className='space-y-2 rounded-lg border border-border-card bg-card p-4'>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className='h-18' />)}</div>
  </>
}

export function TargetsPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const queryClient = useQueryClient()
  const user = useAuthStore((state) => state.auth.user)
  const canCreate = canCreateTarget(user)
  const canReadSession = useCan('session:read')
  const [createOpen, setCreateOpen] = useState(Boolean((search as any)?.action === 'create' && canCreate))
  const [editing, setEditing] = useState<TargetDto | null>(null)
  const [editLoadingId, setEditLoadingId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<TargetOverviewItem | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [selectionMissing, setSelectionMissing] = useState(Boolean(search.selected))

  useEffect(() => {
    if ((search as any)?.action === 'create' && canCreate) {
      setCreateOpen(true)
    }
  }, [(search as any)?.action, canCreate])
  const mainRef = useRef<HTMLElement | null>(null)
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [searchDraft, setSearchDraft] = useState({ base: search.q ?? '', value: search.q ?? '' })
  const searchText = searchDraft.base === (search.q ?? '') ? searchDraft.value : (search.q ?? '')
  const setSearchText = (value: string) => setSearchDraft({ base: search.q ?? '', value })
  const [pendingState, setPendingState] = useState<{ key: string; data: TargetOverviewResponse } | null>(null)
  const [refreshErrorKey, setRefreshErrorKey] = useState<string | null>(null)

  const filter = search.filter ?? 'all'
  const sort: OverviewSort = search.sort === 'name' ? 'system-asc' : search.sort ?? 'created'
  const page = search.page ?? 1
  const pageSize = pageSizes.includes(search.pageSize as typeof pageSizes[number]) ? search.pageSize! : 20
  const filters = useMemo<TargetOverviewQuery>(() => ({
    search: search.q?.trim() || undefined,
    filter,
  }), [search.q, filter])
  const filterKey = JSON.stringify(filters)
  const pendingSnapshot = pendingState?.key === filterKey ? pendingState.data : null
  const refreshError = refreshErrorKey === filterKey
  const queryKey = useMemo(() => ['targets', 'overview', filters] as const, [filters])
  const query = useQuery({
    queryKey,
    queryFn: () => fetchTargetOverview(filters),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  })
  const updateSearch = (patch: Partial<typeof search>, replace = false) => {
    void navigate({ to: '/targets', search: (previous) => ({ ...previous, ...patch }), replace })
  }

  useEffect(() => {
    if (searchText === (search.q ?? '')) return
    const timer = window.setTimeout(() => updateSearch({ q: searchText.trim() || undefined, page: 1 }, true), 250)
    return () => window.clearTimeout(timer)
  // Debounce the draft; committed URL search is the query source.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, search.q])

  const data = query.data
  const items = useMemo(() => sortOverviewItems(data?.items ?? [], sort), [data?.items, sort])
  const selected = items.find((item) => item.target.id === search.selected)
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const visibleItems = items.slice((currentPage - 1) * pageSize, currentPage * pageSize)

  useEffect(() => {
    if (!data || query.isPlaceholderData) return
    const patch: Partial<typeof search> = {}
    if (page > pageCount) patch.page = pageCount
    if (search.selected && !selected) {
      // The accepted server snapshot invalidated the URL selection; retain the
      // prompt after removing that ID from the URL until the user chooses a row.
      // This local notice must survive removing the stale ID from URL search.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (!selectionMissing) setSelectionMissing(true)
      patch.selected = undefined
    } else if (search.selected === undefined && items.length > 0 && !selectionMissing) {
      patch.selected = items[0].target.id
    }
    if (Object.keys(patch).length > 0) updateSearch(patch, true)
  // Only accepted results may change the selected URL target.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, query.isPlaceholderData, page, pageCount, search.selected, selected, selectionMissing])

  useEffect(() => {
    const onFocus = () => {
      if (!query.data || document.visibilityState === 'hidden') return
      void fetchTargetOverview(filters).then((next) => {
        if (next.snapshotToken !== query.data?.snapshotToken) setPendingState({ key: filterKey, data: next })
        else queryClient.setQueryData(queryKey, next)
      }).catch(() => setRefreshErrorKey(filterKey))
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [filters, filterKey, query.data, queryClient, queryKey])

  const refreshSnapshot = async () => {
    try {
      const next = await fetchTargetOverview(filters)
      setRefreshErrorKey(null)
      if (next.snapshotToken !== data?.snapshotToken) setPendingState({ key: filterKey, data: next })
      else queryClient.setQueryData(queryKey, next)
    } catch { setRefreshErrorKey(filterKey) }
  }
  const applySnapshot = () => {
    if (!pendingSnapshot) return
    queryClient.setQueryData(queryKey, pendingSnapshot)
    setPendingState(null)
    updateSearch({ page: 1 }, true)
  }
  const selectFilter = (next: OverviewFilter) => {
    setSearchText('')
    updateSearch({ q: undefined, filter: next, page: 1 })
  }
  const clearFilters = () => {
    setSearchText('')
    updateSearch({ q: undefined, filter: 'all', page: 1 })
  }
  const selectSort = (column: OverviewSortColumn) => {
    const active = sort.startsWith(column + '-')
    const defaultDirection = overviewSortDefaultDirection[column]
    const nextSort: OverviewSort = !active ? `${column}-${defaultDirection}`
      : `${column}-${sort.endsWith('-asc') ? 'desc' : 'asc'}`
    updateSearch({ sort: nextSort, page: 1 })
  }
  const hasFilters = Boolean(search.q || filter !== 'all')
  const allSelected = filter === 'all' && !search.q
  const filterAvailable = (value: OverviewFilter) => {
    if (value === 'all') return true
    if (!data) return false
    return (value === 'running' ? data.summary.runningTargets : value === 'ready' ? data.summary.readyTargets : data.summary.needLoginTargets).coverage !== 'forbidden'
  }
  const isCompactLayout = () => {
    const main = mainRef.current
    if (!main) return false
    const style = window.getComputedStyle(main)
    const contentWidth = main.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight)
    return contentWidth <= 1120
  }
  const selectTarget = (id: string, trigger: HTMLButtonElement, forcePreview = false) => {
    setSelectionMissing(false)
    updateSearch({ selected: id })
    if (forcePreview || isCompactLayout()) {
      previewTriggerRef.current = trigger
      setPreviewOpen(true)
    }
  }
  const openEdit = async (id: string) => {
    if (editLoadingId) return
    setEditLoadingId(id)
    try {
      // 概览仅返回身份字段，编辑表单必须使用完整目标配置。
      setEditing(await fetchTarget(id))
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '无法加载目标系统配置')
    } finally {
      setEditLoadingId(null)
    }
  }

  return <>
    <Main ref={mainRef} className='target-overview-page flex min-w-0 flex-1 flex-col gap-4'>
      <PageHeader title='目标系统' description='查看业务系统的运行准备、目标账号与最近活动。' actions={data || canCreate ? <>
        {data ? <Button variant='outline' onClick={() => void refreshSnapshot()} title={'数据更新于 ' + new Date(data.asOf).toLocaleString('zh-CN')}><RefreshCw className='size-4' />刷新</Button> : null}
        {canCreate ? <Button onClick={() => setCreateOpen(true)}><Plus className='size-4' />新建系统</Button> : null}
      </> : null} />
      {query.isPending && !data ? <LoadingState /> : query.isError && !data ? <QueryErrorState title='无法加载目标系统概览' onRetry={() => void query.refetch()} /> : data ? <>
        <TargetOverviewSummary data={data} selected={filter} allSelected={allSelected} onSelect={selectFilter} />
        {pendingSnapshot ? <div role='status' className='flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-default bg-card px-4 py-2 text-small'><span>有更新可用。应用后重新从第一页查看。</span><Button size='sm' onClick={applySnapshot}>应用新快照</Button></div> : null}
        {query.isError || query.isPlaceholderData || refreshError ? <div role='status' className='flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-default bg-card px-4 py-2 text-small'><span>{query.isPlaceholderData ? '筛选更新中，当前显示上次快照。' : '概览更新失败，当前显示上次快照，数据可能已过期。'}</span><Button size='sm' variant='outline' onClick={() => void refreshSnapshot()}>重试</Button></div> : null}
        <div className='target-overview-layout grid min-w-0 items-start gap-4'>
          <section aria-label='目标系统列表' className='min-w-0 overflow-hidden rounded-xl border border-border-card bg-card shadow-card'>
            <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider px-4 py-3'>
              <div className='flex flex-wrap items-center gap-1' aria-label='运行状态筛选'>{(['all', 'ready', 'need_login', 'running'] as const).filter(filterAvailable).map((value) => <Button key={value} variant={filter === value ? 'secondary' : 'ghost'} size='sm' aria-pressed={filter === value} onClick={() => selectFilter(value)}>{filterLabels[value]}</Button>)}{hasFilters ? <Button variant='ghost' size='sm' onClick={clearFilters}><X className='size-3.5' />清除筛选</Button> : null}</div>
              <div className='relative w-full sm:w-60'><Search aria-hidden='true' className='pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground' /><Input aria-label='搜索目标系统' aria-description={canReadSession ? '账号搜索仅覆盖有会话权限的系统' : undefined} title={canReadSession ? '账号搜索仅覆盖有会话权限的系统' : undefined} placeholder={canReadSession ? '搜索系统、编码或可见账号' : '搜索系统名称或编码'} value={searchText} onChange={(event) => setSearchText(event.target.value)} className='pl-9' /></div>
            </div>
            {items.length === 0 ? <EmptyState title={data.summary.totalTargets === 0 ? '还没有目标系统' : '没有匹配的目标系统'} description={data.summary.totalTargets === 0 ? canCreate ? '登记第一个业务系统，之后可按场景需要添加目标账号。' : '请联系有权限的成员登记业务系统。' : '调整搜索词或筛选条件后重试。'} action={data.summary.totalTargets === 0 ? canCreate ? <Button onClick={() => setCreateOpen(true)}>新建系统</Button> : undefined : <Button variant='outline' onClick={clearFilters}>清除筛选</Button>} /> : <TargetOverviewList items={visibleItems} selectedId={selected?.target.id} sort={sort} onSort={selectSort} onSelect={(id, trigger) => selectTarget(id, trigger)} onPreview={(id, trigger) => selectTarget(id, trigger, true)} />}
            <div className='flex flex-wrap items-center justify-between gap-3 border-t border-border-divider px-4 py-2 text-label text-muted-foreground'><span>第 {currentPage} / {pageCount} 页 · 本页 {visibleItems.length} 条</span><CursorPagination pageIndex={currentPage - 1} pageSize={pageSize as typeof pageSizes[number]} hasPreviousPage={currentPage > 1} hasNextPage={currentPage < pageCount} updating={query.isFetching && query.isPlaceholderData} onPageSizeChange={(size) => updateSearch({ pageSize: size, page: 1 })} onPreviousPage={() => updateSearch({ page: currentPage - 1 })} onNextPage={() => updateSearch({ page: currentPage + 1 })} /></div>
          </section>
          <div className='target-overview-aside min-w-0'>{selected ? <TargetOverviewPanel key={selected.target.id} item={selected} onDelete={setRemoving} onEdit={(item) => void openEdit(item.target.id)} editing={editLoadingId === selected.target.id} /> : <div className='rounded-xl border border-border-card bg-card p-5 text-small text-muted-foreground'>{selectionMissing ? '选中的系统不在当前结果中，请重新选择。' : '选择一条系统记录，查看运行准备与下一步操作。'}</div>}</div>
        </div>
      </> : null}
    </Main>
    <Sheet open={previewOpen} onOpenChange={setPreviewOpen}><SheetContent side='right' className='target-overview-sheet w-full max-w-md gap-0 overflow-y-auto p-0' onCloseAutoFocus={(event) => { event.preventDefault(); if (previewTriggerRef.current?.isConnected) previewTriggerRef.current.focus() }}><SheetHeader className='border-b border-border-divider'><SheetTitle>系统概览</SheetTitle></SheetHeader>{selected ? <TargetOverviewPanel key={selected.target.id} item={selected} onDelete={setRemoving} onEdit={(item) => void openEdit(item.target.id)} editing={editLoadingId === selected.target.id} compact /> : null}</SheetContent></Sheet>
    <TargetFormDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(target) => { void navigate({ to: '/targets/$targetId', params: { targetId: target.id } }) }} />
    <TargetFormDialog open={Boolean(editing)} onOpenChange={(open) => { if (!open) setEditing(null) }} current={editing ?? undefined} />
    <ResourceDeleteDialog open={Boolean(removing)} onOpenChange={(next) => { if (!next) setRemoving(null) }} resourceId={removing?.target.id ?? ''} resourceName={removing ? removing.target.name + '（' + removing.target.code + '）' : ''} resourceType='target' previewFn={removing ? () => previewDeleteTarget(removing.target.id) : undefined} deleteFn={(body) => removing ? deleteTarget(removing.target.id, body) : Promise.resolve()} onSuccess={async () => { setRemoving(null); await queryClient.invalidateQueries({ queryKey: ['targets', 'overview'] }) }} />
  </>
}
