import { useMemo, useState } from 'react'
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useReactTable, getCoreRowModel } from '@tanstack/react-table'
import type { ActionModuleSummary } from '@cairn/shared'
import { Clock, Plus, Search, Sparkles, Tag, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteActionModule,
  fetchActionModules,
} from '@/lib/action-modules-api'
import { fetchTargets } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
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
import { DataTablePagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { ActionModuleCreateDialog } from './create-dialog'
import {
  MODULE_EFFECT_CEILING_LABELS,
  MODULE_EXECUTION_MODE_LABELS,
  MODULE_EXECUTION_MODE_VARIANTS,
  MODULE_PUBLICATION_STATUS_LABELS,
} from './labels'
import { ModuleHealthBadge } from './health-badge'

export function ActionModulesPage() {
  const queryClient = useQueryClient()
  const canReadTargets = useCan('target:read')
  const canWrite = useCan('module:write')
  const navigate = useNavigate()

  const [targetId, setTargetId] = useState<string>('all')
  const [search, setSearch] = useState<string>('')
  const [executionMode, setExecutionMode] = useState<string>('all')
  const [capabilityKey, setCapabilityKey] = useState('')
  const [tag, setTag] = useState('')
  const [publication, setPublication] = useState('all')
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 })
  const page = pagination.pageIndex + 1
  const setPage = (next: number) =>
    setPagination((old) => ({ ...old, pageIndex: next - 1 }))
  const [createOpen, setCreateOpen] = useState(false)
  const [moduleToDelete, setModuleToDelete] =
    useState<ActionModuleSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const targets = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
    enabled: canReadTargets,
  })

  const targetMap = useMemo(() => {
    return new Map(targets.data?.items.map((t) => [t.id, t.name]))
  }, [targets.data?.items])

  const queryParam = useMemo(() => {
    return {
      targetId: targetId === 'all' ? undefined : targetId,
      q: search.trim() || undefined,
      executionMode:
        executionMode === 'all'
          ? undefined
          : (executionMode as 'DETERMINISTIC' | 'AI' | 'HYBRID'),
      capabilityKey: capabilityKey.trim() || undefined,
      tag: tag.trim() || undefined,
      publication:
        publication === 'all'
          ? undefined
          : (publication as 'published' | 'deprecated' | 'withdrawn'),
      page,
      pageSize: pagination.pageSize,
    }
  }, [
    targetId,
    search,
    executionMode,
    capabilityKey,
    tag,
    publication,
    page,
    pagination.pageSize,
  ])

  const modulesQuery = useQuery({
    queryKey: ['action-modules', queryParam],
    queryFn: () => fetchActionModules(queryParam),
    placeholderData: keepPreviousData,
  })

  const items = modulesQuery.data?.items ?? []
  const total = modulesQuery.data?.total ?? 0
  const table = useReactTable({
    data: items,
    columns: [],
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    autoResetPageIndex: false,
    pageCount: Math.max(1, Math.ceil(total / pagination.pageSize)),
    state: { pagination },
    onPaginationChange: setPagination,
  })

  const handleDelete = async () => {
    if (!moduleToDelete) return
    setDeleting(true)
    try {
      await deleteActionModule(moduleToDelete.id)
      toast.success('动作模块已删除')
      await queryClient.invalidateQueries({ queryKey: ['action-modules'] })
      setModuleToDelete(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <AppHeader />
      <Main>
        <PageHeader
          title='动作库'
          description='管理业务系统下的标准化动作模块，提供强类型输入输出契约、确定性与 AI 步骤混编及多版本发布能力。'
          actions={
            <>
              <Can permission='module:write'>
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className='mr-2 h-4 w-4' />
                  新建动作模块
                </Button>
              </Can>
            </>
          }
        />

        {/* 筛选工具栏 */}
        <div className='mb-4 flex flex-wrap items-center gap-3'>
          <div className='relative max-w-sm min-w-[200px] flex-1'>
            <Search className='absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground' />
            <Input
              aria-label='搜索模块'
              placeholder='按名称、key 或别名搜索...'
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
              }}
              className='pl-8'
            />
          </div>

          <Select
            value={targetId}
            onValueChange={(value) => {
              setTargetId(value)
              setPage(1)
            }}
          >
            <SelectTrigger className='w-[180px]'>
              <SelectValue placeholder='目标系统' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>所有目标系统</SelectItem>
              {targets.data?.items.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={executionMode}
            onValueChange={(value) => {
              setExecutionMode(value)
              setPage(1)
            }}
          >
            <SelectTrigger className='w-[140px]'>
              <SelectValue placeholder='执行方式' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>所有方式</SelectItem>
              <SelectItem value='DETERMINISTIC'>确定性</SelectItem>
              <SelectItem value='AI'>AI</SelectItem>
              <SelectItem value='HYBRID'>混编</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className='mb-4 flex flex-wrap gap-3'>
          <Input
            className='w-48'
            aria-label='筛选能力键'
            placeholder='能力键'
            value={capabilityKey}
            onChange={(e) => {
              setCapabilityKey(e.target.value)
              setPage(1)
            }}
          />
          <Input
            className='w-48'
            aria-label='筛选标签'
            placeholder='标签'
            value={tag}
            onChange={(e) => {
              setTag(e.target.value)
              setPage(1)
            }}
          />
          <select
            className='h-9 rounded-md border bg-background px-2 text-body'
            aria-label='发布状态'
            value={publication}
            onChange={(e) => {
              setPublication(e.target.value)
              setPage(1)
            }}
          >
            <option value='all'>所有发布状态</option>
            <option value='published'>已发布</option>
            <option value='deprecated'>已弃用</option>
            <option value='withdrawn'>已撤回</option>
          </select>
        </div>
        {/* 列表主体 */}
        {modulesQuery.isLoading ? (
          <PageSkeleton />
        ) : modulesQuery.isError ? (
          <QueryErrorState
            onRetry={() => {
              void modulesQuery.refetch()
            }}
          />
        ) : items.length === 0 ? (
          <EmptyState
            title='暂无动作模块'
            description={
              search || targetId !== 'all' || executionMode !== 'all'
                ? '未找到匹配的动作模块，请调整筛选条件。'
                : '动作模块可将高频业务交互封装为可复用的能力单元。'
            }
            action={
              canWrite ? (
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus className='mr-2 h-4 w-4' />
                  新建动作模块
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className='rounded-md border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>模块名称 / Key</TableHead>
                  <TableHead>目标系统</TableHead>
                  <TableHead>执行方式</TableHead>
                  <TableHead>副作用上限</TableHead>
                  <TableHead>版本状态</TableHead>
                  <TableHead>健康</TableHead>
                  <TableHead>发布时间</TableHead>
                  <TableHead className='w-[80px]'>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((mod) => (
                  <TableRow
                    key={mod.id}
                    className='cursor-pointer hover:bg-muted/50'
                    onClick={() =>
                      navigate({
                        to: '/action-modules/$moduleId',
                        params: { moduleId: mod.id },
                      })
                    }
                  >
                    <TableCell>
                      <Button
                        variant='link'
                        className='h-auto justify-start p-0 text-body'
                        onClick={(e) => {
                          e.stopPropagation()
                          void navigate({
                            to: '/action-modules/$moduleId',
                            params: { moduleId: mod.id },
                          })
                        }}
                      >
                        {mod.name}
                      </Button>
                      <div className='text-bodyall font-mono text-muted-foreground'>
                        {mod.key}
                      </div>
                      {mod.capabilityKey && (
                        <div className='text-bodyall mt-1 flex items-center gap-1 text-muted-foreground'>
                          <Tag className='h-3 w-3' />
                          <span>{mod.capabilityKey}</span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className='text-body text-muted-foreground'>
                        {targetMap.get(mod.targetId) ??
                          mod.targetId.slice(0, 8)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {mod.executionMode ? (
                        <Badge
                          variant={
                            MODULE_EXECUTION_MODE_VARIANTS[mod.executionMode]
                          }
                        >
                          {mod.executionMode === 'AI' && (
                            <Sparkles className='mr-1 h-3 w-3' />
                          )}
                          {MODULE_EXECUTION_MODE_LABELS[mod.executionMode]}
                        </Badge>
                      ) : (
                        <span className='text-bodyall text-muted-foreground'>
                          未发布
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {mod.effectCeiling ? (
                        <Badge variant='outline'>
                          {MODULE_EFFECT_CEILING_LABELS[mod.effectCeiling]}
                        </Badge>
                      ) : (
                        <span className='text-bodyall text-muted-foreground'>
                          -
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {mod.latestVersionNo ? (
                        <div className='flex items-center gap-1.5'>
                          <Badge variant='secondary'>
                            v{mod.latestVersionNo}
                          </Badge>
                          {mod.publicationStatus && (
                            <span className='text-bodyall text-muted-foreground'>
                              {
                                MODULE_PUBLICATION_STATUS_LABELS[
                                  mod.publicationStatus
                                ]
                              }
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className='text-bodyall text-muted-foreground'>
                          草稿中
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {mod.health ? (
                        <ModuleHealthBadge health={mod.health} />
                      ) : (
                        <span className='text-bodyall text-muted-foreground'>样本不足</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className='text-bodyall flex items-center gap-1 text-muted-foreground'>
                        <Clock className='h-3 w-3' />
                        <span>
                          {mod.latestVersionPublishedAt
                            ? new Date(
                                mod.latestVersionPublishedAt
                              ).toLocaleString()
                            : '未发布'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {!mod.latestVersionNo && canWrite && (
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-8 w-8 text-destructive hover:bg-destructive/10'
                          onClick={() => setModuleToDelete(mod)}
                          title='删除未发布的模块'
                        >
                          <Trash2 className='h-4 w-4' />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className='@container/content my-4 space-y-3 text-body'>
          <p>共 {total} 个模块</p>
          <DataTablePagination table={table} />
        </div>
        <ActionModuleCreateDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={(id) =>
            navigate({
              to: '/action-modules/$moduleId',
              params: { moduleId: id },
            })
          }
          defaultTargetId={targetId !== 'all' ? targetId : undefined}
        />

        <AlertDialog
          open={Boolean(moduleToDelete)}
          onOpenChange={(open) => !open && !deleting && setModuleToDelete(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>确认删除动作模块？</AlertDialogTitle>
              <AlertDialogDescription>
                将删除未发布的动作模块「{moduleToDelete?.name}」（
                {moduleToDelete?.key}）。此操作不可撤销。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault()
                  void handleDelete()
                }}
                disabled={deleting}
                className='text-destructive-foreground bg-destructive hover:bg-destructive/90'
              >
                {deleting ? '删除中...' : '删除'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Main>
    </>
  )
}
