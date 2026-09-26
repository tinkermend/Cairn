import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MapJobKind } from '@cairn/shared'
import { AlertCircle, CheckCircle2, Play, Search, Wrench } from 'lucide-react'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  createMapJob,
  fetchMapJobPolicy,
  fetchMapSafeEntries,
  previewMapJob,
  updateMapJobPolicy,
} from '@/lib/map-api'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SelectField, SelectFieldOption } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { StatusBadge } from '@/components/status-badge'
import { MAP_ACCOUNT_REQUIRED, mapCapableAccounts } from './map-accounts'

const KIND_LABELS: Record<MapJobKind, string> = {
  map_probe: '探查入口',
  map_refresh: '复查已有资产',
  map_explore: '有界探索',
}

export function JobMaintenanceCard({ targetId }: { targetId: string }) {
  const canRead = useCan('map:read')
  const canMaintain = useCan('map:maintain')
  const queryClient = useQueryClient()
  const [jobKind, setJobKind] = useState<MapJobKind>('map_probe')
  const [accountId, setAccountId] = useState('')
  const [entryId, setEntryId] = useState('')

  const policyQuery = useQuery({
    queryKey: ['map', targetId, 'job-policy'],
    queryFn: () => fetchMapJobPolicy(targetId),
    enabled: canRead,
  })

  const entriesQuery = useQuery({
    queryKey: ['map', targetId, 'safe-entries'],
    queryFn: () => fetchMapSafeEntries(targetId),
    enabled: canRead,
  })

  const accountsQuery = useQuery({
    queryKey: ['target', targetId, 'accounts', 'job'],
    queryFn: () =>
      fetchTargetAccounts(targetId, { status: 'active', limit: 50 }),
    enabled: canMaintain,
  })

  const policyMutation = useMutation({
    mutationFn: (manualJobsEnabled: boolean) =>
      updateMapJobPolicy(targetId, {
        expectedRevision: policyQuery.data?.revision ?? 0,
        idempotencyKey: `job-policy:${Date.now()}`,
        manualJobsEnabled,
        reason: manualJobsEnabled ? '控制台开启手工作业' : '控制台关闭手工作业',
      }),
    onSuccess: (result) => {
      toast.success(result.policy.manualJobsEnabled ? '已开启手工作业' : '已关闭手工作业')
      void queryClient.invalidateQueries({
        queryKey: ['map', targetId, 'job-policy'],
      })
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '更新作业政策失败'
      )
    },
  })

  const previewMutation = useMutation({
    mutationFn: () =>
      previewMapJob(targetId, {
        jobKind,
        targetAccountId: accountId,
        entryId,
        selectedAssetRefs: [],
      }),
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '预览作业失败'
      )
    },
  })

  const createMutation = useMutation({
    mutationFn: () =>
      createMapJob(targetId, {
        source: 'manual',
        manualId: `manual-${Date.now()}`,
        expectedPolicyRevision: policyQuery.data?.revision ?? 0,
        jobKind,
        targetAccountId: accountId,
        entryId,
        selectedAssetRefs: [],
      }),
    onSuccess: (result) => {
      toast.success(result.created ? '已创建地图作业' : '已返回相同作业')
      void queryClient.invalidateQueries({ queryKey: ['map', targetId] })
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiRequestError ? error.message : '创建地图作业失败'
      )
    },
  })

  if (!canRead) return null
  const policy = policyQuery.data
  const entries = entriesQuery.data?.items ?? []
  const accounts = mapCapableAccounts(accountsQuery.data?.items ?? [])
  const enabled = policy?.policy.manualJobsEnabled === true
  const kindEntries = entries.filter((entry) =>
    entry.jobKinds.includes(jobKind)
  )

  return (
    <section className='space-y-3.5 rounded-xl border border-border-card bg-surface p-4 shadow-card'>
      {/* 头部：标题、状态与直接开关 */}
      <div className='flex flex-wrap items-center justify-between gap-3 border-b border-border-card pb-3'>
        <div className='space-y-0.5'>
          <div className='flex items-center gap-2'>
            <Wrench className='size-5 text-link shrink-0' />
            <h2 className='text-section font-semibold text-text-primary'>地图维护</h2>
            <StatusBadge tone={enabled ? 'success' : 'neutral'}>
              {enabled ? '手工作业已开放' : '手工作业关闭'}
            </StatusBadge>
          </div>
          <p className='text-caption text-text-muted'>
            手工探查入口或复查已有资产，手工触发受控执行片以测绘和更新知识地标。
          </p>
        </div>

        {canMaintain ? (
          <div className='flex items-center gap-2 shrink-0'>
            <Label
              htmlFor='manual-jobs-switch'
              className='text-caption font-medium text-text-primary cursor-pointer'
            >
              {enabled ? '手工作业已开启' : '开启手工作业'}
            </Label>
            <Switch
              id='manual-jobs-switch'
              aria-label='开放手工作业'
              checked={enabled}
              disabled={policyMutation.isPending || (!enabled && accounts.length === 0)}
              onCheckedChange={(val) => policyMutation.mutate(val)}
            />
          </div>
        ) : null}
      </div>

      {policyQuery.isPending ? (
        <p className='py-3 text-center text-caption text-text-muted'>作业配置加载中…</p>
      ) : policyQuery.isError ? (
        <div className='rounded-lg border border-border-danger bg-status-danger-subtle p-3 text-caption text-status-danger-foreground'>
          暂时无法读取作业配置：{policyQuery.error?.message}
        </div>
      ) : policy ? (
        <div className='space-y-3'>
          {!canMaintain ? (
            <p className='text-caption text-text-muted'>
              需要地图维护权限才能触发作业。
            </p>
          ) : (
            <>
              {/* 状态轻量提示 */}
              {!enabled ? (
                <Alert className='py-2'>
                  <AlertCircle className='size-4' />
                  <AlertDescription className='text-caption'>
                    出厂关闭。打开右上方开关后方可触发作业。
                    {accounts.length === 0 ? ` (${MAP_ACCOUNT_REQUIRED})` : ''}
                  </AlertDescription>
                </Alert>
              ) : null}

              {/* 紧凑三列网格表单 */}
              <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
                {/* 作业类型 */}
                <div className='space-y-1'>
                  <Label htmlFor='job-kind' className='text-caption font-medium'>作业类型</Label>
                  <SelectField
                    id='job-kind'
                    className='w-full'
                    value={jobKind}
                    onValueChange={(value) => {
                      setJobKind(value as MapJobKind)
                      setEntryId('')
                    }}
                  >
                    <SelectFieldOption value='map_probe'>
                      探查入口 (发现与初探)
                    </SelectFieldOption>
                    <SelectFieldOption value='map_refresh'>
                      复查已有资产 (健康刷新)
                    </SelectFieldOption>
                  </SelectField>
                </div>

                {/* 目标账号 */}
                <div className='space-y-1'>
                  <Label htmlFor='job-account' className='text-caption font-medium'>执行账号</Label>
                  <SelectField
                    id='job-account'
                    className='w-full'
                    value={accountId}
                    onValueChange={(value) => setAccountId(value)}
                  >
                    <SelectFieldOption value=''>选择执行账号</SelectFieldOption>
                    {accounts.map((account) => (
                      <SelectFieldOption key={account.id} value={account.id}>
                        {account.displayName} ({account.username})
                      </SelectFieldOption>
                    ))}
                  </SelectField>
                </div>

                {/* 安全进入路径 */}
                <div className='space-y-1'>
                  <Label htmlFor='job-entry' className='text-caption font-medium'>进入路径</Label>
                  <SelectField
                    id='job-entry'
                    className='w-full'
                    value={entryId}
                    onValueChange={(value) => setEntryId(value)}
                  >
                    <SelectFieldOption value=''>选择入口路径</SelectFieldOption>
                    {kindEntries.map((entry) => (
                      <SelectFieldOption
                        key={entry.entryId}
                        value={entry.entryId}
                      >
                        {entry.name}
                      </SelectFieldOption>
                    ))}
                  </SelectField>
                </div>
              </div>

              {entries.length > 0 && kindEntries.length === 0 ? (
                <p className='text-caption text-text-muted'>
                  没有适用于“{KIND_LABELS[jobKind]}”的安全路径。可在上方安全进入路径中编辑勾选。
                </p>
              ) : null}

              {/* 操作按钮组 */}
              <div className='flex items-center justify-between pt-1'>
                <div className='flex items-center gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={previewMutation.isPending || !accountId || !entryId}
                    onClick={() => previewMutation.mutate()}
                  >
                    <Search className='size-3.5 mr-1.5' />
                    {previewMutation.isPending ? '预览中…' : '预览作业范围'}
                  </Button>
                  <Button
                    size='sm'
                    disabled={createMutation.isPending || !enabled || !accountId || !entryId}
                    onClick={() => createMutation.mutate()}
                  >
                    <Play className='size-3.5 mr-1.5' />
                    {createMutation.isPending ? '创建中…' : KIND_LABELS[jobKind]}
                  </Button>
                </div>
              </div>

              {/* 预览结果反馈 */}
              {previewMutation.data ? (
                <div className='rounded-lg border border-border-card bg-surface-subtle p-3 space-y-1.5'>
                  <div className='text-caption font-semibold text-text-primary'>
                    作业范围预览（共 {previewMutation.data.items.length} 个候选资产）
                  </div>
                  <ul className='space-y-1 text-caption text-text-muted max-h-36 overflow-y-auto'>
                    {previewMutation.data.items.map((item) => (
                      <li
                        key={`${item.assetRef.objectId ?? item.assetRef.pageId}:${item.reason}`}
                        className='flex items-center gap-1.5'
                      >
                        <span className={item.included ? 'text-status-success-foreground' : 'text-text-muted'}>
                          {item.included ? '● 纳入' : '○ 排除'}
                        </span>
                        <span className='font-medium text-text-primary'>{item.name}</span>
                        <span>·</span>
                        <span>{item.reason}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* 作业创建完成反馈 */}
              {createMutation.data ? (
                <div className='flex items-center gap-2 rounded-lg border border-border-success bg-status-success-subtle p-2.5 text-caption text-status-success-foreground'>
                  <CheckCircle2 className='size-4 shrink-0' />
                  <span>
                    作业已排队 ({createMutation.data.job.jobStatus})
                    {createMutation.data.job.firstRunId
                      ? ` · 首片运行：${createMutation.data.job.firstRunId.slice(0, 8)}…`
                      : ''}
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}
