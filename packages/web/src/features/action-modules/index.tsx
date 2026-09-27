import { useMemo, useState } from 'react'
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useReactTable, getCoreRowModel } from '@tanstack/react-table'
import type { ActionModuleSummary } from '@cairn/shared'
import {
  CheckCircle2,
  Clock,
  Filter,
  Globe2,
  Link2,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Tag,
  Trash2,
  Workflow,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CollectionSummary } from '@/components/collection-summary'
import { DataTablePagination } from '@/components/data-table'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { Can } from '@/components/rbac/can'
import { ActionModuleCreateDialog } from './create-dialog'
import { ModuleHealthBadge } from './health-badge'
import {
  MODULE_EFFECT_CEILING_LABELS,
  MODULE_EXECUTION_MODE_LABELS,
  MODULE_EXECUTION_MODE_VARIANTS,
  MODULE_PUBLICATION_STATUS_LABELS,
} from './labels'
import { ActionModuleReferencesPanel } from './references-panel'

function formatPublishedAt(dateStr: string) {
  try {
    const d = new Date(dateStr)
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d)
  } catch {
    return dateStr
  }
}

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
  const [referencingModule, setReferencingModule] =
    useState<ActionModuleSummary | null>(null)

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

  const hasActiveFilters = Boolean(
    search.trim() ||
      targetId !== 'all' ||
      executionMode !== 'all' ||
      capabilityKey.trim() ||
      tag.trim() ||
      publication !== 'all'
  )

  const handleResetFilters = () => {
    setSearch('')
    setTargetId('all')
    setExecutionMode('all')
    setCapabilityKey('')
    setTag('')
    setPublication('all')
    setPage(1)
  }

  return (
    <>
      <Main className='flex min-w-0 flex-1 flex-col gap-6'>
        <PageHeader
          title='动作库'
          description='管理业务系统下的标准化动作模块，提供强类型输入输出契约、确定性与 AI 步骤混编及多版本发布能力。'
          actions={
            <Can permission='module:write'>
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className='mr-2 h-4 w-4' />
                新建动作模块
              </Button>
            </Can>
          }
        />

        {/* 顶部冰川蓝指标卡 */}
        <CollectionSummary
          items={[
            {
              label: '本页模块',
              value: items.length,
              description: `共登记 ${total} 个动作模块`,
              icon: <Workflow className='size-4' />,
              onClick: handleResetFilters,
              pressed: !hasActiveFilters,
            },
            {
              label: '已发布',
              value: items.filter((mod) => Boolean(mod.latestVersionNo)).length,
              description:
                total > items.length ? '当前页中就绪发布的模块' : '就绪发布的模块',
              icon: (
                <CheckCircle2 className='size-4 text-status-success-foreground' />
              ),
              onClick: () => {
                setPublication(publication === 'published' ? 'all' : 'published')
                setPage(1)
              },
              pressed: publication === 'published',
            },
            {
              label: '覆盖系统',
              value: new Set(items.map((mod) => mod.targetId)).size,
              description: '当前页模块关联的业务系统数',
              icon: <Globe2 className='size-4' />,
            },
            {
              label: 'AI / 混编',
              value: items.filter(
                (mod) =>
                  mod.executionMode === 'AI' || mod.executionMode === 'HYBRID'
              ).length,
              description: '包含 AI 交互与自适应能力的模块',
              icon: <Sparkles className='size-4 text-status-info-foreground' />,
              onClick: () => {
                setExecutionMode(executionMode === 'HYBRID' ? 'all' : 'HYBRID')
                setPage(1)
              },
              pressed: executionMode === 'HYBRID',
            },
          ]}
        />

        {modulesQuery.isLoading ? (
          <PageSkeleton />
        ) : modulesQuery.isError ? (
          <QueryErrorState
            onRetry={() => {
              void modulesQuery.refetch()
            }}
          />
        ) : (
          <section
            aria-label='动作模块列表'
            className='min-w-0 overflow-hidden rounded-xl border border-border-card bg-card shadow-card'
          >
            {/* 表头工具栏：状态胶囊 + 搜索 */}
            <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-divider p-3.5'>
              <div
                className='flex flex-wrap items-center gap-1.5'
                aria-label='模块筛选'
              >
                {(
                  [
                    ['all', '全部状态'],
                    ['published', '已发布'],
                    ['deprecated', '已弃用'],
                    ['withdrawn', '已撤回'],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    variant={publication === value ? 'secondary' : 'ghost'}
                    size='sm'
                    className='h-8 text-label'
                    aria-pressed={publication === value}
                    onClick={() => {
                      setPublication(value)
                      setPage(1)
                    }}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              <div className='relative w-full sm:w-72'>
                <Search className='pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground' />
                <Input
                  aria-label='搜索模块'
                  placeholder='按名称、key 或别名搜索...'
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setPage(1)
                  }}
                  className='h-8 pl-8 text-small'
                />
                {search && (
                  <Button
                    variant='ghost'
                    size='icon'
                    className='absolute top-1 right-1 h-6 w-6 text-muted-foreground hover:text-foreground'
                    onClick={() => {
                      setSearch('')
                      setPage(1)
                    }}
                  >
                    <X className='size-3' />
                  </Button>
                )}
              </div>
            </div>

            {/* 次级属性与范围筛选条：系统、模式、能力键、标签 */}
            <div className='flex flex-wrap items-center justify-between gap-2.5 border-b border-border-divider bg-muted/15 px-4 py-2 text-small'>
              <div className='flex flex-wrap items-center gap-2'>
                {canReadTargets &&
                targets.data?.items &&
                targets.data.items.length > 0 ? (
                  <Select
                    value={targetId}
                    onValueChange={(value) => {
                      setTargetId(value)
                      setPage(1)
                    }}
                  >
                    <SelectTrigger
                      className='h-7 w-40 text-label bg-background'
                      aria-label='目标系统筛选'
                    >
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

                <Select
                  value={executionMode}
                  onValueChange={(value) => {
                    setExecutionMode(value)
                    setPage(1)
                  }}
                >
                  <SelectTrigger
                    className='h-7 w-28 text-label bg-background'
                    aria-label='执行方式筛选'
                  >
                    <SelectValue placeholder='执行方式' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>所有方式</SelectItem>
                    <SelectItem value='DETERMINISTIC'>确定性</SelectItem>
                    <SelectItem value='AI'>AI</SelectItem>
                    <SelectItem value='HYBRID'>混编</SelectItem>
                  </SelectContent>
                </Select>

                <div className='h-4 w-px bg-border-divider mx-0.5' />

                <Input
                  className='h-7 w-44 font-mono text-label bg-background'
                  aria-label='筛选能力键'
                  placeholder='能力键 (capabilityKey)'
                  value={capabilityKey}
                  onChange={(e) => {
                    setCapabilityKey(e.target.value)
                    setPage(1)
                  }}
                />
                <Input
                  className='h-7 w-36 text-label bg-background'
                  aria-label='筛选标签'
                  placeholder='标签 (tag)'
                  value={tag}
                  onChange={(e) => {
                    setTag(e.target.value)
                    setPage(1)
                  }}
                />
              </div>

              {hasActiveFilters && (
                <Button
                  variant='ghost'
                  size='sm'
                  className='h-7 gap-1 text-label text-muted-foreground hover:text-foreground'
                  onClick={handleResetFilters}
                >
                  <RotateCcw className='size-3' />
                  重置筛选
                </Button>
              )}
            </div>

            {/* 列表主体 */}
            {items.length === 0 ? (
              <EmptyState
                title='暂无动作模块'
                description={
                  hasActiveFilters
                    ? '未找到匹配的动作模块，请调整筛选条件。'
                    : '动作模块可将高频业务交互封装为可复用的能力单元。'
                }
                action={
                  hasActiveFilters ? (
                    <Button variant='outline' onClick={handleResetFilters}>
                      清除筛选
                    </Button>
                  ) : canWrite ? (
                    <Button onClick={() => setCreateOpen(true)}>
                      <Plus className='mr-2 h-4 w-4' />
                      新建动作模块
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className='hover:bg-transparent'>
                    <TableHead className='min-w-[260px]'>模块名称 / Key</TableHead>
                    <TableHead className='min-w-[120px]'>目标系统</TableHead>
                    <TableHead className='min-w-[100px]'>执行方式</TableHead>
                    <TableHead className='min-w-[100px]'>副作用上限</TableHead>
                    <TableHead className='min-w-[110px]'>版本状态</TableHead>
                    <TableHead className='min-w-[90px]'>健康</TableHead>
                    <TableHead className='min-w-[140px]'>发布时间</TableHead>
                    <TableHead className='w-[100px] text-right'>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((mod) => (
                    <TableRow
                      key={mod.id}
                      className='group cursor-pointer hover:bg-muted/40 transition-colors'
                      onClick={() =>
                        navigate({
                          to: '/action-modules/$moduleId',
                          params: { moduleId: mod.id },
                        })
                      }
                    >
                      <TableCell>
                        <div className='space-y-1 py-0.5'>
                          <Button
                            variant='link'
                            className='h-auto justify-start p-0 text-left text-body font-medium text-foreground hover:text-primary transition-colors'
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
                          <div className='flex flex-wrap items-center gap-1.5 text-label'>
                            <span className='font-mono text-muted-foreground'>
                              {mod.key}
                            </span>
                            {mod.capabilityKey && (
                              <span className='inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5 font-mono text-muted-foreground'>
                                <Tag className='size-2.5 text-muted-foreground/70' />
                                {mod.capabilityKey}
                              </span>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant='outline'
                          className='font-normal text-muted-foreground bg-muted/20 border-border-divider/80 text-label'
                        >
                          {targetMap.get(mod.targetId) ??
                            mod.targetId.slice(0, 8)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {mod.executionMode ? (
                          <Badge
                            variant={
                              MODULE_EXECUTION_MODE_VARIANTS[mod.executionMode]
                            }
                            className='font-normal'
                          >
                            {mod.executionMode === 'AI' && (
                              <Sparkles className='mr-1 size-3' />
                            )}
                            {mod.executionMode === 'HYBRID' && (
                              <Workflow className='mr-1 size-3' />
                            )}
                            {MODULE_EXECUTION_MODE_LABELS[mod.executionMode]}
                          </Badge>
                        ) : (
                          <span className='text-label text-muted-foreground'>
                            未发布
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {mod.effectCeiling ? (
                          <Badge
                            variant='outline'
                            className={cn(
                              'font-normal',
                              mod.effectCeiling === 'READ_ONLY' &&
                                'border-status-success-accent/40 bg-status-success-background text-status-success-foreground',
                              mod.effectCeiling === 'WITH_SIDE_EFFECTS' &&
                                'border-status-warning-accent/40 bg-status-warning-background text-status-warning-foreground',
                              mod.effectCeiling === 'CRITICAL_MUTATION' &&
                                'border-status-error-accent/40 bg-status-error-background text-status-error-foreground'
                            )}
                          >
                            {MODULE_EFFECT_CEILING_LABELS[mod.effectCeiling]}
                          </Badge>
                        ) : (
                          <span className='text-label text-muted-foreground'>
                            -
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        {mod.latestVersionNo ? (
                          <div className='flex items-center gap-1.5'>
                            <Badge
                              variant='secondary'
                              className='font-mono text-label'
                            >
                              v{mod.latestVersionNo}
                            </Badge>
                            <span className='inline-flex items-center gap-1 text-label text-muted-foreground'>
                              <span className='size-1.5 rounded-full bg-status-success-accent' />
                              {mod.publicationStatus
                                ? MODULE_PUBLICATION_STATUS_LABELS[
                                    mod.publicationStatus
                                  ]
                                : '已发布'}
                            </span>
                          </div>
                        ) : (
                          <Badge
                            variant='outline'
                            className='font-normal border-status-warning-accent/40 bg-status-warning-background text-status-warning-foreground text-label'
                          >
                            草稿中
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {mod.health ? (
                          <ModuleHealthBadge health={mod.health} />
                        ) : (
                          <Badge
                            variant='outline'
                            className='font-normal text-muted-foreground border-dashed text-label'
                          >
                            样本不足
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className='flex items-center gap-1.5 text-label text-muted-foreground'>
                          <Clock className='size-3 shrink-0' />
                          <span>
                            {mod.latestVersionPublishedAt
                              ? formatPublishedAt(
                                  mod.latestVersionPublishedAt
                                )
                              : '未发布'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <div className='flex items-center justify-end gap-1'>
                          <Button
                            variant='ghost'
                            size='icon'
                            className='h-8 w-8 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors'
                            title='测试/演练'
                            aria-label='测试/演练'
                            onClick={() =>
                              navigate({
                                to: '/action-modules/$moduleId',
                                params: { moduleId: mod.id },
                              })
                            }
                          >
                            <Play className='size-3.5 fill-current' />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon'
                            className='h-8 w-8 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors'
                            title='查看调用方（引用）'
                            aria-label='查看调用方（引用）'
                            onClick={() => setReferencingModule(mod)}
                          >
                            <Link2 className='size-3.5' />
                          </Button>
                          {!mod.latestVersionNo && canWrite && (
                            <Button
                              variant='ghost'
                              size='icon'
                              className='h-8 w-8 text-status-error-foreground hover:bg-status-error-background transition-colors'
                              onClick={() => setModuleToDelete(mod)}
                              title='删除未发布的模块'
                              aria-label='删除未发布的模块'
                            >
                              <Trash2 className='size-3.5' />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {/* 卡片底部分页 */}
            <div className='flex flex-wrap items-center justify-between gap-3 border-t border-border-divider px-4 py-3 text-label text-muted-foreground'>
              <p>共 {total} 个动作模块</p>
              <DataTablePagination table={table} />
            </div>
          </section>
        )}

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

        {/* 引用分析侧边抽屉 */}
        <Sheet
          open={Boolean(referencingModule)}
          onOpenChange={(open) => !open && setReferencingModule(null)}
        >
          <SheetContent
            side='right'
            className='w-full sm:max-w-2xl overflow-y-auto'
          >
            <SheetHeader className='border-b border-border-divider pb-4'>
              <SheetTitle className='flex items-center gap-2'>
                <span>模块引用与调用方</span>
                {referencingModule && (
                  <Badge variant='outline'>{referencingModule.name}</Badge>
                )}
              </SheetTitle>
              <SheetDescription>
                查看动作模块「{referencingModule?.name}」在各业务场景中的调用与引用版本。
              </SheetDescription>
            </SheetHeader>
            <div className='py-4'>
              {referencingModule && (
                <ActionModuleReferencesPanel moduleId={referencingModule.id} />
              )}
            </div>
          </SheetContent>
        </Sheet>

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
