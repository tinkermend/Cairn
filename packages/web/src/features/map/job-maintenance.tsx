import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { arrivalTargetForName, type MapJobKind } from '@cairn/shared'
import { MAP_ACCOUNT_REQUIRED, mapCapableAccounts } from './map-accounts'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  createMapJob,
  createMapSafeEntry,
  fetchMapJobPolicy,
  fetchMapSafeEntries,
  previewMapJob,
  updateMapJobPolicy,
} from '@/lib/map-api'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const KIND_LABELS: Record<MapJobKind, string> = {
  map_probe: '探查入口',
  map_refresh: '复查所选',
  map_explore: '有界探索',
}

export function JobMaintenanceCard({ targetId }: { targetId: string }) {
  const canRead = useCan('map:read')
  const canMaintain = useCan('map:maintain')
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [entryName, setEntryName] = useState('')
  const [entryUrl, setEntryUrl] = useState('')
  const [arrivalName, setArrivalName] = useState('')
  const [summary, setSummary] = useState('')
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
    queryFn: () => fetchTargetAccounts(targetId, { status: 'active', limit: 50 }),
    enabled: canMaintain,
  })
  const policyMutation = useMutation({
    mutationFn: (manualJobsEnabled: boolean) =>
      updateMapJobPolicy(targetId, {
        expectedRevision: policyQuery.data?.revision ?? 0,
        idempotencyKey: `job-policy:${Date.now()}`,
        manualJobsEnabled,
        reason: reason.trim() || (manualJobsEnabled ? '开放手工地图作业' : '关闭手工地图作业'),
      }),
    onSuccess: () => {
      toast.success('已更新作业政策')
      setReason('')
      void queryClient.invalidateQueries({ queryKey: ['map', targetId, 'job-policy'] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '更新作业政策失败')
    },
  })
  const entryMutation = useMutation({
    mutationFn: () =>
      createMapSafeEntry(targetId, {
        idempotencyKey: `safe-entry:${Date.now()}`,
        name: entryName.trim(),
        url: entryUrl.trim(),
        arrivalName: arrivalName.trim(),
        arrivalTarget: arrivalTargetForName(arrivalName),
        safetyBasisKind: 'confirmed_path',
        summary: summary.trim(),
        jobKinds: ['map_probe', 'map_refresh'],
      }),
    onSuccess: () => {
      toast.success('已登记安全进入路径')
      setEntryName('')
      setEntryUrl('')
      setArrivalName('')
      setSummary('')
      void queryClient.invalidateQueries({ queryKey: ['map', targetId, 'safe-entries'] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '登记进入路径失败')
    },
  })
  const previewMutation = useMutation({
    mutationFn: () => previewMapJob(targetId, { jobKind, targetAccountId: accountId, entryId, selectedAssetRefs: [] }),
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '预览作业失败')
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
      toast.error(error instanceof ApiRequestError ? error.message : '创建地图作业失败')
    },
  })

  if (!canRead) return null
  const policy = policyQuery.data
  const entries = entriesQuery.data?.items ?? []
  const accounts = mapCapableAccounts(accountsQuery.data?.items ?? [])
  const enabled = policy?.policy.manualJobsEnabled === true
  const kindEntries = entries.filter((entry) => entry.jobKinds.includes(jobKind))

  return (
    <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <h2 className='text-section font-semibold'>地图维护</h2>
      <p className='text-label text-muted-foreground'>
        手工探针和复查默认关闭。需要已确认安全进入路径，以及已核验会话。
      </p>
      {policyQuery.isPending ? (
        <p className='text-label text-muted-foreground'>作业政策加载中…</p>
      ) : policyQuery.isError ? (
        <p className='text-label text-muted-foreground'>暂时无法读取作业政策。</p>
      ) : policy ? (
        <>
          <p className='text-body'>当前：{enabled ? '已开放手工作业' : '手工作业关闭'}</p>
          {!enabled ? (
            <Alert>
              <AlertDescription>出厂关闭。打开前先确认安全依据和账号会话。</AlertDescription>
            </Alert>
          ) : null}
          {canMaintain ? (
            <div className='space-y-3'>
              <div className='space-y-2'>
                <Label htmlFor='job-policy-reason'>政策理由</Label>
                <Input
                  id='job-policy-reason'
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder='说明为何开放或关闭'
                />
              </div>
              {!enabled && accounts.length === 0 ? (
                <p className='text-label text-muted-foreground'>{MAP_ACCOUNT_REQUIRED}</p>
              ) : null}
              <Button
                disabled={policyMutation.isPending || !reason.trim() || (!enabled && accounts.length === 0)}
                onClick={() => policyMutation.mutate(!enabled)}
              >
                {enabled ? '关闭手工作业' : '开放手工作业'}
              </Button>
              <div className='space-y-2 border-t border-border-divider pt-3'>
                <h3 className='text-body font-medium'>安全进入路径</h3>
                {entries.length === 0 ? (
                  <p className='text-label text-muted-foreground'>还没有安全进入路径。</p>
                ) : (
                  <ul className='space-y-1 text-body'>
                    {entries.map((entry) => (
                      <li key={entry.entryId}>
                        {entry.name} · {entry.url}
                      </li>
                    ))}
                  </ul>
                )}
                <Label htmlFor='entry-name'>路径名称</Label>
                <Input id='entry-name' value={entryName} onChange={(event) => setEntryName(event.target.value)} />
                <Label htmlFor='entry-url'>进入 URL</Label>
                <Input id='entry-url' value={entryUrl} onChange={(event) => setEntryUrl(event.target.value)} />
                <Label htmlFor='arrival-name'>到达断言</Label>
                <Input id='arrival-name' value={arrivalName} onChange={(event) => setArrivalName(event.target.value)} />
                <p className='text-label text-muted-foreground'>按标题、菜单项、链接、按钮依次匹配，不必是页面标题。</p>
                <Label htmlFor='entry-summary'>安全依据</Label>
                <Input id='entry-summary' value={summary} onChange={(event) => setSummary(event.target.value)} />
                <Button
                  disabled={
                    entryMutation.isPending || !entryName.trim() || !entryUrl.trim() || !arrivalName.trim() || !summary.trim()
                  }
                  onClick={() => entryMutation.mutate()}
                >
                  登记进入路径
                </Button>
              </div>
              <div className='space-y-2 border-t border-border-divider pt-3'>
                <h3 className='text-body font-medium'>手工触发</h3>
                <Label htmlFor='job-kind'>作业类型</Label>
                <select
                  id='job-kind'
                  className='flex h-10 w-full rounded-md border border-input bg-background px-3 text-body'
                  value={jobKind}
                  onChange={(event) => {
                    setJobKind(event.target.value as MapJobKind)
                    setEntryId('')
                  }}
                >
                  <option value='map_probe'>探查入口</option>
                  <option value='map_refresh'>复查所选</option>
                </select>
                <Label htmlFor='job-account'>目标账号</Label>
                <select
                  id='job-account'
                  className='flex h-10 w-full rounded-md border border-input bg-background px-3 text-body'
                  value={accountId}
                  onChange={(event) => setAccountId(event.target.value)}
                >
                  <option value=''>选择账号</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.displayName}
                    </option>
                  ))}
                </select>
                {accounts.length === 0 ? (
                  <p className='text-label text-muted-foreground'>{MAP_ACCOUNT_REQUIRED}</p>
                ) : null}
                <Label htmlFor='job-entry'>进入路径</Label>
                <select
                  id='job-entry'
                  className='flex h-10 w-full rounded-md border border-input bg-background px-3 text-body'
                  value={entryId}
                  onChange={(event) => setEntryId(event.target.value)}
                >
                  <option value=''>选择路径</option>
                  {kindEntries.map((entry) => (
                    <option key={entry.entryId} value={entry.entryId}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                {entries.length > 0 && kindEntries.length === 0 ? (
                  <p className='text-label text-muted-foreground'>没有适用于当前作业类型的进入路径。</p>
                ) : null}
                <div className='flex flex-wrap gap-2'>
                  <Button
                    variant='outline'
                    disabled={previewMutation.isPending || !accountId || !entryId}
                    onClick={() => previewMutation.mutate()}
                  >
                    预览范围
                  </Button>
                  <Button
                    disabled={createMutation.isPending || !enabled || !accountId || !entryId}
                    onClick={() => createMutation.mutate()}
                  >
                    {KIND_LABELS[jobKind]}
                  </Button>
                </div>
                {previewMutation.data ? (
                  <ul className='space-y-1 text-label text-muted-foreground'>
                    {previewMutation.data.items.map((item) => (
                      <li key={`${item.assetRef.objectId ?? item.assetRef.pageId}:${item.reason}`}>
                        {item.included ? '纳入' : '未纳入'} {item.name} · {item.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {createMutation.data ? (
                  <p className='text-body'>
                    作业 {createMutation.data.job.jobStatus}
                    {createMutation.data.job.firstRunId
                      ? ` · 首片运行 ${createMutation.data.job.firstRunId.slice(0, 8)}`
                      : ''}
                  </p>
                ) : null}
              </div>
            </div>
          ) : (
            <p className='text-label text-muted-foreground'>需要地图维护权限才能触发作业。</p>
          )}
        </>
      ) : null}
    </section>
  )
}
