import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, Search } from 'lucide-react'
import { fetchMapAtlasPages } from '@/lib/map-api'
import { Button } from '@/components/ui/button'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ArchipelagoCanvas } from './archipelago-canvas'
import { IslandDetailDrawer } from './island-detail-drawer'
import './archipelago.css'

interface AtlasViewProps {
  targetId: string
  pageId?: string
  objectId?: string
  searchQuery?: string
  onSelectPage: (pageId: string | undefined) => void
  onSelectObject: (objectId: string | undefined) => void
  onSearchChange: (search: string) => void
}

export function AtlasView({
  targetId,
  pageId,
  objectId,
  searchQuery = '',
  onSelectPage,
  onSelectObject,
  onSearchChange,
}: AtlasViewProps) {
  const [filter, setFilter] = useState<'all' | 'review' | 'trusted' | 'discovered'>('all')

  const atlasQuery = useQuery({
    queryKey: ['map', targetId, 'atlas-pages', searchQuery],
    queryFn: () =>
      fetchMapAtlasPages(targetId, {
        search: searchQuery.trim() || undefined,
        limit: 50,
      }),
  })

  const rawItems = atlasQuery.data?.items ?? []

  // Client-side filtering by health status
  const filteredItems = useMemo(() => {
    if (filter === 'all') return rawItems
    if (filter === 'review') {
      return rawItems.filter((item) => item.uniqueNeedsAttentionCount > 0)
    }
    if (filter === 'trusted') {
      return rawItems.filter((item) => item.uniqueNeedsAttentionCount === 0 && item.uniqueObjectCount > 0)
    }
    return rawItems
  }, [rawItems, filter])

  const selectedPageItem = useMemo(
    () => rawItems.find((item) => item.pageId === pageId),
    [rawItems, pageId],
  )

  const totalObjects = useMemo(
    () => rawItems.reduce((sum, item) => sum + item.uniqueObjectCount, 0),
    [rawItems],
  )

  return (
    <div className='space-y-3'>
      {/* 探索工具条 */}
      <div className='flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-border-card bg-surface p-2.5 shadow-sm'>
        <div className='flex flex-1 items-center gap-2 max-w-sm'>
          <div className='relative w-full'>
            <Search className='absolute left-2.5 top-2.5 size-4 text-text-muted' />
            <input
              type='search'
              placeholder='搜索海岛名称、路由或对象…'
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              className='w-full rounded-md border border-border-card bg-surface-subtle pl-8 pr-3 py-1.5 text-body text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-border-focus'
            />
          </div>
        </div>

        {/* 状态筛选组 */}
        <div className='flex items-center gap-1 rounded-lg border border-border-card bg-surface-subtle p-1'>
          <Button
            variant={filter === 'all' ? 'secondary' : 'ghost'}
            size='sm'
            className='h-7 text-caption'
            onClick={() => setFilter('all')}
          >
            全部
          </Button>
          <Button
            variant={filter === 'review' ? 'secondary' : 'ghost'}
            size='sm'
            className='h-7 gap-1.5 text-caption'
            onClick={() => setFilter('review')}
          >
            <span className='archipelago-legend-dot archipelago-legend-dot--review' />
            需关注
          </Button>
          <Button
            variant={filter === 'trusted' ? 'secondary' : 'ghost'}
            size='sm'
            className='h-7 gap-1.5 text-caption'
            onClick={() => setFilter('trusted')}
          >
            <span className='archipelago-legend-dot archipelago-legend-dot--trusted' />
            已健康
          </Button>
        </div>
      </div>

      {/* 海图主容器 */}
      <div className='archipelago-container'>
        {/* 海图顶部状态线 */}
        <div className='archipelago-topline'>
          <div className='flex items-center gap-3 min-w-0'>
            <span className='archipelago-signal' aria-hidden='true' />
            <div className='min-w-0'>
              <h2 className='truncate text-body font-bold text-white'>
                知识资产全景海域
              </h2>
              <p className='text-caption text-[#98bdba]'>
                已观测 {atlasQuery.data?.totalObservedPages ?? rawItems.length} 座页面海岛 ·{' '}
                {totalObjects} 个知识地标
              </p>
            </div>
          </div>

          <div className='flex items-center gap-2'>
            {selectedPageItem ? (
              <div className='flex items-center gap-1.5 text-caption text-[#bfe5da]'>
                <button
                  type='button'
                  className='hover:underline hover:text-white'
                  onClick={() => {
                    onSelectPage(undefined)
                    onSelectObject(undefined)
                  }}
                >
                  全景海图
                </button>
                <span className='text-[#5f8991]'>/</span>
                <span className='font-semibold text-white truncate max-w-[140px]'>
                  {selectedPageItem.displayName}
                </span>
              </div>
            ) : null}

            <Button
              variant='ghost'
              size='sm'
              className='h-7 text-[#bfe5da] hover:bg-[#244b54] hover:text-white'
              onClick={() => void atlasQuery.refetch()}
              title='重新测绘海域'
            >
              <RefreshCw className='size-3.5' />
            </Button>
          </div>
        </div>

        {/* 视口与抽屉 */}
        {atlasQuery.isLoading ? (
          <div className='flex-1 min-h-0 flex items-center justify-center p-12'>
            <PageSkeleton />
          </div>
        ) : atlasQuery.isError ? (
          <div className='flex-1 min-h-0 flex items-center justify-center p-6'>
            <QueryErrorState
              description={atlasQuery.error?.message}
              onRetry={() => void atlasQuery.refetch()}
            />
          </div>
        ) : (
          <div className='archipelago-viewport'>
            <ArchipelagoCanvas
              items={filteredItems}
              selectedPageId={pageId}
              onSelectPage={(id) => {
                onSelectPage(id)
                if (id !== pageId) {
                  onSelectObject(undefined)
                }
              }}
            />

            {selectedPageItem ? (
              <IslandDetailDrawer
                targetId={targetId}
                pageItem={selectedPageItem}
                selectedObjectId={objectId}
                onSelectObject={onSelectObject}
                onClose={() => {
                  onSelectPage(undefined)
                  onSelectObject(undefined)
                }}
              />
            ) : null}
          </div>
        )}

        {/* 海图底边图例与拓扑说明 */}
        <div className='archipelago-bottomline'>
          <div className='flex items-center gap-4 flex-wrap'>
            <span className='inline-flex items-center gap-1.5'>
              <i className='archipelago-legend-dot archipelago-legend-dot--review' />
              待复核或异常
            </span>
            <span className='inline-flex items-center gap-1.5'>
              <i className='archipelago-legend-dot archipelago-legend-dot--trusted' />
              已确认健康
            </span>
            <span className='inline-flex items-center gap-1.5'>
              <i className='archipelago-legend-dot archipelago-legend-dot--discovered' />
              已发现待观测
            </span>
          </div>
          <span>空间位置采用确定性拓扑聚类 · 呈现知识资产航道全貌</span>
        </div>
      </div>
    </div>
  )
}
