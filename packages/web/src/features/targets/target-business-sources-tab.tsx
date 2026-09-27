import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  Eye,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  BUSINESS_SOURCE_CURSOR_EXPIRED,
  type PreviewBusinessSourceResponse,
} from '@cairn/shared'
import {
  approveBusinessSourceCandidate,
  createBusinessSourceCandidate,
  fetchBusinessRecords,
  fetchBusinessSource,
  fetchBusinessSourceCandidate,
  previewBusinessSource,
  revokeBusinessSource,
} from '@/lib/business-sources-api'
import { fetchDatasets } from '@/lib/datasets-api'
import { ApiRequestError } from '@/lib/api-client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { StatusBadge, type StatusTone } from '@/components/status-badge'
import { Can } from '@/components/rbac/can'

interface TargetBusinessSourcesTabProps {
  targetId: string
  targetName: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

export function TargetBusinessSourcesTab({ targetId, targetName }: TargetBusinessSourcesTabProps) {
  const queryClient = useQueryClient()
  const [entityType, setEntityType] = useState('manufacturer')

  // Candidate submission form state
  const [selectedDatasetId, setSelectedDatasetId] = useState('')
  const [keyColumn, setKeyColumn] = useState('code')
  const [displayNameColumn, setDisplayNameColumn] = useState('name')
  const [statusColumn, setStatusColumn] = useState('status')
  const [fieldWhitelist, setFieldWhitelist] = useState('code, name, status')
  const [sourceObservedAt, setSourceObservedAt] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [completenessBasis, setCompletenessBasis] = useState('快照全量扫描校验')

  // Preview state
  const [previewData, setPreviewData] = useState<PreviewBusinessSourceResponse | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Current candidate being watched
  const [activeCandidateId, setActiveCandidateId] = useState<string | null>(null)

  // Approve dialog
  const [approveDialogOpen, setApproveDialogOpen] = useState(false)
  const [approvalBasis, setApprovalBasis] = useState('人工复核数据源无误，同意发布')

  // Revoke dialog
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false)
  const [revocationReason, setRevocationReason] = useState('业务数据源已废弃或停用')

  // Business records viewer
  const [recordsSearch, setRecordsSearch] = useState('')
  const [recordsCursor, setRecordsCursor] = useState<string | undefined>(undefined)
  const [cursorExpiredError, setCursorExpiredError] = useState(false)

  // Queries
  const sourceQuery = useQuery({
    queryKey: ['target-business-source', targetId, entityType],
    queryFn: () => fetchBusinessSource(targetId, entityType),
  })

  const datasetsQuery = useQuery({
    queryKey: ['datasets', { targetId }],
    queryFn: () => fetchDatasets({ targetId, limit: 100 }),
  })

  const candidateQuery = useQuery({
    queryKey: ['business-source-candidate', targetId, activeCandidateId],
    queryFn: () => (activeCandidateId ? fetchBusinessSourceCandidate(targetId, activeCandidateId) : null),
    enabled: Boolean(activeCandidateId),
    refetchInterval: (query) => {
      const data = query.state.data
      if (data && (data.buildStatus === 'ready' || data.buildStatus === 'rejected' || data.buildStatus === 'failed')) {
        return false
      }
      return 2000
    },
  })

  const recordsQuery = useQuery({
    queryKey: ['target-business-records', targetId, entityType, recordsSearch, recordsCursor],
    queryFn: async () => {
      try {
        setCursorExpiredError(false)
        return await fetchBusinessRecords(targetId, {
          entityType,
          search: recordsSearch || undefined,
          cursor: recordsCursor,
          limit: 20,
        })
      } catch (err) {
        if (err instanceof ApiRequestError && err.payload.code === BUSINESS_SOURCE_CURSOR_EXPIRED) {
          setCursorExpiredError(true)
        }
        throw err
      }
    },
    enabled: Boolean(sourceQuery.data?.status === 'active' && sourceQuery.data.currentSnapshotId),
    retry: (failureCount, error) => {
      if (error instanceof ApiRequestError && error.payload.code === BUSINESS_SOURCE_CURSOR_EXPIRED) {
        return false
      }
      return failureCount < 2
    },
  })

