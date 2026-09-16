import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  bindMapScenario,
  fetchMapObjects,
  fetchMapReferences,
  removeMapBinding,
} from '@/lib/map-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CursorPagination } from '@/components/data-table'
import { QueryErrorState } from '@/components/query-error-state'

type MapStepBindingProps = {
  targetId: string
  scenarioId: string
  stepId: string
  draftRevision: number
  disabled?: boolean
}

export function MapStepBinding({
  targetId,
  scenarioId,
  stepId,
  draftRevision,
  disabled,
}: MapStepBindingProps) {
  const queryClient = useQueryClient()
  const canRead = useCan('map:read')
  const canWrite = useCan('workflow:write')
  const canBind = canRead && canWrite
  const [search, setSearch] = useState('')
  const page = useCursorPage()
  const objectsQuery = useQuery({
    queryKey: [
      'map',
      targetId,
      'objects',
      'binding',
      search,
      page.cursor,
      page.pageSize,
    ],
    queryFn: () =>
      fetchMapObjects(targetId, {
        limit: page.pageSize,
        cursor: page.cursor,
        search: search.trim() || undefined,
      }),
    enabled: canBind,
  })
  const referencesQuery = useQuery({
    queryKey: ['map', targetId, 'references', scenarioId, stepId],
    queryFn: () =>
      fetchMapReferences(targetId, {
        limit: 100,
        scenarioId,
        stepId,
        scopeKind: 'draft',
      }),
    enabled: canBind,
  })
  const current = (referencesQuery.data?.items ?? []).find(
    (item) =>
      item.grade === 'confirmed_reference' &&
      item.scope?.kind === 'draft' &&
      item.scenarioId === scenarioId &&
      item.stepId === stepId
  )
  const bindMutation = useMutation({
    mutationFn: (assetRefKey: string) => {
      const item = objectsQuery.data?.items.find(
        (row) => row.assetRefKey === assetRefKey
      )
      if (!item) throw new Error('地图对象不存在')
      return bindMapScenario(targetId, {
        scenarioId,
        stepId,
        assetRef: item.assetRef,
        expectedDraftRevision: draftRevision,
        basis: 'explicit_user',
        scopeKind: 'draft',
      })
    },
    onSuccess: () => {
      toast.success('已绑定地图对象。步骤定义未改动。')
      void queryClient.invalidateQueries({ queryKey: ['map', targetId] })
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '绑定失败'
      ),
  })
  const unbindMutation = useMutation({
    mutationFn: () => {
      if (!current?.bindingId) throw new Error('没有可解除的绑定')
      return removeMapBinding(targetId, current.bindingId, {
        expectedDraftRevision: draftRevision,
      })
    },
    onSuccess: () => {
      toast.success('已解除地图绑定')
      void queryClient.invalidateQueries({ queryKey: ['map', targetId] })
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiRequestError ? error.message : '解除失败'
      ),
  })

  if (!canBind) return null

  return (
    <div className='space-y-2'>
      <Label>地图对象</Label>
      <p className='text-label text-muted-foreground'>
        关联当前步骤与地图对象，便于查看变更影响。
      </p>
      {referencesQuery.isError ? (
        <QueryErrorState
          description={referencesQuery.error?.message}
          onRetry={() => void referencesQuery.refetch()}
        />
      ) : referencesQuery.isPending ? (
        <p className='text-small text-muted-foreground'>正在读取绑定…</p>
      ) : current ? (
        <p className='text-small'>
          当前绑定：{current.assetRefKey}
          {current.resolution === 'pending_confirmation'
            ? ' · 拆分后待确认'
            : ''}
        </p>
      ) : (
        <p className='text-small text-muted-foreground'>
          尚未绑定。相似扫描只给候选，不算确切引用。
        </p>
      )}
      <Input
        aria-label='搜索可绑定对象'
        placeholder='按名称或路径搜索'
        value={search}
        onChange={(event) => {
          setSearch(event.target.value)
          page.reset()
        }}
      />
      {objectsQuery.isError ? (
        <QueryErrorState
          description={objectsQuery.error?.message}
          onRetry={() => void objectsQuery.refetch()}
        />
      ) : null}
      <div className='flex flex-col gap-2 sm:flex-row'>
        <Select
          disabled={
            disabled ||
            bindMutation.isPending ||
            unbindMutation.isPending ||
            objectsQuery.isPending ||
            referencesQuery.isPending ||
            referencesQuery.isError
          }
          onValueChange={(value) => bindMutation.mutate(value)}
        >
          <SelectTrigger className='w-full' aria-label='选择地图对象'>
            <SelectValue placeholder='选择要绑定的对象' />
          </SelectTrigger>
          <SelectContent>
            {(objectsQuery.data?.items ?? []).map((item) => (
              <SelectItem key={item.assetRefKey} value={item.assetRefKey}>
                {item.name ?? item.assetRef.objectId ?? item.assetRefKey}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {current?.bindingId ? (
          <Button
            variant='outline'
            disabled={
              disabled || unbindMutation.isPending || bindMutation.isPending
            }
            onClick={() => unbindMutation.mutate()}
          >
            解除绑定
          </Button>
        ) : null}
      </div>
      <CursorPagination
        pageIndex={page.pageIndex}
        pageSize={page.pageSize}
        hasPreviousPage={page.pageIndex > 0}
        hasNextPage={Boolean(objectsQuery.data?.nextCursor)}
        updating={objectsQuery.isFetching}
        onPageSizeChange={page.setPageSize}
        onPreviousPage={page.goPrev}
        onNextPage={() => {
          if (objectsQuery.data?.nextCursor)
            page.goNext(objectsQuery.data.nextCursor)
        }}
      />
    </div>
  )
}
