import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react'
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
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { QueryErrorState } from '@/components/query-error-state'
import { cn } from '@/lib/utils'

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
  const [open, setOpen] = useState(false)
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

  const currentObject = objectsQuery.data?.items.find(
    (item) => item.assetRefKey === current?.assetRefKey
  )

  return (
    <div className='rounded-lg border border-border-divider/60 bg-muted/20 p-3 space-y-2.5'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-1.5'>
          <Label className='text-xs font-semibold text-muted-foreground uppercase tracking-wider'>地图对象</Label>
          <span className='rounded bg-muted px-1.5 py-0.2 text-[10px] font-medium text-muted-foreground'>选填</span>
        </div>
        <span className='text-label text-muted-foreground'>
          便于查看变更影响
        </span>
      </div>
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
          尚未绑定（可选配置，不影响执行）。相似扫描只给候选，不算确切引用。
        </p>
      )}

      <div className='flex items-center gap-2'>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type='button'
              variant='outline'
              role='combobox'
              aria-expanded={open}
              aria-label='选择地图对象'
              disabled={
                disabled ||
                bindMutation.isPending ||
                unbindMutation.isPending ||
                referencesQuery.isPending ||
                referencesQuery.isError
              }
              className='w-full justify-between font-normal text-left'
            >
              <span className='truncate'>
                {current
                  ? (currentObject?.name ?? current.assetRefKey)
                  : '选择要绑定的对象'}
              </span>
              <ChevronsUpDown className='ml-2 size-4 shrink-0 opacity-50' />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className='w-[var(--radix-popover-trigger-width)] min-w-[320px] p-0'
            align='start'
          >
            <Command shouldFilter={false}>
              <CommandInput
                placeholder='按名称或路径搜索'
                value={search}
                onValueChange={(val) => {
                  setSearch(val)
                  page.reset()
                }}
              />
              <CommandList>
                {objectsQuery.isError ? (
                  <div className='p-3'>
                    <QueryErrorState
                      description={objectsQuery.error?.message}
                      onRetry={() => void objectsQuery.refetch()}
                    />
                  </div>
                ) : objectsQuery.isPending ? (
                  <div className='py-6 text-center text-small text-muted-foreground'>
                    正在加载对象…
                  </div>
                ) : (objectsQuery.data?.items ?? []).length === 0 ? (
                  <CommandEmpty>未找到可绑定的地图对象</CommandEmpty>
                ) : (
                  <CommandGroup>
                    {(objectsQuery.data?.items ?? []).map((item) => {
                      const isSelected =
                        current?.assetRefKey === item.assetRefKey
                      const displayName =
                        item.name ?? item.assetRef.objectId ?? item.assetRefKey
                      const handleSelect = () => {
                        bindMutation.mutate(item.assetRefKey)
                        setOpen(false)
                      }
                      return (
                        <CommandItem
                          key={item.assetRefKey}
                          value={item.assetRefKey}
                          role='option'
                          onSelect={handleSelect}
                          onClick={handleSelect}
                          className='flex items-center justify-between py-2 cursor-pointer'
                        >
                          <div className='flex flex-col truncate pr-2'>
                            <span className='truncate font-medium'>
                              {displayName}
                            </span>
                            {item.name ? (
                              <span className='truncate text-xs text-muted-foreground'>
                                {item.assetRefKey}
                              </span>
                            ) : null}
                          </div>
                          <Check
                            className={cn(
                              'size-4 shrink-0',
                              isSelected ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                )}
              </CommandList>
              <div className='flex items-center justify-between border-t border-border-divider px-3 py-2 text-xs text-muted-foreground bg-muted/20'>
                <span>第 {page.pageIndex + 1} 页</span>
                <div className='flex items-center gap-1'>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    className='h-7 w-7 p-0'
                    disabled={page.pageIndex === 0 || objectsQuery.isFetching}
                    onClick={(e) => {
                      e.preventDefault()
                      page.goPrev()
                    }}
                  >
                    <ChevronLeft className='size-3.5' />
                  </Button>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    className='h-7 w-7 p-0'
                    disabled={
                      !objectsQuery.data?.nextCursor || objectsQuery.isFetching
                    }
                    onClick={(e) => {
                      e.preventDefault()
                      if (objectsQuery.data?.nextCursor) {
                        page.goNext(objectsQuery.data.nextCursor)
                      }
                    }}
                  >
                    <ChevronRight className='size-3.5' />
                  </Button>
                </div>
              </div>
            </Command>
          </PopoverContent>
        </Popover>
        {current?.bindingId ? (
          <Button
            type='button'
            variant='outline'
            disabled={
              disabled || unbindMutation.isPending || bindMutation.isPending
            }
            onClick={() => unbindMutation.mutate()}
            className='shrink-0'
          >
            解除绑定
          </Button>
        ) : null}
      </div>
    </div>
  )
}