  // Mutations
  const createCandidateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDatasetId) throw new Error('请选择数据集')
      const whitelistArray = fieldWhitelist
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      return createBusinessSourceCandidate(targetId, {
        datasetId: selectedDatasetId,
        entityType,
        mappingConfig: {
          keyColumn: keyColumn.trim(),
          displayNameColumn: displayNameColumn.trim(),
          statusColumn: statusColumn.trim() || undefined,
          fieldWhitelist: whitelistArray,
        },
        sourceObservedAt: sourceObservedAt.trim() || null,
        validUntil: validUntil.trim() || null,
        completenessBasis: completenessBasis.trim() || '快照全量扫描校验',
      })
    },
    onSuccess: (data) => {
      toast.success('已创建候选快照构建作业，Worker 正在后台扫描校验')
      setActiveCandidateId(data.candidateId)
      void queryClient.invalidateQueries({ queryKey: ['business-source-candidate', targetId, data.candidateId] })
    },
    onError: (err: unknown) => {
      toast.error(`创建候选失败：${errorMessage(err)}`)
    },
  })

  const approveMutation = useMutation({
    mutationFn: async () => {
      if (!activeCandidateId) throw new Error('无待审批候选')
      const expectedRevision = sourceQuery.data?.bindingRevision ?? 1
      return approveBusinessSourceCandidate(targetId, activeCandidateId, {
        expectedRevision,
        approvalBasis: approvalBasis.trim(),
      })
    },
    onSuccess: () => {
      toast.success('候选快照已审批上线！当前来源指针已原子切换')
      setApproveDialogOpen(false)
      setActiveCandidateId(null)
      void queryClient.invalidateQueries({ queryKey: ['target-business-source', targetId, entityType] })
      void queryClient.invalidateQueries({ queryKey: ['target-business-records', targetId] })
    },
    onError: (err: unknown) => {
      toast.error(`审批失败：${errorMessage(err)}`)
    },
  })

  const revokeMutation = useMutation({
    mutationFn: async () => {
      if (!sourceQuery.data) throw new Error('数据源不存在')
      return revokeBusinessSource(targetId, {
        entityType,
        expectedRevision: sourceQuery.data.bindingRevision,
        revocationReason: revocationReason.trim(),
      })
    },
    onSuccess: () => {
      toast.success('业务数据源已成功撤回')
      setRevokeDialogOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['target-business-source', targetId, entityType] })
      void queryClient.invalidateQueries({ queryKey: ['target-business-records', targetId] })
    },
    onError: (err: unknown) => {
      toast.error(`撤回失败：${errorMessage(err)}`)
    },
  })

  const handlePreview = async () => {
    if (!selectedDatasetId) {
      toast.error('请先选择数据集')
      return
    }
    const whitelistArray = fieldWhitelist
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!keyColumn.trim() || !displayNameColumn.trim() || whitelistArray.length === 0) {
      toast.error('请填写业务主键列、显示名称列与包含字段白名单')
      return
    }

    setPreviewLoading(true)
    try {
      const res = await previewBusinessSource(targetId, {
        datasetId: selectedDatasetId,
        entityType,
        mappingConfig: {
          keyColumn: keyColumn.trim(),
          displayNameColumn: displayNameColumn.trim(),
          statusColumn: statusColumn.trim() || undefined,
          fieldWhitelist: whitelistArray,
        },
      })
      setPreviewData(res)
      setPreviewOpen(true)
    } catch (err: unknown) {
      toast.error(`预览失败：${errorMessage(err)}`)
    } finally {
      setPreviewLoading(false)
    }
  }

  const currentSource = sourceQuery.data
  const candidate = candidateQuery.data

  const getSourceTone = (status?: string): StatusTone => {
    if (status === 'active') return 'success'
    if (status === 'revoked') return 'blocked'
    return 'neutral'
  }

  const getCandidateTone = (status?: string): StatusTone => {
    if (status === 'ready') return 'success'
    if (status === 'building') return 'waiting'
    if (status === 'rejected' || status === 'failed') return 'error'
    return 'neutral'
  }

  if (sourceQuery.isPending || datasetsQuery.isPending) {
    return <PageSkeleton />
  }

  if (sourceQuery.isError) {
    return (
      <QueryErrorState
        title='无法加载业务数据来源'
        onRetry={() => {
          void sourceQuery.refetch()
        }}
      />
    )
  }

  const datasetList = datasetsQuery.data?.items ?? []

  return (
    <div className='space-y-6'>
      {/* 头部与实体类型切换 */}
      <div className='flex flex-wrap items-center justify-between gap-4'>
        <div>
          <h2 className='text-section font-semibold text-foreground'>「{targetName}」AI 业务数据来源与更新闭环</h2>
          <p className='text-body text-muted-foreground'>
            为平台助手提供确定性业务数据快照与字典检索。仅读取人工审核批准的不可变快照，严禁静默覆盖。
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <span className='text-body text-muted-foreground'>业务实体：</span>
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className='rounded-md border border-input bg-background px-3 py-1.5 text-body shadow-sm'
          >
            <option value='manufacturer'>厂家 (manufacturer)</option>
          </select>
        </div>
      </div>

      {/* 区域 1：当前生效数据源 */}
      <div className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
        <div className='flex flex-wrap items-center justify-between gap-4 border-b border-border-divider pb-4'>
          <div className='flex items-center gap-3'>
            <Database className='size-5 text-primary' />
            <h3 className='font-medium text-foreground'>当前生效快照状态</h3>
            {currentSource ? (
              <>
                <StatusBadge tone={getSourceTone(currentSource.status)}>
                  {currentSource.status === 'active' ? '生效中' : currentSource.status === 'revoked' ? '已撤回' : '草稿'}
                </StatusBadge>
                <span className='rounded bg-muted px-2 py-0.5 text-label text-muted-foreground font-mono'>
                  修订版本 v{currentSource.bindingRevision}
                </span>
              </>
            ) : (
              <StatusBadge tone='neutral'>未配置来源</StatusBadge>
            )}
          </div>
          {currentSource?.status === 'active' && (
            <Can allOf={['target:write', 'dataset:write']}>
              <Button
                variant='outline'
                size='sm'
                className='text-destructive hover:bg-destructive/10'
                onClick={() => setRevokeDialogOpen(true)}
              >
                <XCircle className='mr-1.5 size-4' />
                撤回当前来源
              </Button>
            </Can>
          )}
        </div>

        {currentSource && currentSource.status === 'active' ? (
          <div className='mt-4 grid grid-cols-1 gap-4 text-body md:grid-cols-3'>
            <div>
              <span className='text-muted-foreground'>当前快照 ID：</span>
              <div className='font-mono text-label text-foreground mt-0.5'>{currentSource.currentSnapshotId}</div>
            </div>
            <div>
              <span className='text-muted-foreground'>覆盖依据声明：</span>
              <div className='text-foreground mt-0.5'>{currentSource.completenessBasis || '无'}</div>
            </div>
            <div>
              <span className='text-muted-foreground'>审批时点：</span>
              <div className='text-foreground mt-0.5'>
                {currentSource.approvedAt ? new Date(currentSource.approvedAt).toLocaleString() : '未记录'}
              </div>
            </div>
            <div>
              <span className='text-muted-foreground'>源数据导出时点：</span>
              <div className='text-foreground mt-0.5'>
                {currentSource.declaredSourceAsOf || currentSource.declaredByAccountId || '未单独声明'}
              </div>
            </div>
            <div>
              <span className='text-muted-foreground'>有效期至：</span>
              <div className='text-foreground mt-0.5'>{currentSource.validUntil || '永久有效'}</div>
            </div>
            <div>
              <span className='text-muted-foreground'>审核依据说明：</span>
              <div className='text-foreground mt-0.5'>{currentSource.declarationBasis || '管理员核准上线'}</div>
            </div>
          </div>
        ) : (
          <div className='mt-4 text-body text-muted-foreground'>
            {currentSource?.status === 'revoked'
              ? '当前业务数据源已被撤回。平台助手将无法检索此实体的业务记录，请配置新快照并重新审批。'
              : '当前目标系统尚未配置已审批的业务数据源快照。请在下方配置数据集映射并提交候选构建。'}
          </div>
        )}
      </div>

      {/* 区域 2：配置新快照候选 */}
      <Can allOf={['target:write', 'dataset:write']}>
        <div className='rounded-lg border border-border-card bg-card p-5 shadow-card space-y-4'>
          <div className='flex items-center gap-2 border-b border-border-divider pb-3'>
            <Plus className='size-5 text-primary' />
            <h3 className='font-medium text-foreground'>配置与创建候选快照 (Candidate Snapshot)</h3>
          </div>

          <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
            <div>
              <label className='block text-body font-medium text-foreground mb-1'>选择源数据集 (同 Target)</label>
              <select
                data-testid='dataset-select'
                aria-label='选择源数据集'
                value={selectedDatasetId}
                onChange={(e) => setSelectedDatasetId(e.target.value)}
                className='w-full rounded-md border border-input bg-background px-3 py-2 text-body shadow-sm'
              >
                <option value=''>-- 请选择已有数据集 --</option>
                {datasetList.map((ds) => (
                  <option key={ds.id} value={ds.id}>
                    {ds.name} ({ds.rowCount} 行)
                  </option>
                ))}
              </select>
              <p className='text-label text-muted-foreground mt-1'>
                须为当前目标系统下已导入且未删除的数据集，最多支持扫描 10,000 行。
              </p>
            </div>

            <div>
              <label className='block text-body font-medium text-foreground mb-1'>业务主键列 (keyColumn) *</label>
              <Input
                placeholder='例如：code'
                value={keyColumn}
                onChange={(e) => setKeyColumn(e.target.value)}
              />
              <p className='text-label text-muted-foreground mt-1'>不可为空，全量扫描中出现重复主键将直接拒绝候选。</p>
            </div>

            <div>
              <label className='block text-body font-medium text-foreground mb-1'>显示名称列 (displayNameColumn) *</label>
              <Input
                placeholder='例如：name'
                value={displayNameColumn}
                onChange={(e) => setDisplayNameColumn(e.target.value)}
              />
            </div>

            <div>
              <label className='block text-body font-medium text-foreground mb-1'>业务状态列 (statusColumn)</label>
              <Input
                placeholder='例如：status（可选）'
                value={statusColumn}
                onChange={(e) => setStatusColumn(e.target.value)}
              />
            </div>

            <div className='md:col-span-2'>
              <label className='block text-body font-medium text-foreground mb-1'>字段白名单 (逗号分隔) *</label>
              <Input
                placeholder='例如：code, name, status, contact, address'
                value={fieldWhitelist}
                onChange={(e) => setFieldWhitelist(e.target.value)}
              />
              <p className='text-label text-muted-foreground mt-1'>
                仅白名单字段会写入快照投影；严禁包含密码、口令、Token、密钥等敏感字段（命中将直接阻断）。
              </p>
            </div>

            <div>
              <label className='block text-body font-medium text-foreground mb-1'>源数据导出时点 (sourceObservedAt)</label>
              <Input
                type='datetime-local'
                value={sourceObservedAt}
                onChange={(e) => setSourceObservedAt(e.target.value)}
              />
            </div>

            <div>
              <label className='block text-body font-medium text-foreground mb-1'>快照有效期至 (validUntil)</label>
              <Input
                type='datetime-local'
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </div>

            <div className='md:col-span-2'>
              <label className='block text-body font-medium text-foreground mb-1'>覆盖依据声明 (completenessBasis)</label>
              <Input
                placeholder='例如：快照全量扫描校验'
                value={completenessBasis}
                onChange={(e) => setCompletenessBasis(e.target.value)}
              />
            </div>
          </div>

          <div className='flex items-center justify-end gap-3 pt-3 border-t border-border-divider'>
            <Button variant='outline' onClick={handlePreview} disabled={previewLoading}>
              <Eye className='mr-1.5 size-4' />
              {previewLoading ? '正在采样...' : '映射采样预览 (前10行)'}
            </Button>
            <Button
              onClick={() => createCandidateMutation.mutate()}
              disabled={createCandidateMutation.isPending || !selectedDatasetId}
            >
              <Plus className='mr-1.5 size-4' />
              {createCandidateMutation.isPending ? '正在创建...' : '提交候选并开始全量校验'}
            </Button>
          </div>
        </div>
      </Can>

      {/* 区域 3：待审批 / 构建中候选监控 */}
      {activeCandidateId && (
        <div className='rounded-lg border border-border-card bg-card p-5 shadow-card space-y-4'>
          <div className='flex items-center justify-between border-b border-border-divider pb-3'>
            <div className='flex items-center gap-2'>
              <RefreshCw className={`size-5 text-primary ${candidate?.buildStatus === 'building' ? 'animate-spin' : ''}`} />
              <h3 className='font-medium text-foreground'>候选快照构建与校验状态</h3>
              <StatusBadge tone={getCandidateTone(candidate?.buildStatus)}>
                {candidate?.buildStatus === 'building'
                  ? 'Worker 全量扫描校验中...'
                  : candidate?.buildStatus === 'ready'
                  ? '校验通过 (待审批)'
                  : candidate?.buildStatus === 'rejected'
                  ? '校验拒绝'
                  : candidate?.buildStatus || '查询中...'}
              </StatusBadge>
            </div>
            {candidate?.buildStatus === 'ready' && (
              <Can allOf={['target:write', 'dataset:write']}>
                <Button onClick={() => setApproveDialogOpen(true)}>
                  <CheckCircle2 className='mr-1.5 size-4' />
                  人工审批并切换为当前来源
                </Button>
              </Can>
            )}
          </div>

          {candidate?.validationSummary ? (
            <div className='space-y-3 text-body'>
              <div className='flex flex-wrap gap-6'>
                <div>
                  <span className='text-muted-foreground'>扫描总行数：</span>
                  <span className='font-semibold text-foreground'>{candidate.validationSummary.totalRows}</span>
                </div>
                <div>
                  <span className='text-muted-foreground'>合规有效数：</span>
                  <span className='font-semibold text-status-success-foreground'>{candidate.validationSummary.validCount}</span>
                </div>
                <div>
                  <span className='text-muted-foreground'>被拒绝行数：</span>
                  <span className='font-semibold text-status-error-foreground'>{candidate.validationSummary.rejectedCount}</span>
                </div>
              </div>

              {candidate.validationSummary.issues.length > 0 && (
                <div className='rounded-md border border-destructive/30 bg-destructive/5 p-3'>
                  <div className='flex items-center gap-1.5 font-medium text-destructive text-body mb-2'>
                    <ShieldAlert className='size-4' />
                    校验不通过原因样本 (前 {candidate.validationSummary.issues.length} 条)：
                  </div>
                  <ul className='list-disc list-inside space-y-1 text-label text-destructive'>
                    {candidate.validationSummary.issues.map((iss, idx) => (
                      <li key={idx}>
                        第 {iss.rowIndex + 1} 行 {iss.recordKey ? `[主键: ${iss.recordKey}]` : ''}: {iss.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className='text-body text-muted-foreground'>正在分配 Worker 节点执行批次投影与主键唯一性校验...</p>
          )}
        </div>
      )}

      {/* 区域 4：已批准业务记录只读浏览器 */}
      {currentSource?.status === 'active' && currentSource.currentSnapshotId && (
        <div className='rounded-lg border border-border-card bg-card p-5 shadow-card space-y-4'>
          <div className='flex flex-wrap items-center justify-between gap-4 border-b border-border-divider pb-3'>
            <div>
              <h3 className='font-medium text-foreground'>当前生效快照业务记录浏览器</h3>
              <p className='text-label text-muted-foreground'>
                来自快照 <span className='font-mono'>{currentSource.currentSnapshotId}</span> 的只读投影记录，零 Token 确定性检索。
              </p>
            </div>
            <div className='flex items-center gap-2'>
              <Input
                placeholder='搜索记录主键或名称...'
                value={recordsSearch}
                onChange={(e) => {
                  setRecordsSearch(e.target.value)
                  setRecordsCursor(undefined)
                }}
                className='w-64'
              />
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  setRecordsCursor(undefined)
                  void recordsQuery.refetch()
                }}
              >
                <Search className='size-4' />
              </Button>
            </div>
          </div>

          {cursorExpiredError && (
            <Alert variant='destructive'>
              <AlertTriangle className='size-4' />
              <AlertTitle>409 游标已过期 (BUSINESS_SOURCE_CURSOR_EXPIRED)</AlertTitle>
              <AlertDescription className='flex items-center justify-between'>
                <span>当前业务数据源快照已被切换或修订，历史翻页游标已失效。</span>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => {
                    setRecordsCursor(undefined)
                    setCursorExpiredError(false)
                    void recordsQuery.refetch()
                  }}
                >
                  重置游标重新获取
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {recordsQuery.isPending ? (
            <PageSkeleton />
          ) : recordsQuery.data?.items.length === 0 ? (
            <EmptyState
              title='未找到匹配的业务记录'
              description='当前快照中无符合搜索条件的记录。'
            />
          ) : (
            <div className='space-y-3'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>业务主键 (Key)</TableHead>
                    <TableHead>显示名称</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>行序号</TableHead>
                    <TableHead>白名单 Payload</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recordsQuery.data?.items.map((record) => (
                    <TableRow key={record.id}>
                      <TableCell className='font-mono font-medium'>{record.recordKey}</TableCell>
                      <TableCell>{record.displayName}</TableCell>
                      <TableCell>
                        <StatusBadge tone={record.recordStatus === 'disabled' ? 'blocked' : 'success'}>
                          {record.recordStatus || 'active'}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className='text-muted-foreground'>第 {record.datasetRowIndex + 1} 行</TableCell>
                      <TableCell className='font-mono text-label max-w-xs truncate'>
                        {JSON.stringify(record.payload)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {recordsQuery.data?.nextCursor && (
                <div className='flex justify-end pt-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => setRecordsCursor(recordsQuery.data?.nextCursor)}
                  >
                    下一页
                    <ArrowRight className='ml-1.5 size-4' />
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 弹窗：采样预览 */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className='max-w-4xl max-h-[80vh] overflow-y-auto'>
          <DialogHeader>
            <DialogTitle>映射采样校验预览 (前 10 行)</DialogTitle>
            <DialogDescription>
              检查提取出的业务主键、名称与白名单字段。采样不替代全量 10,000 行的 Worker 深度唯一性校验。
            </DialogDescription>
          </DialogHeader>

          {previewData && (
            <div className='space-y-4'>
              <div className='flex flex-wrap gap-4 text-body'>
                <div>采样行数：{previewData.validationDigest.sampleCount}</div>
                <div className='text-status-success-foreground'>合规行数：{previewData.validationDigest.sampleValidCount}</div>
                <div className='text-status-error-foreground'>拒绝行数：{previewData.validationDigest.sampleRejectedCount}</div>
              </div>

              {previewData.validationDigest.potentialDuplicateKeys.length > 0 && (
                <Alert variant='destructive'>
                  <AlertTriangle className='size-4' />
                  <AlertTitle>发现潜在重复主键</AlertTitle>
                  <AlertDescription>
                    以下主键在采样中已重复出现：{previewData.validationDigest.potentialDuplicateKeys.join(', ')}。全量扫描时将拒绝该候选。
                  </AlertDescription>
                </Alert>
              )}

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>行号</TableHead>
                    <TableHead>业务主键</TableHead>
                    <TableHead>显示名称</TableHead>
                    <TableHead>校验结果</TableHead>
                    <TableHead>白名单 Payload</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewData.previewRows.map((row) => (
                    <TableRow key={row.rowIndex}>
                      <TableCell>{row.rowIndex + 1}</TableCell>
                      <TableCell className='font-mono font-medium'>{row.recordKey ?? '-'}</TableCell>
                      <TableCell>{row.displayName ?? '-'}</TableCell>
                      <TableCell>
                        {row.isValid ? (
                          <StatusBadge tone='success'>合规</StatusBadge>
                        ) : (
                          <StatusBadge tone='error'>{row.rejectReason || '拒绝'}</StatusBadge>
                        )}
                      </TableCell>
                      <TableCell className='font-mono text-label max-w-xs truncate'>
                        {JSON.stringify(row.payload)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <DialogFooter>
            <Button variant='outline' onClick={() => setPreviewOpen(false)}>
              关闭预览
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 弹窗：审批并切换来源 */}
      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>审批并原子切换业务数据源</DialogTitle>
            <DialogDescription>
              请核对来源用途、主键合规性与覆盖依据。批准后将递增版本修订号（当前预期：v{sourceQuery.data?.bindingRevision ?? 1}）并原子切换为线上有效快照。
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-3 py-2'>
            <label className='block text-body font-medium text-foreground'>审批依据与核准说明 *</label>
            <Input
              value={approvalBasis}
              onChange={(e) => setApprovalBasis(e.target.value)}
              placeholder='例如：人工核对厂家全量名单无误'
            />
          </div>

          <DialogFooter>
            <Button variant='outline' onClick={() => setApproveDialogOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => approveMutation.mutate()}
              disabled={approveMutation.isPending || !approvalBasis.trim()}
            >
              {approveMutation.isPending ? '正在审批切换...' : '确认核准并发布'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 弹窗：撤回业务数据源 */}
      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>撤回业务数据源生效状态</DialogTitle>
            <DialogDescription>
              撤回后助手将不再检索该实体的业务记录，历史游标将返回 409 失效。执行此操作需要 CAS 版本匹配（当前预期：v{sourceQuery.data?.bindingRevision}）。
            </DialogDescription>
          </DialogHeader>

          <div className='space-y-3 py-2'>
            <label className='block text-body font-medium text-foreground'>撤回原因 *</label>
            <Input
              value={revocationReason}
              onChange={(e) => setRevocationReason(e.target.value)}
              placeholder='例如：源系统厂家数据发生重大调整，需要重置'
            />
          </div>

          <DialogFooter>
            <Button variant='outline' onClick={() => setRevokeDialogOpen(false)}>
              取消
            </Button>
            <Button
              variant='destructive'
              onClick={() => revokeMutation.mutate()}
              disabled={revokeMutation.isPending || !revocationReason.trim()}
            >
              {revokeMutation.isPending ? '正在撤回...' : '确认撤回'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
