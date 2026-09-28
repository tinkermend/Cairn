import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  ExternalLink,
  Layers,
  RefreshCw,
  Search,
  Wrench,
  VolumeX,
  XCircle,
} from 'lucide-react'
import {
  dismissIncident,
  fetchAssetReliability,
  fetchIncidents,
  silenceIncident,
} from '@/lib/reliability-api'
import { fetchTargets } from '@/lib/targets-api'
import { CursorPagination } from '@/components/data-table'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { CollectionSummary } from '@/components/collection-summary'
import { EmptyState } from '@/components/empty-state'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { toast } from 'sonner'
import { ASSET_RELIABILITY_STATUSES, type IncidentSeverity, type IncidentStatus } from '@cairn/shared'

const SEVERITY_VARIANTS: Record<IncidentSeverity, 'destructive' | 'outline' | 'secondary' | 'default'> = {
  P1: 'destructive',
  P2: 'destructive',
  P3: 'outline',
  P4: 'secondary',
}


const MAINTENANCE_VIEWS = ['incidents', 'assets'] as const
export function getIncidentStatusMeta(status: IncidentStatus): { tone: StatusTone; label: string } {
  switch (status) {
    case 'DETECTED':
      return { tone: 'error', label: '已发现' }
    case 'DIAGNOSING':
      return { tone: 'waiting', label: '诊断中' }
    case 'ACTION_REQUIRED':
      return { tone: 'warning', label: '待处置' }
    case 'VERIFYING':
      return { tone: 'waiting', label: '验证中' }
    case 'OBSERVING':
      return { tone: 'info', label: '观察中' }
    case 'RESOLVED':
      return { tone: 'success', label: '已恢复' }
    case 'DISMISSED':
      return { tone: 'neutral', label: '已忽略' }
    default:
      return { tone: 'neutral', label: status }
  }
}

