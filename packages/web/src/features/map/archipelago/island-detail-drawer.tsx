import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { MapAtlasPageItem, MapAssetListItem } from '@cairn/shared'
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  FileCheck2,
  Layers,
  MapPin,
  X,
} from 'lucide-react'
import { fetchMapObject, fetchMapObjects } from '@/lib/map-api'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/status-badge'
import { MAP_LIFECYCLE_LABELS } from '../labels'

interface IslandDetailDrawerProps {
  targetId: string
  pageItem: MapAtlasPageItem
  selectedObjectId?: string
  onSelectObject: (objectId: string | undefined) => void
  onClose: () => void
}

export function IslandDetailDrawer({
  targetId,
  pageItem,
  selectedObjectId,
  onSelectObject,
  onClose,
}: IslandDetailDrawerProps) {
  const [objectFilter, setObjectFilter] = useState('')

  // 1. Fetch objects belonging to this island/page
  const objectsQuery = useQuery({
    queryKey: ['map', targetId, 'page-objects', pageItem.pageId],
    queryFn: () =>
      fetchMapObjects(targetId, {
        pageId: pageItem.pageId,
        limit: 100,
      }),
  })

  // 2. Fetch specific object detail when selected
  const detailQuery = useQuery({
    queryKey: ['map', targetId, 'object-detail', selectedObjectId],
    queryFn: () => fetchMapObject(targetId, selectedObjectId!),
    enabled: Boolean(selectedObjectId),
  })

  const rawObjects = objectsQuery.data?.items ?? []
  const filteredObjects = objectFilter.trim()
    ? rawObjects.filter((obj) =>
        (obj.name || obj.assetRefKey).toLowerCase().includes(objectFilter.trim().toLowerCase()),
      )
    : rawObjects

  const objectDetail = detailQuery.data

  return (
    <aside
      className='archipelago-drawer flex h-full w-full flex-col border-l border-border-card bg-surface-subtle shadow-md lg:w-[420px]'
      aria-label={`${pageItem.displayName} 岛屿知识详情`}
    >
      {/* 抽屉顶部标头 */}
      <div className='flex items-center justify-between border-b border-border-card px-4 py-3 bg-surface'>
        <div className='flex min-w-0 flex-1 items-center gap-2'>
          {selectedObjectId ? (
            <Button
              variant='ghost'
              size='sm'
              className='h-7 px-1.5 text-text-muted hover:text-text-primary'
              onClick={() => onSelectObject(undefined)}
              title='返回海岛对象列表'
            >
              <ArrowLeft className='size-4' />
            </Button>
          ) : (
            <MapPin className='size-4 text-text-muted shrink-0' />
          )}
          <div className='min-w-0 flex-1'>
            <h3 className='truncate text-body font-semibold text-text-primary'>
              {selectedObjectId ? (objectDetail?.name ?? '知识对象详情') : pageItem.displayName}
            </h3>
            <p className='truncate text-caption text-text-muted'>
              {pageItem.routeSummary}
            </p>
          </div>
        </div>
        <Button
          variant='ghost'
          size='sm'
          className='h-7 w-7 p-0 text-text-muted hover:text-text-primary'
          onClick={onClose}
          aria-label='关闭详情'
        >
          <X className='size-4' />
        </Button>
      </div>

      <ScrollArea className='flex-1 p-4'>
        {selectedObjectId ? (
          /* ── 单个对象详情视图 ── */
          <div className='space-y-4'>
            {detailQuery.isLoading ? (
              <div className='space-y-3'>
                <Skeleton className='h-6 w-3/4' />
                <Skeleton className='h-20 w-full' />
                <Skeleton className='h-28 w-full' />
              </div>
            ) : objectDetail ? (
              <>
                {/* 状态与基础属性 */}
                <div className='rounded-lg border border-border-card bg-surface p-3 space-y-2'>
                  <div className='flex items-center justify-between'>
                    <span className='text-caption text-text-muted'>生命周期</span>
                    <StatusBadge
                      tone={
                        objectDetail.lifecycle === 'TRUSTED'
                          ? 'success'
                          : objectDetail.lifecycle === 'DEGRADED'
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {MAP_LIFECYCLE_LABELS[objectDetail.lifecycle] ?? objectDetail.lifecycle}
                    </StatusBadge>
                  </div>
                  <div className='flex items-center justify-between'>
                    <span className='text-caption text-text-muted'>证据完整性</span>
                    <span className='text-caption font-medium text-text-primary'>
                      {objectDetail.evidenceAvailability === 'available'
                        ? '完全可用 (Available)'
                        : objectDetail.evidenceAvailability === 'partial'
                          ? '部分可用 (Partial)'
                          : '不可用 (Unavailable)'}
                    </span>
                  </div>
                  <div className='flex items-center justify-between'>
                    <span className='text-caption text-text-muted'>变更记录</span>
                    <span className='text-caption text-text-primary'>
                      {objectDetail.changeCount > 0 ? `${objectDetail.changeCount} 次` : '无变更'}
                    </span>
                  </div>
                  {objectDetail.lastVerifiedAt ? (
                    <div className='flex items-center justify-between'>
                      <span className='text-caption text-text-muted'>最近验证</span>
                      <span className='text-caption text-text-primary'>
                        {new Date(objectDetail.lastVerifiedAt).toLocaleString()}
                      </span>
                    </div>
                  ) : null}
                </div>

                {/* 溯源上下文 (sourceContext) */}
                <div className='rounded-lg border border-border-card bg-surface p-3 space-y-2.5'>
                  <div className='flex items-center gap-1.5 text-caption font-semibold text-text-primary'>
                    <Clock className='size-3.5 text-text-muted' />
                    <span>执行溯源上下文 (Provenance)</span>
                  </div>

                  {objectDetail.sourceContext?.latestRunId ? (
                    <div className='space-y-2 text-caption'>
                      <div className='flex items-center justify-between'>
                        <span className='text-text-muted'>产出运行</span>
                        <Link
                          to='/runs/$runId'
                          params={{ runId: objectDetail.sourceContext.latestRunId }}
                          className='inline-flex items-center gap-1 font-mono text-link hover:underline'
                        >
                          {objectDetail.sourceContext.latestRunId.slice(0, 8)}…
                          <ExternalLink className='size-3' />
                        </Link>
                      </div>

                      {objectDetail.sourceContext.latestScenarioId ? (
                        <div className='flex items-center justify-between'>
                          <span className='text-text-muted'>关联场景</span>
                          <Link
                            to='/scenarios/$scenarioId'
                            params={{ scenarioId: objectDetail.sourceContext.latestScenarioId }}
                            className='inline-flex items-center gap-1 font-mono text-link hover:underline'
                          >
                            {objectDetail.sourceContext.latestScenarioId.slice(0, 8)}…
                            <ExternalLink className='size-3' />
                          </Link>
                        </div>
                      ) : null}

                      {objectDetail.sourceContext.latestStepRunId ? (
                        <div className='flex items-center justify-between'>
                          <span className='text-text-muted'>步骤尝试</span>
                          <span className='font-mono text-text-primary'>
                            {objectDetail.sourceContext.latestStepRunId.slice(0, 8)}…
                          </span>
                        </div>
                      ) : null}

                      <div className='flex items-center justify-between'>
                        <span className='text-text-muted'>关联证据</span>
                        <span className='inline-flex items-center gap-1 text-text-primary font-medium'>
                          <FileCheck2 className='size-3 text-status-success-foreground' />
                          {objectDetail.sourceContext.evidenceCount} 份执行证据
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className='text-caption text-text-muted py-1'>
                      暂无直接执行溯源上下文（可能来自直接探索或外部同步）。
                    </p>
                  )}
                </div>

                {/* 实现定位特征 (Implementations) */}
                {objectDetail.implementations?.length ? (
                  <div className='rounded-lg border border-border-card bg-surface p-3 space-y-2'>
                    <div className='flex items-center gap-1.5 text-caption font-semibold text-text-primary'>
                      <Layers className='size-3.5 text-text-muted' />
                      <span>技术实现与定位器 ({objectDetail.implementations.length})</span>
                    </div>
                    <div className='space-y-2'>
                      {objectDetail.implementations.map((impl) => (
                        <div
                          key={impl.implementationKey}
                          className='rounded bg-surface-subtle p-2 text-caption space-y-1'
                        >
                          <div className='flex items-center justify-between'>
                            <span className='font-mono text-text-primary truncate max-w-[200px]'>
                              {impl.semanticName || impl.implementationKey}
                            </span>
                            <span className='text-caption text-text-muted'>v{impl.descriptorVersion ?? 1}</span>
                          </div>
                          {impl.role ? (
                            <div className='text-text-muted text-caption'>角色：{impl.role}</div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <p className='text-body text-text-muted'>未找到对象详情</p>
            )}
          </div>
        ) : (
          /* ── 岛屿包含的知识对象地标列表 ── */
          <div className='space-y-3'>
            {/* 搜索过滤框 */}
            <input
              type='search'
              placeholder='在当前海岛搜索对象…'
              value={objectFilter}
              onChange={(e) => setObjectFilter(e.target.value)}
              className='w-full rounded-md border border-border-card bg-surface px-3 py-1.5 text-caption text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-border-focus'
            />

            {objectsQuery.isLoading ? (
              <div className='space-y-2'>
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className='h-12 w-full' />
                ))}
              </div>
            ) : filteredObjects.length === 0 ? (
              <p className='py-6 text-center text-caption text-text-muted'>
                {rawObjects.length === 0 ? '该海岛暂未发现知识对象' : '无匹配对象'}
              </p>
            ) : (
              <div className='space-y-1.5'>
                {filteredObjects.map((obj: MapAssetListItem) => (
                  <button
                    key={obj.assetRefKey}
                    type='button'
                    className='archipelago-drawer__object-item group flex w-full items-center justify-between rounded-lg border border-border-card bg-surface p-2.5 text-left transition-colors hover:bg-surface-hover focus:outline-none focus:ring-1 focus:ring-border-focus'
                    onClick={() => onSelectObject(obj.assetRef.objectId ?? undefined)}
                  >
                    <div className='min-w-0 flex-1 pr-2'>
                      <div className='truncate text-body font-medium text-text-primary group-hover:text-link'>
                        {obj.name || obj.assetRef.objectId || obj.assetRefKey}
                      </div>
                      <div className='flex items-center gap-2 mt-0.5'>
                        <span className='text-caption text-text-muted font-mono truncate max-w-[160px]'>
                          {obj.assetRef.objectId ?? obj.assetRefKey}
                        </span>
                      </div>
                    </div>
                    <div className='flex items-center gap-2 shrink-0'>
                      <StatusBadge
                        tone={
                          obj.lifecycle === 'TRUSTED'
                            ? 'success'
                            : obj.lifecycle === 'DEGRADED'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {MAP_LIFECYCLE_LABELS[obj.lifecycle] ?? obj.lifecycle}
                      </StatusBadge>
                      <ChevronRight className='size-4 text-text-muted group-hover:text-text-primary' />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </aside>
  )
}
