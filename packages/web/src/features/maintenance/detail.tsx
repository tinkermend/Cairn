import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Layers,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Split,
  VolumeX,
  Wrench,
  XCircle,
} from 'lucide-react'
import {
  dismissIncident,
  executeBatchUpgrade,
  fetchIncidentDetail,
  fetchIncidentImpact,
  fetchIncidentSignals,
  resolveIncident,
  silenceIncident,
  splitIncident,
} from '@/lib/reliability-api'
import { fetchScenarioRepairCandidates } from '@/lib/repair-api'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge } from '@/components/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { toast } from 'sonner'
import type { IncidentSeverity, MaintenanceUpgradeJobDto } from '@cairn/shared'
import { getIncidentStatusMeta } from './index'

import { useResetOnChange } from '@/hooks/use-reset-on-change'
const SEVERITY_VARIANTS: Record<IncidentSeverity, 'destructive' | 'outline' | 'secondary' | 'default'> = {
  P1: 'destructive',
  P2: 'destructive',
  P3: 'outline',
  P4: 'secondary',
}

function SimplePagination({
  currentPage,
  pageSize,
  totalItems,
  onPageChange,
}: {
  currentPage: number
  pageSize: number
  totalItems: number
  onPageChange: (page: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  if (totalItems <= pageSize) return null
  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-border-divider text-label text-muted-foreground">
      <div>共 {totalItems} 条记录</div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
          className="h-7 text-label"
        >
          上一页
        </Button>
        <span>
          第 {currentPage} / {totalPages} 页
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          className="h-7 text-label"
        >
          下一页
        </Button>
      </div>
    </div>
  )
}


const INCIDENT_TABS = ['overview', 'impact', 'evidence', 'repairs'] as const
export function IncidentDetailPage() {
  const { incidentId } = useParams({ from: '/_authenticated/maintenance/incidents/$incidentId/' })
  const search = useSearch({ from: '/_authenticated/maintenance/incidents/$incidentId/' }) as {
    tab?: 'overview' | 'impact' | 'evidence' | 'repairs'
  }
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const currentTab = search.tab ?? 'overview'

  const [triageAction, setTriageAction] = useState<
    'dismiss' | 'silence' | 'split' | 'resolve' | null
  >(null)
  const [triageReason, setTriageReason] = useState('')
  const [silenceDuration, setSilenceDuration] = useState('24')
  const [splitTitle, setSplitTitle] = useState('')
  const [selectedSplitMembers, setSelectedSplitMembers] = useState<string[]>([])
  const [triageSubmitting, setTriageSubmitting] = useState(false)

  // Incident detail query
  const detailQuery = useQuery({
    queryKey: ['reliability-incident', incidentId],
    queryFn: () => fetchIncidentDetail(incidentId),
  })

  // Incident signals query
  const signalsQuery = useQuery({
    queryKey: ['reliability-incident-signals', incidentId],
    queryFn: () => fetchIncidentSignals(incidentId, { limit: 50 }),
  })

  // Incident impact query
  const impactQuery = useQuery({
    queryKey: ['reliability-incident-impact', incidentId],
    queryFn: () => fetchIncidentImpact(incidentId),
    enabled: currentTab === 'impact',
  })

  // Scenario repair candidates query
  const incidentScenarioId = detailQuery.data?.incident?.lineage?.scenarioId
  const repairCandidatesQuery = useQuery({
    queryKey: ['scenario-repair-candidates', incidentScenarioId],
    queryFn: () => fetchScenarioRepairCandidates(incidentScenarioId!),
    enabled: Boolean(incidentScenarioId) && currentTab === 'repairs',
  })

  // Impact & batch upgrade local state
  const [membersPage, setMembersPage] = useState(1)
  const [assetsPage, setAssetsPage] = useState(1)
  const [selectedScenarioIds, setSelectedScenarioIds] = useState<string[]>([])
  const [batchUpgrading, setBatchUpgrading] = useState(false)
  const [upgradeReceipt, setUpgradeReceipt] = useState<MaintenanceUpgradeJobDto | null>(null)

  // 影响数据到达（或刷新）时默认勾选全部可升级场景
  useResetOnChange(impactQuery.data, (data) => {
    if (!data?.affectedAssets) return
    setSelectedScenarioIds(
      data.affectedAssets.filter((a) => a.upgradeStatus === 'upgradeable').map((a) => a.assetId),
    )
  })

  const toggleSelectScenario = (id: string) => {
    setSelectedScenarioIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    )
  }

  const toggleSelectAllUpgradeable = (upgradeableIds: string[]) => {
    const allSelected =
      upgradeableIds.length > 0 && upgradeableIds.every((id) => selectedScenarioIds.includes(id))
    if (allSelected) {
      setSelectedScenarioIds((prev) => prev.filter((id) => !upgradeableIds.includes(id)))
    } else {
      setSelectedScenarioIds((prev) => Array.from(new Set([...prev, ...upgradeableIds])))
    }
  }

  const handleBatchUpgrade = async (moduleId: string, toVersionId: string) => {
    if (selectedScenarioIds.length === 0) return
    setBatchUpgrading(true)
    try {
      const job = await executeBatchUpgrade(incidentId, {
        moduleId,
        toVersionId,
        scenarioIds: selectedScenarioIds,
        idempotencyKey: `upg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      })
      setUpgradeReceipt(job)
      const successCount = job.results.filter((r) => r.status === 'upgraded').length
      toast.success(`集中升级任务已完成（成功 ${successCount} / ${job.results.length}）`)
      queryClient.invalidateQueries({ queryKey: ['reliability-incident-impact', incidentId] })
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '批量升级执行失败')
    } finally {
      setBatchUpgrading(false)
    }
  }

  const incident = detailQuery.data?.incident
  const members = detailQuery.data?.members ?? []
  const signals = signalsQuery.data?.items ?? []

  const handleTabChange = (value: string) => {
    const newTab = INCIDENT_TABS.find((tab) => tab === value)
    if (!newTab) return
    navigate({
      from: '/maintenance/incidents/$incidentId/',
      to: '/maintenance/incidents/$incidentId',
      params: { incidentId },
      search: (prev) => ({ ...prev, tab: newTab }),
    })
  }

  const handleTriageSubmit = async () => {
    setTriageSubmitting(true)
    try {
      if (triageAction === 'resolve') {
        await resolveIncident(incidentId, triageReason || '已确认修复并完成观察，正式归档')
        toast.success('事件已标记为已解决并归档')
      } else if (triageAction === 'dismiss') {
        await dismissIncident(incidentId, triageReason || '已排除')
        toast.success('事件已排除')
      } else if (triageAction === 'silence') {
        await silenceIncident(incidentId, Number(silenceDuration), triageReason || '静默观察')
        toast.success(`事件已静默 ${silenceDuration} 小时`)
      } else if (triageAction === 'split') {
        if (selectedSplitMembers.length === 0) {
          toast.error('请至少选择一个成员拆分')
          setTriageSubmitting(false)
          return
        }
        await splitIncident(incidentId, selectedSplitMembers, splitTitle || undefined)
        toast.success('事件拆分成功')
      }
      setTriageAction(null)
      setTriageReason('')
      setSplitTitle('')
      setSelectedSplitMembers([])
      queryClient.invalidateQueries({ queryKey: ['reliability-incident', incidentId] })
      queryClient.invalidateQueries({ queryKey: ['reliability-incidents'] })
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : '操作失败')
    } finally {
      setTriageSubmitting(false)
    }
  }

  if (detailQuery.isLoading) {
    return <PageSkeleton />
  }

  if (detailQuery.isError || !incident) {
    return (
      <QueryErrorState
        title="事件详情加载失败"
        description={detailQuery.error?.message ?? '事件不存在或已被清理'}
        onRetry={() => detailQuery.refetch()}
      />
    )
  }

  return (
    <>
      <PageHeader
        parent={
          <div className="flex items-center gap-1.5 text-label text-muted-foreground mb-1">
            <Button variant="ghost" size="icon" asChild className="size-6 mr-1">
              <Link to="/maintenance" search={{ view: 'incidents' }}>
                <ArrowLeft className="size-3.5" />
              </Link>
            </Button>
            <Link to="/maintenance" search={{ view: 'incidents' }} className="hover:underline">
              自动化维护
            </Link>
            <span>/</span>
            <span>事件详情</span>
          </div>
        }
        title={incident.title}
        description={`首次发现: ${new Date(
          incident.firstSeenAt,
        ).toLocaleString('zh-CN')} · 最近更新: ${new Date(
          incident.lastSeenAt,
        ).toLocaleString('zh-CN')}`}
        actions={
          <div className="flex items-center gap-2">
            {incident.status !== 'DISMISSED' && incident.status !== 'RESOLVED' && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTriageAction('resolve')}
                >
                  <CheckCircle2 className="mr-1.5 size-4 text-status-success-foreground" />
                  解决/归档
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTriageAction('silence')}
                >
                  <VolumeX className="mr-1.5 size-4" />
                  静默告警
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTriageAction('dismiss')}
                >
                  <XCircle className="mr-1.5 size-4" />
                  排除事件
                </Button>
                {members.length > 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTriageAction('split')}
                  >
                    <Split className="mr-1.5 size-4" />
                    拆分事件
                  </Button>
                )}
              </>
            )}

            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                detailQuery.refetch()
                signalsQuery.refetch()
              }}
              disabled={detailQuery.isFetching || signalsQuery.isFetching}
            >
              <RefreshCw
                className={`size-4 ${detailQuery.isFetching || signalsQuery.isFetching ? 'animate-spin' : ''}`}
              />
            </Button>
          </div>
        }
      />

      <Main className="space-y-6">
        {/* Status Bar */}
        <div className="flex flex-wrap items-center gap-3 p-4 rounded-lg border border-border bg-card">
          <Badge variant={SEVERITY_VARIANTS[incident.severity] ?? 'outline'} className="text-label">
            严重程度: {incident.severity}
          </Badge>
          <div className="flex items-center gap-1.5">
            <span className="text-label text-muted-foreground">处理状态:</span>
            {(() => {
              const meta = getIncidentStatusMeta(incident.status)
              return <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
            })()}
          </div>
          <div className="text-label text-muted-foreground">
            归并成员: <span className="font-semibold text-foreground">{incident.memberCount}</span> 次运行
          </div>
          <div className="text-label text-muted-foreground">
            修订版本: <span className="font-mono">{incident.revision}</span>
          </div>
          {incident.silencedUntil && (
            <Badge variant="secondary" className="text-label flex items-center gap-1">
              <VolumeX className="size-3" />
              已静默至 {new Date(incident.silencedUntil).toLocaleString('zh-CN')}
            </Badge>
          )}
          {incident.dismissedReason && (
            <div className="text-label text-muted-foreground">
              排除理由: <span className="text-foreground">{incident.dismissedReason}</span>
            </div>
          )}
        </div>

        {/* Tab Navigation */}
        <Tabs value={currentTab} onValueChange={handleTabChange} className="space-y-4">
          <TabsList className="border-b border-border">
            <TabsTrigger value="overview">概览 (Overview)</TabsTrigger>
            <TabsTrigger value="impact">影响范围 (Impact: {members.length})</TabsTrigger>
            <TabsTrigger value="evidence">证据账本 (Evidence: {signals.length})</TabsTrigger>
            <TabsTrigger value="repairs">受控修复 (Repairs)</TabsTrigger>
          </TabsList>

          {/* Tab 1: Overview */}
          <TabsContent value="overview" className="space-y-6">
            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-section flex items-center gap-2">
                    <AlertCircle className="size-4 text-primary" />
                    已确认事实与异常摘要
                  </CardTitle>
                  <CardDescription>Worker 增量评估计算产出的事实基线与规则偏离</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-body">
                  <div>
                    <div className="text-label text-muted-foreground mb-1">事件说明</div>
                    <p className="font-medium text-foreground">{incident.summary}</p>
                  </div>
                  <div className="p-3 bg-muted/40 border border-border/60 rounded-md space-y-2">
                    <div className="flex items-center justify-between text-muted-foreground font-medium text-label">
                      <span>运维排查与技术标识</span>
                      <span className="text-muted-foreground/70">供后台定位使用</span>
                    </div>
                    <div className="space-y-1.5 font-mono">
                      <div className="flex items-center justify-between gap-2 p-1.5 bg-background rounded border border-border/40">
                        <span className="text-muted-foreground text-label shrink-0">归并特征键:</span>
                        <span className="truncate text-foreground select-all text-label" title={incident.groupingKey}>
                          {incident.groupingKey}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            void navigator.clipboard.writeText(incident.groupingKey).then(() => {
                              toast.success('已复制归并特征键')
                            })
                          }}
                          title="复制归并键"
                        >
                          <Copy className="size-3" />
                        </Button>
                      </div>
                      <div className="flex items-center justify-between gap-2 p-1.5 bg-background rounded border border-border/40">
                        <span className="text-muted-foreground text-label shrink-0">范围标识 (Scope):</span>
                        <span className="truncate text-foreground select-all text-label" title={incident.scopeDigest}>
                          {incident.scopeDigest}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            void navigator.clipboard.writeText(incident.scopeDigest).then(() => {
                              toast.success('已复制范围摘要')
                            })
                          }}
                          title="复制范围摘要"
                        >
                          <Copy className="size-3" />
                        </Button>
                      </div>
                      <div className="flex items-center justify-between gap-2 p-1.5 bg-background rounded border border-border/40">
                        <span className="text-muted-foreground text-label shrink-0">事件 ID:</span>
                        <span className="truncate text-foreground select-all text-label" title={incident.id}>
                          {incident.id}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
                          onClick={() => {
                            void navigator.clipboard.writeText(incident.id).then(() => {
                              toast.success('已复制事件 ID')
                            })
                          }}
                          title="复制事件 ID"
                        >
                          <Copy className="size-3" />
                        </Button>
                      </div>
                    </div>
                  </div>

                  {incident.lineage && (
                    <div className="p-3 bg-muted/40 rounded-md space-y-1.5 text-label">
                      <div className="font-semibold text-foreground">关联资产与执行血缘</div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                        <div>目标系统: <span className="text-foreground font-medium">{incident.lineage.targetName || incident.lineage.targetId}</span></div>
                        {incident.lineage.scenarioId && (
                          <div>场景用例: <span className="text-foreground font-medium">{incident.lineage.scenarioName || incident.lineage.scenarioId}</span></div>
                        )}
                        {incident.lineage.stepId && (
                          <div>动作步骤: <span className="text-foreground font-medium">{incident.lineage.stepName || incident.lineage.stepId}</span></div>
                        )}
                      </div>
                    </div>
                  )}
                  {incident.actionRequiredReason && (
                    <div className="p-3 bg-status-warning-background border border-status-warning-accent/20 rounded-md">
                      <div className="text-label font-semibold text-status-warning-foreground mb-1">
                        待处理原因 (Action Required)
                      </div>
                      <p className="text-label text-status-warning-foreground">
                        {incident.actionRequiredReason}
                      </p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-4 pt-2 border-t border-border text-label text-muted-foreground">
                    <div>首次出现: {new Date(incident.firstSeenAt).toLocaleString('zh-CN')}</div>
                    <div>最近更新: {new Date(incident.lastSeenAt).toLocaleString('zh-CN')}</div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-section flex items-center gap-2">
                    <SlidersHorizontal className="size-4 text-primary" />
                    归因假设与证据评分 (Evidence Score)
                  </CardTitle>
                  <CardDescription>多维证据综合打分，区分支持依据与反证因素</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-body">
                  <div>
                    <div className="text-label text-muted-foreground mb-1">可能原因 / 假设</div>
                    <p className="text-foreground">
                      {incident.rootCauseHypothesis || '检测到定位决策持续降级回退或延迟跃升，疑似页面 DOM 属性调整。'}
                    </p>
                  </div>

                  {incident.evidenceScores ? (
                    <>
                      <div className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg">
                        <div className="flex-1 text-center border-r border-border">
                          <div className="text-label text-muted-foreground">支持度得分</div>
                          <div className="text-stat font-bold text-status-success-foreground">
                            {incident.evidenceScores.supportingScore}
                          </div>
                        </div>
                        <div className="flex-1 text-center">
                          <div className="text-label text-muted-foreground">反证度得分</div>
                          <div className="text-stat font-bold text-muted-foreground">
                            {incident.evidenceScores.counterScore}
                          </div>
                        </div>
                      </div>

                      {incident.evidenceScores.supportingFactors && incident.evidenceScores.supportingFactors.length > 0 && (
                        <div>
                          <div className="text-label text-muted-foreground mb-1">支持依据清单</div>
                          <div className="flex flex-wrap gap-1.5">
                            {incident.evidenceScores.supportingFactors.map((f, idx) => (
                              <Badge key={idx} variant="secondary" className="text-label">
                                {f}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {incident.evidenceScores.counterFactors && incident.evidenceScores.counterFactors.length > 0 && (
                        <div>
                          <div className="text-label text-muted-foreground mb-1">反证因素</div>
                          <div className="flex flex-wrap gap-1.5">
                            {incident.evidenceScores.counterFactors.map((f, idx) => (
                              <Badge key={idx} variant="outline" className="text-label">
                                {f}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : null}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Tab 2: Impact */}
          <TabsContent value="impact" className="space-y-4">
            {/* Layer 1: Incident Members & Executions */}
            <Card>
              <CardHeader>
                <CardTitle className="text-section flex items-center gap-2">
                  <Layers className="size-4 text-primary" />
                  关联运行与故障现场 ({members.length})
                </CardTitle>
                <CardDescription>确定性指纹聚类算法合并到本事件的历史执行尝试与运行记录</CardDescription>
              </CardHeader>
              <CardContent>
                {members.length === 0 ? (
                  <div className="text-body text-muted-foreground py-6 text-center">
                    暂无关联子成员记录
                  </div>
                ) : (
                  <div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>成员类型</TableHead>
                          <TableHead>执行引用</TableHead>
                          <TableHead>归入时间</TableHead>
                          <TableHead className="text-right">现场回溯</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {members
                          .slice((membersPage - 1) * 10, membersPage * 10)
                          .map((m) => {
                            const isRun = m.memberType === 'run'
                            const rawRef = m.memberRef ?? m.id ?? ''
                            const rawId = rawRef.includes(':') ? rawRef.split(':')[1] || rawRef : rawRef
                            return (
                              <TableRow key={m.id}>
                                <TableCell>
                                  <Badge variant="outline" className="text-label capitalize">
                                    {isRun ? '运行实例 (Run)' : '执行尝试 (Attempt)'}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-label font-medium text-foreground">
                                      {isRun ? `Run #${rawId.slice(0, 8)}` : `Attempt #${rawId.slice(0, 8)}`}
                                    </span>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="size-5 text-muted-foreground hover:text-foreground"
                                      title={`复制完整标识: ${rawRef}`}
                                      onClick={() => {
                                        navigator.clipboard?.writeText(rawRef)
                                        toast.success('已复制引用标识')
                                      }}
                                    >
                                      <Copy className="size-3" />
                                    </Button>
                                  </div>
                                </TableCell>
                                <TableCell className="text-label text-muted-foreground">
                                  {new Date(m.joinedAt).toLocaleString('zh-CN')}
                                </TableCell>
                                <TableCell className="text-right">
                                  <Button variant="ghost" size="sm" asChild className="h-7 text-label">
                                    <Link
                                      to="/runs"
                                      search={{ search: rawId }}
                                    >
                                      <ExternalLink className="mr-1 size-3" />
                                      定位运行
                                    </Link>
                                  </Button>
                                </TableCell>
                              </TableRow>
                            )
                          })}
                      </TableBody>
                    </Table>
                    <SimplePagination
                      currentPage={membersPage}
                      pageSize={10}
                      totalItems={members.length}
                      onPageChange={setMembersPage}
                    />
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Layer 2: Affected Downstream Assets & Batch Maintenance */}
            <Card>
              <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <CardTitle className="text-section flex items-center gap-2">
                    <Sparkles className="size-4 text-primary" />
                    受影响下游资产与集中维护 (Affected Assets & Batch Maintenance)
                  </CardTitle>
                  <CardDescription>
                    静态依赖分析引擎追溯受故障模块影响的编排场景，支持版本比对与一键集中升级草稿
                  </CardDescription>
                </div>
                {impactQuery.data && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={selectedScenarioIds.length === 0 || batchUpgrading}
                      onClick={() => {
                        const targetAsset = impactQuery.data?.affectedAssets.find(
                          (a) => selectedScenarioIds.includes(a.assetId) && a.moduleId && a.targetVersionId,
                        )
                        if (targetAsset?.moduleId && targetAsset?.targetVersionId) {
                          handleBatchUpgrade(targetAsset.moduleId, targetAsset.targetVersionId)
                        } else {
                          toast.error('未找到有效的模块或升级目标版本')
                        }
                      }}
                      className="text-label"
                    >
                      <Sparkles className="mr-1.5 size-3.5" />
                      {batchUpgrading
                        ? '升级执行中...'
                        : `批量升级选中场景 (${selectedScenarioIds.length})`}
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {impactQuery.isLoading ? (
                  <div className="py-8 text-center text-body text-muted-foreground flex items-center justify-center gap-2">
                    <RefreshCw className="size-4 animate-spin" />
                    正在分析依赖影响与场景版本...
                  </div>
                ) : impactQuery.isError ? (
                  <div className="py-6 text-center text-body text-status-error-foreground">
                    加载影响分析快照失败: {impactQuery.error?.message}
                  </div>
                ) : !impactQuery.data ? null : (
                  <>
                    {/* Summary Chips */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-label px-2.5 py-1">
                        涉及场景: {impactQuery.data.summary.totalScenarios}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="text-label px-2.5 py-1 text-status-success-foreground border-status-success-accent/30 bg-status-success-background"
                      >
                        建议可升级: {impactQuery.data.summary.upgradeableCount}
                      </Badge>
                      <Badge variant="secondary" className="text-label px-2.5 py-1">
                        已是最新: {impactQuery.data.summary.alreadyLatestCount}
                      </Badge>
                      {impactQuery.data.summary.blockedCount > 0 && (
                        <Badge
                          variant="outline"
                          className="text-label px-2.5 py-1 text-status-error-foreground border-status-error-accent/30 bg-status-error-background"
                        >
                          存在阻碍: {impactQuery.data.summary.blockedCount}
                        </Badge>
                      )}
                      {impactQuery.data.summary.gapsCount > 0 && (
                        <Badge
                          variant="outline"
                          className="text-label px-2.5 py-1 text-status-warning-foreground border-status-warning-accent/30 bg-status-warning-background"
                        >
                          历史缺失: {impactQuery.data.summary.gapsCount}
                        </Badge>
                      )}
                    </div>

                    {/* Coverage Gap Warning Callout */}
                    {impactQuery.data.summary.gapsCount > 0 && (
                      <div className="p-3 bg-status-warning-background border border-status-warning-accent/20 rounded-md flex items-start gap-2.5">
                        <ShieldAlert className="size-4 text-status-warning-foreground shrink-0 mt-0.5" />
                        <div className="text-label text-status-warning-foreground space-y-1">
                          <div className="font-semibold">
                            存在历史未结构化场景 (Legacy Manifest Gaps)
                          </div>
                          <p>
                            检测到 {impactQuery.data.summary.gapsCount} 个历史场景缺少模块元数据清单（legacy_missing_manifest）。已自动降级隔离，不可进行自动批量草稿替换，需在场景编辑器中手工重新保存以生成完整清单。
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Affected Assets Table */}
                    {impactQuery.data.affectedAssets.length === 0 ? (
                      <div className="text-body text-muted-foreground py-6 text-center">
                        当前事件未检测到下游受影响的编排场景
                      </div>
                    ) : (
                      <div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-10">
                                {(() => {
                                  const upgradeableList = impactQuery.data.affectedAssets.filter(
                                    (a) => a.upgradeStatus === 'upgradeable',
                                  )
                                  const allChecked =
                                    upgradeableList.length > 0 &&
                                    upgradeableList.every((a) => selectedScenarioIds.includes(a.assetId))
                                  return (
                                    <Checkbox
                                      checked={allChecked}
                                      disabled={upgradeableList.length === 0}
                                      onCheckedChange={() =>
                                        toggleSelectAllUpgradeable(upgradeableList.map((a) => a.assetId))
                                      }
                                      aria-label="全选可升级场景"
                                    />
                                  )
                                })()}
                              </TableHead>
                              <TableHead>场景名称</TableHead>
                              <TableHead>依赖关系</TableHead>
                              <TableHead>模块版本变更</TableHead>
                              <TableHead>升级判定</TableHead>
                              <TableHead>说明 / 阻碍原因</TableHead>
                              <TableHead className="text-right">操作</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {impactQuery.data.affectedAssets
                              .slice((assetsPage - 1) * 10, assetsPage * 10)
                              .map((asset) => {
                                const isUpgradeable = asset.upgradeStatus === 'upgradeable'
                                const isChecked = selectedScenarioIds.includes(asset.assetId)
                                return (
                                  <TableRow key={asset.assetId}>
                                    <TableCell>
                                      <Checkbox
                                        checked={isChecked}
                                        disabled={!isUpgradeable}
                                        onCheckedChange={() => toggleSelectScenario(asset.assetId)}
                                        aria-label={`选择场景 ${asset.assetName}`}
                                      />
                                    </TableCell>
                                    <TableCell>
                                      <div className="font-medium text-foreground">
                                        {asset.assetName}
                                      </div>
                                      <div className="text-label text-muted-foreground">
                                        #{asset.assetId.slice(0, 8)}
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      {asset.relation === 'confirmed' && (
                                        <Badge
                                          variant="outline"
                                          className="text-status-success-foreground border-status-success-accent/30 text-label"
                                        >
                                          直接确认
                                        </Badge>
                                      )}
                                      {asset.relation === 'possible' && (
                                        <Badge
                                          variant="outline"
                                          className="text-status-warning-foreground border-status-warning-accent/30 text-label"
                                        >
                                          间接可能
                                        </Badge>
                                      )}
                                      {asset.relation === 'coverage_gap' && (
                                        <Badge
                                          variant="outline"
                                          className="text-status-warning-foreground border-status-warning-accent/30 text-label"
                                        >
                                          缺口降级
                                        </Badge>
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      {asset.currentBindingVersionNo && asset.targetVersionNo ? (
                                        <div className="flex items-center gap-1.5 text-label font-mono">
                                          <span className="text-muted-foreground">
                                            v{asset.currentBindingVersionNo}
                                          </span>
                                          <ArrowRight className="size-3 text-muted-foreground" />
                                          <span className="font-semibold text-foreground">
                                            v{asset.targetVersionNo}
                                          </span>
                                        </div>
                                      ) : asset.upgradeStatus === 'already_latest' && asset.currentBindingVersionNo ? (
                                        <span className="text-label font-mono text-muted-foreground">
                                          v{asset.currentBindingVersionNo} (最新)
                                        </span>
                                      ) : (
                                        <span className="text-label text-muted-foreground">-</span>
                                      )}
                                    </TableCell>
                                    <TableCell>
                                      {asset.upgradeStatus === 'upgradeable' && (
                                        <StatusBadge tone="success">建议升级</StatusBadge>
                                      )}
                                      {asset.upgradeStatus === 'already_latest' && (
                                        <StatusBadge tone="neutral">已是最新</StatusBadge>
                                      )}
                                      {asset.upgradeStatus === 'blocked' && (
                                        <StatusBadge tone="error">存在阻碍</StatusBadge>
                                      )}
                                    </TableCell>
                                    <TableCell className="max-w-[280px]">
                                      {asset.blockerReason ? (
                                        <span className="text-label text-status-error-foreground truncate block" title={asset.blockerReason}>
                                          {asset.blockerReason}
                                        </span>
                                      ) : asset.gapReason ? (
                                        <span className="text-label text-status-warning-foreground">
                                          历史老版本缺少结构化元数据
                                        </span>
                                      ) : asset.upgradeStatus === 'already_latest' ? (
                                        <span className="text-label text-muted-foreground">
                                          已绑定已发布最新版本
                                        </span>
                                      ) : (
                                        <span className="text-label text-status-success-foreground">
                                          通过静态接口契约检查，可无损升级
                                        </span>
                                      )}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      <Button variant="ghost" size="sm" asChild className="h-7 text-label">
                                        <Link
                                          to="/scenarios/$scenarioId"
                                          params={{ scenarioId: asset.assetId }}
                                        >
                                          <ExternalLink className="mr-1 size-3" />
                                          查看场景
                                        </Link>
                                      </Button>
                                    </TableCell>
                                  </TableRow>
                                )
                              })}
                          </TableBody>
                        </Table>
                        <SimplePagination
                          currentPage={assetsPage}
                          pageSize={10}
                          totalItems={impactQuery.data.affectedAssets.length}
                          onPageChange={setAssetsPage}
                        />
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tab 3: Evidence */}
          <TabsContent value="evidence" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-section flex items-center gap-2">
                  <Clock className="size-4 text-primary" />
                  异常稀疏账本记录 (Reliability Signals: {signals.length})
                </CardTitle>
                <CardDescription>
                  Worker 内存评估写入的原子故障与偏离事实，完整复盘退化过程
                </CardDescription>
              </CardHeader>
              <CardContent>
                {signals.length === 0 ? (
                  <div className="text-body text-muted-foreground py-6 text-center">
                    暂无关联的信号事实
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>信号类型</TableHead>
                        <TableHead>等级</TableHead>
                        <TableHead>发生时点</TableHead>
                        <TableHead>主体 (Subject)</TableHead>
                        <TableHead>执行来源 (Source)</TableHead>
                        <TableHead className="text-right">度量数值</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {signals.map((sig) => (
                        <TableRow key={sig.id}>
                          <TableCell>
                            <Badge variant="outline" className="text-label font-mono">
                              {sig.kind}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                sig.severity === 'CRITICAL' || sig.severity === 'ERROR'
                                  ? 'destructive'
                                  : 'secondary'
                              }
                              className="text-label"
                            >
                              {sig.severity}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-label text-muted-foreground">
                            {new Date(sig.occurredAt).toLocaleString('zh-CN')}
                          </TableCell>
                          <TableCell className="text-label">
                            <span className="font-mono text-muted-foreground">
                              {sig.subjectRef ? `${sig.subjectRef.kind}: ${sig.subjectRef.id}` : '—'}
                            </span>
                          </TableCell>
                          <TableCell className="text-label">
                            <span className="font-mono text-muted-foreground">
                              {sig.sourceRef ? `${sig.sourceRef.kind}: ${sig.sourceRef.id}` : '—'}
                            </span>
                          </TableCell>
                          <TableCell className="text-right text-label font-semibold">
                            {sig.value !== undefined ? `${sig.value} ${sig.unit || ''}` : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Tab 4: Repairs (Phase 2.1 View) */}
          <TabsContent value="repairs" className="space-y-6">
            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-section flex items-center gap-2">
                    <Wrench className="size-4 text-primary" />
                    人工安全维护与跳转指引
                  </CardTitle>
                  <CardDescription>
                    确定性修复通道：直接打开对应场景或模块草稿进行定位器校准
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 text-body">
                  <p className="text-muted-foreground text-label leading-relaxed">
                    当前事件由同源指纹聚类而成。建议前往对应资产的编排 Studio，复用受管画面拾取更新失效定位器，并保存为新版本。
                  </p>

                  <div className="p-3 bg-muted/60 rounded-lg space-y-2 text-label">
                    <div className="font-semibold text-foreground">推荐排查步骤：</div>
                    <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
                      <li>核对发生回退或超时的步骤定位描述符（Descriptor）；</li>
                      <li>在 Studio 中连接受管会话，利用局部指认模式重新提取元素属性；</li>
                      <li>完成试跑验证后提交发布，系统将自动进入 OBSERVING 状态观察效果。</li>
                    </ol>
                  </div>

                  <div className="pt-2 flex items-center gap-3">
                    <Button variant="default" size="sm" asChild>
                      <Link to="/scenarios">
                        <ExternalLink className="mr-1.5 size-3.5" />
                        前往场景编排工作台
                      </Link>
                    </Button>
                    <Button variant="outline" size="sm" asChild>
                      <Link to="/action-modules">
                        <ExternalLink className="mr-1.5 size-3.5" />
                        前往动作库管理
                      </Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-section flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <Sparkles className="size-4 text-ai-foreground" />
                      AI 受控自愈演进（AI-02 接管）
                    </span>
                    {repairCandidatesQuery.data && (
                      <Badge variant="outline">
                        {repairCandidatesQuery.data.length} 条候选
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    关联场景修复候选 (Repair Candidates)，可在 Studio 审查并采纳
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {repairCandidatesQuery.isLoading ? (
                    <div className="py-6 text-center text-label text-muted-foreground">正在加载修复候选...</div>
                  ) : !repairCandidatesQuery.data?.length ? (
                    <div className="py-6 text-center text-label text-muted-foreground">
                      当前场景暂无待处理的定位修复候选（运行期确定性命中或尚未发生 AI 救活）
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {repairCandidatesQuery.data.map((cand) => {
                        const suggested = cand.patch?.suggestedCandidate
                        return (
                          <div
                            key={cand.id}
                            className="p-3 bg-muted/40 border rounded-lg space-y-2 text-label"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-foreground flex items-center gap-1.5">
                                步骤「{cand.patchTargetRef.stepId}」
                                <Badge variant={cand.status === 'validated' ? 'default' : cand.status === 'proposed' ? 'outline' : 'secondary'}>
                                  {cand.status === 'proposed' ? '待验证' : cand.status === 'validating' ? '验证中' : cand.status === 'validated' ? '已验证' : cand.status === 'adopted' ? '已采纳' : cand.status === 'rejected' ? '已驳回' : cand.status}
                                </Badge>
                              </span>
                              <span className="text-muted-foreground text-label">
                                观测 {cand.observationCount} 次
                                {cand.rejectedObservationCount > 0 && ` (驳回后 ${cand.rejectedObservationCount} 次)`}
                              </span>
                            </div>
                            <p className="text-muted-foreground">{cand.hypothesis}</p>
                            {suggested && (
                              <div className="text-label bg-background p-2 rounded border font-mono">
                                建议新增: {suggested.by} = {suggested.value}
                                {suggested.name ? ` [name="${suggested.name}"]` : ''}
                              </div>
                            )}
                            <div className="pt-1 flex items-center justify-between">
                              <span className="text-label text-muted-foreground">
                                来源: {cand.sourceRunKind === 'published' ? '正式运行' : cand.sourceRunKind === 'trial' ? '试跑' : '调试'}
                              </span>
                              {incident?.lineage?.scenarioId && (
                                <Button variant="ghost" size="sm" asChild className="h-7 text-label">
                                  <Link
                                    to="/scenarios/$scenarioId"
                                    params={{ scenarioId: incident.lineage.scenarioId }}
                                  >
                                    前往 Studio 审查与采纳
                                    <ArrowRight className="ml-1 size-3" />
                                  </Link>
                                </Button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </Main>

      {/* Triage Dialog */}
      <Dialog open={!!triageAction} onOpenChange={(open) => !open && setTriageAction(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {triageAction === 'resolve'
                ? '标记解决 / 归档事件'
                : triageAction === 'dismiss'
                  ? '排除该可靠性事件'
                  : triageAction === 'silence'
                    ? '静默告警'
                    : '拆分该事件'}
            </DialogTitle>
            <DialogDescription className="truncate">
              目标事件：{incident.title}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {triageAction === 'silence' && (
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

            {triageAction === 'split' ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="split-title">新拆分子事件标题</Label>
                  <Input
                    id="split-title"
                    placeholder="输入拆分后的新事件名称"
                    value={splitTitle}
                    onChange={(e) => setSplitTitle(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>选择需要拆出的成员 ({selectedSplitMembers.length})</Label>
                  <div className="max-h-48 overflow-y-auto border border-border rounded p-2 space-y-1 text-label">
                    {members.map((m) => (
                      <label
                        key={m.id}
                        className="flex items-center gap-2 p-1 rounded hover:bg-muted cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedSplitMembers.includes(m.memberRef)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedSplitMembers([...selectedSplitMembers, m.memberRef])
                            } else {
                              setSelectedSplitMembers(
                                selectedSplitMembers.filter((id) => id !== m.memberRef),
                              )
                            }
                          }}
                        />
                        <span className="font-mono">{m.memberRef}</span>
                        <span className="text-muted-foreground">({m.memberType})</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="triage-reason">
                  {triageAction === 'resolve'
                    ? '解决/归档理由'
                    : triageAction === 'dismiss'
                      ? '排除理由'
                      : '静默理由'}
                </Label>
                <Input
                  id="triage-reason"
                  placeholder={
                    triageAction === 'resolve'
                      ? '例如：已完成修复且累计 30 次稳定观察，核验原 Outcome 均正常'
                      : '例如：系统已知大促改版中、排期在周五版本统一修复'
                  }
                  value={triageReason}
                  onChange={(e) => setTriageReason(e.target.value)}
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTriageAction(null)} disabled={triageSubmitting}>
              取消
            </Button>
            <Button
              variant={triageAction === 'dismiss' ? 'destructive' : 'default'}
              onClick={handleTriageSubmit}
              disabled={triageSubmitting}
            >
              {triageSubmitting
                ? '处理中...'
                : triageAction === 'resolve'
                  ? '确认解决/归档'
                  : '确认执行'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Batch Upgrade Receipt Dialog */}
      <Dialog open={!!upgradeReceipt} onOpenChange={(open) => !open && setUpgradeReceipt(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="size-5 text-status-success-foreground" />
              集中升级执行结果 (Batch Upgrade Receipt)
            </DialogTitle>
            <DialogDescription>
              升级作业 #{upgradeReceipt?.jobId.slice(0, 8)} · 状态: {upgradeReceipt?.status === 'completed' ? '全部成功' : '部分完成'}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[360px] overflow-y-auto space-y-3 py-2">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>场景名称</TableHead>
                  <TableHead>升级状态</TableHead>
                  <TableHead>执行说明</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upgradeReceipt?.results.map((res) => (
                  <TableRow key={res.scenarioId}>
                    <TableCell className="font-medium text-foreground">
                      {res.scenarioName}
                    </TableCell>
                    <TableCell>
                      {res.status === 'upgraded' && (
                        <StatusBadge tone="success">已升级</StatusBadge>
                      )}
                      {res.status === 'conflict' && (
                        <StatusBadge tone="warning">草稿冲突</StatusBadge>
                      )}
                      {res.status === 'skipped' && (
                        <StatusBadge tone="error">已跳过</StatusBadge>
                      )}
                    </TableCell>
                    <TableCell className="text-label text-muted-foreground">
                      {res.reason || (res.status === 'upgraded' ? '草稿已成功指向目标版本' : '-')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <DialogFooter>
            <Button onClick={() => setUpgradeReceipt(null)}>关闭回执</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