export function MaintenancePage() {
  const search = useSearch({ from: '/_authenticated/maintenance/' }) as {
    view?: 'incidents' | 'assets'
    targetId?: string
    status?: string
    severity?: string
    search?: string
  }
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const currentView = search.view ?? 'incidents'
  const targetIdFilter = search.targetId ?? 'all'
  const statusFilter = search.status ?? 'all'
  // 状态筛选在两个视图间共用；资产视图只认资产可靠性状态，其余取值不下发。
  const assetStatus = ASSET_RELIABILITY_STATUSES.find((status) => status === statusFilter)
  const severityFilter = search.severity ?? 'all'
  const searchTerm = search.search ?? ''

  const [triageAction, setTriageAction] = useState<{
    incidentId: string
    type: 'dismiss' | 'silence'
    title: string
  } | null>(null)
  const [triageReason, setTriageReason] = useState('')
  const [silenceDuration, setSilenceDuration] = useState('24')
  const [triageSubmitting, setTriageSubmitting] = useState(false)

  const incidentsPage = useCursorPage(10, 'cairn.maintenance.incidents')
  const assetsPage = useCursorPage(10, 'cairn.maintenance.assets')

  // Fetch targets for filter
  const targetsQuery = useQuery({
    queryKey: ['targets', { limit: 100 }],
    queryFn: () => fetchTargets({ limit: 100 }),
  })

  // Fetch incidents list
  const incidentsQuery = useQuery({
    queryKey: [
      'reliability-incidents',
      {
        targetId: targetIdFilter !== 'all' ? targetIdFilter : undefined,
        status: statusFilter !== 'all' ? (statusFilter as IncidentStatus) : undefined,
        severity: severityFilter !== 'all' ? (severityFilter as IncidentSeverity) : undefined,
        search: searchTerm || undefined,
        cursor: incidentsPage.cursor,
        limit: incidentsPage.pageSize,
      },
    ],
    queryFn: () =>
      fetchIncidents({
        targetId: targetIdFilter !== 'all' ? targetIdFilter : undefined,
        status: statusFilter !== 'all' ? (statusFilter as IncidentStatus) : undefined,
        severity: severityFilter !== 'all' ? (severityFilter as IncidentSeverity) : undefined,
        search: searchTerm || undefined,
        cursor: incidentsPage.cursor,
        limit: incidentsPage.pageSize,
      }),
  })

  // Fetch assets list
  const assetsQuery = useQuery({
    queryKey: [
      'reliability-assets',
      {
        targetId: targetIdFilter !== 'all' ? targetIdFilter : undefined,
        status: assetStatus,
        search: searchTerm || undefined,
        cursor: assetsPage.cursor,
        limit: assetsPage.pageSize,
      },
    ],
    queryFn: () =>
      fetchAssetReliability({
        targetId: targetIdFilter !== 'all' ? targetIdFilter : undefined,
        status: assetStatus,
        search: searchTerm || undefined,
        cursor: assetsPage.cursor,
        limit: assetsPage.pageSize,
      }),
  })

  const handleTriageSubmit = async () => {
    if (!triageAction) return
    setTriageSubmitting(true)
    try {
      if (triageAction.type === 'dismiss') {
        await dismissIncident(triageAction.incidentId, triageReason || '已排除')
        toast.success('事件已排除')
      } else {
        await silenceIncident(triageAction.incidentId, Number(silenceDuration), triageReason || '静默观察')
        toast.success(`事件已静默 ${silenceDuration} 小时`)
      }
      setTriageAction(null)
      setTriageReason('')
      queryClient.invalidateQueries({ queryKey: ['reliability-incidents'] })
      queryClient.invalidateQueries({ queryKey: ['reliability-assets'] })
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '操作失败')
    } finally {
      setTriageSubmitting(false)
    }
  }

  const handleViewChange = (value: string) => {
    const newView = MAINTENANCE_VIEWS.find((view) => view === value)
    if (!newView) return
    navigate({
      from: '/maintenance/',
      to: '/maintenance',
      search: (prev) => ({ ...prev, view: newView }),
    })
  }

  const updateSearch = (updates: Record<string, string | undefined>) => {
    incidentsPage.reset()
    assetsPage.reset()
    navigate({
      from: '/maintenance/',
      to: '/maintenance',
      search: (prev) => ({
        ...prev,
        ...updates,
      }),
    })
  }

  // Summary counts
  const incidents = incidentsQuery.data?.items ?? []
  const assets = assetsQuery.data?.items ?? []
  const totalIncidents = incidentsQuery.data?.total ?? incidents.length
  const totalAssets = assetsQuery.data?.total ?? assets.length

  const activeIncidentsCount = useMemo(
    () => (statusFilter === 'all' ? totalIncidents : incidents.filter((i) => i.status !== 'RESOLVED' && i.status !== 'DISMISSED').length),
    [totalIncidents, incidents, statusFilter],
  )
  const degradedAssetsCount = useMemo(
    () => assets.filter((a) => a.status === 'degraded').length,
    [assets],
  )
  const totalSamples = useMemo(
    () => assets.reduce((sum, a) => sum + (a.sampleCount || 0), 0),
    [assets],
  )

  const summaryItems = useMemo(
    () => [
      {
        label: '待处理问题',
        value: activeIncidentsCount,
        description: '需关注的活跃异常与定位退化事件',
        icon: <AlertTriangle className="size-4 text-warning" />,
      },
      {
        label: '退化资产数',
        value: degradedAssetsCount,
        description: '存在活跃事件或成功率低于85%的场景/模块',
        icon: <Wrench className="size-4 text-warning" />,
      },
      {
        label: '总监测资产',
        value: totalAssets,
        description: '已纳管的场景与动作库资产总数',
        icon: <Boxes className="size-4 text-primary" />,
      },
      {
        label: '评估样本总量',
        value: totalSamples,
        description: '近期用于特征窗口计算的有效执行样本数',
        icon: <Layers className="size-4 text-primary" />,
      },
    ],
    [activeIncidentsCount, degradedAssetsCount, totalAssets, totalSamples],
  )

  return (
    <>
      <PageHeader
        title="自动化维护"
        description="监测运行退化、同源故障归并与受控修复编排，保障无人值守可信度"
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              incidentsQuery.refetch()
              assetsQuery.refetch()
            }}
            disabled={incidentsQuery.isFetching || assetsQuery.isFetching}
          >
            <RefreshCw
              className={`mr-2 size-4 ${incidentsQuery.isFetching || assetsQuery.isFetching ? 'animate-spin' : ''}`}
            />
            刷新
          </Button>
        }
      />

      <Main className="space-y-6">
        <CollectionSummary items={summaryItems} />

        <Tabs value={currentView} onValueChange={handleViewChange} className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-3">
            <TabsList>
              <TabsTrigger value="incidents">
                待处理问题 ({incidents.length})
              </TabsTrigger>
              <TabsTrigger value="assets">
                资产状态 ({assets.length})
              </TabsTrigger>
            </TabsList>

            {/* Filter Bar */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-48">
                <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                <Input
                  placeholder="搜索问题或资产..."
                  value={searchTerm}
                  onChange={(e) => updateSearch({ search: e.target.value || undefined })}
                  className="pl-8 h-9 text-body"
                />
              </div>

              <Select
                value={targetIdFilter}
                onValueChange={(val) => updateSearch({ targetId: val === 'all' ? undefined : val })}
              >
                <SelectTrigger className="h-9 w-36 text-body">
                  <SelectValue placeholder="目标系统" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部目标</SelectItem>
                  {targetsQuery.data?.items?.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {currentView === 'incidents' ? (
                <>
                  <Select
                    value={statusFilter}
                    onValueChange={(val) => updateSearch({ status: val === 'all' ? undefined : val })}
                  >
                    <SelectTrigger className="h-9 w-32 text-body">
                      <SelectValue placeholder="处理状态" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部状态</SelectItem>
                      <SelectItem value="DETECTED">已发现</SelectItem>
                      <SelectItem value="ACTION_REQUIRED">待处理</SelectItem>
                      <SelectItem value="VERIFYING">验证中</SelectItem>
                      <SelectItem value="OBSERVING">观察中</SelectItem>
                      <SelectItem value="RESOLVED">已解决</SelectItem>
                      <SelectItem value="DISMISSED">已排除</SelectItem>
                    </SelectContent>
                  </Select>

                  <Select
                    value={severityFilter}
                    onValueChange={(val) => updateSearch({ severity: val === 'all' ? undefined : val })}
                  >
                    <SelectTrigger className="h-9 w-28 text-body">
                      <SelectValue placeholder="严重程度" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部程度</SelectItem>
                      <SelectItem value="P1">P1 - 致命</SelectItem>
                      <SelectItem value="P2">P2 - 严重</SelectItem>
                      <SelectItem value="P3">P3 - 中等</SelectItem>
                      <SelectItem value="P4">P4 - 提示</SelectItem>
                    </SelectContent>
                  </Select>
                </>
              ) : (
                <Select
                  value={statusFilter}
                  onValueChange={(val) => updateSearch({ status: val === 'all' ? undefined : val })}
                >
                  <SelectTrigger className="h-9 w-32 text-body">
                    <SelectValue placeholder="健康状态" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部状态</SelectItem>
                    <SelectItem value="healthy">正常</SelectItem>
                    <SelectItem value="degraded">退化</SelectItem>
                    <SelectItem value="insufficient_data">数据不足</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {/* Tab 1: Incidents View */}
          <TabsContent value="incidents" className="space-y-4">
            {incidentsQuery.isLoading ? (
              <PageSkeleton />
            ) : incidentsQuery.isError ? (
              <QueryErrorState
                title="加载问题列表失败"
                description={incidentsQuery.error?.message ?? '无法获取可靠性问题列表'}
                onRetry={() => incidentsQuery.refetch()}
              />
            ) : incidents.length === 0 ? (
              <EmptyState
                title="暂无待处理问题"
                description="当前未检测到活跃的定位退化、规则冲突或连续失败事件。"
              />
            ) : (
              <div className="rounded-md border border-border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[300px]">问题与事实摘要</TableHead>
                      <TableHead>严重程度</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>影响范围</TableHead>
                      <TableHead>首次/最近发现</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {incidents.map((incident) => (
                      <TableRow key={incident.id}>
                        <TableCell>
                          <div className="space-y-1">
                            <Link
                              to="/maintenance/incidents/$incidentId"
                              params={{ incidentId: incident.id }}
                              className="font-medium hover:text-primary transition-colors flex items-center gap-1.5"
                            >
                              <span>{incident.title}</span>
                              <ArrowRight className="size-3.5 opacity-60" />
                            </Link>
                            <p className="text-label text-muted-foreground line-clamp-1">{incident.summary}</p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={SEVERITY_VARIANTS[incident.severity] ?? 'outline'}>
                            {incident.severity}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {(() => {
                            const meta = getIncidentStatusMeta(incident.status)
                            return <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                          })()}
                        </TableCell>
                        <TableCell>
                          <div className="text-body font-medium">
                            {incident.memberCount} 次相关运行
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-0.5 text-label text-muted-foreground">
                            <div>近: {new Date(incident.lastSeenAt).toLocaleString('zh-CN')}</div>
                            <div>首: {new Date(incident.firstSeenAt).toLocaleString('zh-CN')}</div>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {incident.status !== 'DISMISSED' && incident.status !== 'RESOLVED' && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 text-label text-muted-foreground hover:text-foreground"
                                  onClick={() =>
                                    setTriageAction({
                                      incidentId: incident.id,
                                      type: 'silence',
                                      title: incident.title,
                                    })
                                  }
                                >
                                  <VolumeX className="mr-1 size-3.5" />
                                  静默
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 text-label text-muted-foreground hover:text-destructive"
                                  onClick={() =>
                                    setTriageAction({
                                      incidentId: incident.id,
                                      type: 'dismiss',
                                      title: incident.title,
                                    })
                                  }
                                >
                                  <XCircle className="mr-1 size-3.5" />
                                  排除
                                </Button>
                              </>
                            )}

                            <Button variant="outline" size="sm" asChild className="h-8 text-label">
                              <Link
                                to="/maintenance/incidents/$incidentId"
                                params={{ incidentId: incident.id }}
                              >
                                详情
                              </Link>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="border-t border-border-divider p-3">
                  <CursorPagination
                    pageIndex={incidentsPage.pageIndex}
                    pageSize={incidentsPage.pageSize}
                    hasPreviousPage={incidentsPage.pageIndex > 0}
                    hasNextPage={!!incidentsQuery.data?.nextCursor}
                    updating={incidentsQuery.isFetching}
                    onPageSizeChange={incidentsPage.setPageSize}
                    onPreviousPage={incidentsPage.goPrev}
                    onNextPage={() => {
                      if (incidentsQuery.data?.nextCursor) incidentsPage.goNext(incidentsQuery.data.nextCursor)
                    }}
                  />
                </div>
              </div>
            )}
          </TabsContent>

          {/* Tab 2: Assets View */}
          <TabsContent value="assets" className="space-y-4">
            {assetsQuery.isLoading ? (
              <PageSkeleton />
            ) : assetsQuery.isError ? (
              <QueryErrorState
                title="加载资产状态失败"
                description={assetsQuery.error?.message ?? '无法获取资产可靠性指标'}
                onRetry={() => assetsQuery.refetch()}
              />
            ) : assets.length === 0 ? (
              <EmptyState
                title="暂无受管资产"
                description="当前未找到符合条件的场景或动作模块。"
              />
            ) : (
              <div className="rounded-md border border-border bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[280px]">资产名称</TableHead>
                      <TableHead>所属目标</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>有效样本</TableHead>
                      <TableHead>平滑成功率</TableHead>
                      <TableHead>P95 耗时</TableHead>
                      <TableHead>活跃问题</TableHead>
                      <TableHead>健康状态</TableHead>
                      <TableHead className="text-right">跳转处理</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {assets.map((asset) => (
                      <TableRow key={asset.assetId}>
                        <TableCell>
                          <span className="font-medium text-body">{asset.assetName}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-body">{asset.targetName}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-label">
                            {asset.assetType === 'scenario' ? '独立场景' : '动作模块'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-body font-medium">{asset.sampleCount} 次</span>
                        </TableCell>
                        <TableCell>
                          {asset.ewmaSuccessRate !== null ? (
                            <div className="flex items-center gap-2">
                              <span
                                className={`text-body font-semibold ${
                                  asset.ewmaSuccessRate >= 0.95
                                    ? 'text-status-success-foreground'
                                    : asset.ewmaSuccessRate >= 0.85
                                      ? 'text-status-warning-foreground'
                                      : 'text-status-error-foreground'
                                }`}
                              >
                                {(asset.ewmaSuccessRate * 100).toFixed(1)}%
                              </span>
                            </div>
                          ) : (
                            <span className="text-label text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-body text-muted-foreground">
                            {asset.p95DurationMs !== null ? `${Math.round(asset.p95DurationMs)}ms` : '—'}
                          </span>
                        </TableCell>
                        <TableCell>
                          {asset.activeIncidentsCount > 0 ? (
                            <Badge variant="destructive" className="text-label">
                              {asset.activeIncidentsCount} 个问题
                              {asset.highestSeverity && ` (${asset.highestSeverity})`}
                            </Badge>
                          ) : (
                            <span className="text-label text-muted-foreground">无</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {asset.status === 'healthy' && (
                            <Badge variant="outline" className="text-status-success-foreground border-status-success-accent/30">
                              正常
                            </Badge>
                          )}
                          {asset.status === 'degraded' && (
                            <Badge variant="destructive">退化</Badge>
                          )}
                          {asset.status === 'insufficient_data' && (
                            <Badge variant="secondary">数据不足</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" asChild className="h-8 text-label">
                            {asset.assetType === 'scenario' ? (
                              <Link to="/scenarios/$scenarioId" params={{ scenarioId: asset.assetId }}>
                                <ExternalLink className="mr-1 size-3.5" />
                                编辑器
                              </Link>
                            ) : (
                              <Link to="/action-modules/$moduleId" params={{ moduleId: asset.assetId }}>
                                <ExternalLink className="mr-1 size-3.5" />
                                编辑器
                              </Link>
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <div className="border-t border-border-divider p-3">
                  <CursorPagination
                    pageIndex={assetsPage.pageIndex}
                    pageSize={assetsPage.pageSize}
                    hasPreviousPage={assetsPage.pageIndex > 0}
                    hasNextPage={!!assetsQuery.data?.nextCursor}
                    updating={assetsQuery.isFetching}
                    onPageSizeChange={assetsPage.setPageSize}
                    onPreviousPage={assetsPage.goPrev}
                    onNextPage={() => {
                      if (assetsQuery.data?.nextCursor) assetsPage.goNext(assetsQuery.data.nextCursor)
                    }}
                  />
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </Main>

      {/* Triage Modal */}
      <Dialog open={!!triageAction} onOpenChange={(open) => !open && setTriageAction(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {triageAction?.type === 'dismiss' ? '排除该可靠性事件' : '静默该事件告警'}
            </DialogTitle>
            <DialogDescription className="truncate">
              目标事件：{triageAction?.title}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {triageAction?.type === 'silence' && (
              <div className="space-y-2">
                <Label htmlFor="silence-hours">静默时长（小时）</Label>
                <Select value={silenceDuration} onValueChange={setSilenceDuration}>
                  <SelectTrigger id="silence-hours">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="4">4 小时（短时维护）</SelectItem>
                    <SelectItem value="24">24 小时（1天）</SelectItem>
                    <SelectItem value="72">72 小时（3天）</SelectItem>
                    <SelectItem value="168">168 小时（7天）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="triage-reason">
                {triageAction?.type === 'dismiss' ? '排除理由（说明原因）' : '静默理由'}
              </Label>
              <Input
                id="triage-reason"
                placeholder="例如：系统已知大促改版中、排期在周五版本统一修复"
                value={triageReason}
                onChange={(e) => setTriageReason(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTriageAction(null)} disabled={triageSubmitting}>
              取消
            </Button>
            <Button
              variant={triageAction?.type === 'dismiss' ? 'destructive' : 'default'}
              onClick={handleTriageSubmit}
              disabled={triageSubmitting}
            >
              {triageSubmitting ? '处理中...' : '确认执行'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
