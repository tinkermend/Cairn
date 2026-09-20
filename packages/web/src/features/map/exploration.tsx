import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { arrivalTargetForName } from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  createExploration,
  createMapSafeEntry,
  fetchExplorationPolicy,
  fetchMapSafeEntries,
  previewExploration,
  updateExplorationPolicy,
} from '@/lib/map-api'
import { fetchPlatformConfig } from '@/lib/platform-config-api'
import { fetchTargetAccounts } from '@/lib/targets-api'
import { MAP_ACCOUNT_REQUIRED, mapCapableAccounts } from './map-accounts'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function ExplorationCard({ targetId }: { targetId: string }) {
  const canRead = useCan('map:read')
  const canExplore = useCan('map:explore')
  const canMaintain = useCan('map:maintain')
  const canWrite = canExplore && canMaintain
  const queryClient = useQueryClient()
  const [reason, setReason] = useState('')
  const [origin, setOrigin] = useState('')
  const [pathPrefix, setPathPrefix] = useState('')
  const [accountId, setAccountId] = useState('')
  const [entryId, setEntryId] = useState('')
  const [entryName, setEntryName] = useState('')
  const [entryUrl, setEntryUrl] = useState('')
  const [arrivalName, setArrivalName] = useState('')
  const [summary, setSummary] = useState('')
  const configQuery = useQuery({
    queryKey: ['platform-config'],
    queryFn: fetchPlatformConfig,
    enabled: canRead,
  })
  const policyQuery = useQuery({
    queryKey: ['map', targetId, 'exploration-policy'],
    queryFn: () => fetchExplorationPolicy(targetId),
    enabled: canRead,
  })
  const entriesQuery = useQuery({
    queryKey: ['map', targetId, 'safe-entries'],
    queryFn: () => fetchMapSafeEntries(targetId),
    enabled: canRead,
  })
  const accountsQuery = useQuery({
    queryKey: ['target', targetId, 'accounts', 'explore'],
    queryFn: () => fetchTargetAccounts(targetId, { status: 'active', limit: 50 }),
    enabled: canWrite,
  })
  const policyMutation = useMutation({
    mutationFn: (exploreEnabled: boolean) =>
      updateExplorationPolicy(targetId, {
        expectedRevision: policyQuery.data?.revision ?? 0,
        idempotencyKey: `explore-policy:${Date.now()}`,
        exploreEnabled,
        mode: policyQuery.data?.policy.mode ?? 'allowlist',
        modelEnabled: false,
        allowlist: origin.trim()
          ? [{ origin: origin.trim(), ...(pathPrefix.trim() ? { pathPrefix: pathPrefix.trim() } : {}) }]
          : (policyQuery.data?.policy.allowlist ?? []),
        seedRefs: policyQuery.data?.policy.seedRefs ?? [],
        reason: reason.trim() || (exploreEnabled ? '开放有界探索' : '关闭有界探索'),
      }),
    onSuccess: () => {
      toast.success('已更新探索政策')
      setReason('')
      void queryClient.invalidateQueries({ queryKey: ['map', targetId, 'exploration-policy'] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '更新探索政策失败')
    },
  })
  const entryMutation = useMutation({
    mutationFn: () =>
      createMapSafeEntry(targetId, {
        idempotencyKey: `explore-entry:${Date.now()}`,
        name: entryName.trim(),
        url: entryUrl.trim(),
        arrivalName: arrivalName.trim(),
        arrivalTarget: arrivalTargetForName(arrivalName),
        safetyBasisKind: 'confirmed_path',
        summary: summary.trim(),
        jobKinds: ['map_explore'],
      }),
    onSuccess: () => {
      toast.success('已登记探索进入路径')
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
    mutationFn: () => previewExploration(targetId, { targetAccountId: accountId, entryId, selectedAssetRefs: [] }),
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '预览探索失败')
    },
  })
  const createMutation = useMutation({
    mutationFn: () =>
      createExploration(targetId, {
        manualId: `explore-${Date.now()}`,
        expectedExplorationRevision: policyQuery.data?.revision ?? 0,
        targetAccountId: accountId,
        entryId,
        selectedAssetRefs: [],
      }),
    onSuccess: (result) => {
      toast.success(result.created ? '已创建探索作业' : '已返回相同作业')
      void queryClient.invalidateQueries({ queryKey: ['map', targetId] })
    },
    onError: (error) => {
      toast.error(error instanceof ApiRequestError ? error.message : '创建探索作业失败')
    },
  })

  if (!canRead) return null
  const factoryOn = configQuery.data?.document.mapExplorationEnabled === true
  const enabled = policyQuery.data?.policy.exploreEnabled === true
  const entries = (entriesQuery.data?.items ?? []).filter((entry) => entry.jobKinds.includes('map_explore'))
  const accounts = mapCapableAccounts(accountsQuery.data?.items ?? [])

  return (
    <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <h2 className='text-section font-semibold'>有界探索</h2>
      <p className='text-label text-muted-foreground'>
        出厂关闭。只在 allowlist 内做一轮只读观察，成功也不升可信。
      </p>
      {policyQuery.isPending ? (
        <p className='text-label text-muted-foreground'>探索政策加载中…</p>
      ) : policyQuery.isError ? (
        <p className='text-label text-muted-foreground'>暂时无法读取探索政策。</p>
      ) : (
        <>
          <p className='text-body'>
            当前：{factoryOn ? '平台已开放' : '平台关闭'} · {enabled ? '该目标已开放' : '该目标关闭'}
          </p>
          {!factoryOn || !enabled ? (
            <Alert>
              <AlertDescription>
                需要同时打开平台探索开关和本目标探索政策，并登记含 map_explore 的安全进入路径。
              </AlertDescription>
            </Alert>
          ) : null}
          {canWrite ? (
            <div className='space-y-3'>
              <div className='space-y-2'>
                <Label htmlFor='explore-reason'>政策理由</Label>
                <Input
                  id='explore-reason'
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder='说明为何开放或关闭'
                />
              </div>
              <Label htmlFor='explore-origin'>Allowlist origin</Label>
              <Input
                id='explore-origin'
                value={origin}
                onChange={(event) => setOrigin(event.target.value)}
                placeholder='https://shop.example'
              />
              <Label htmlFor='explore-prefix'>可选 pathPrefix</Label>
              <Input
                id='explore-prefix'
                value={pathPrefix}
                onChange={(event) => setPathPrefix(event.target.value)}
                placeholder='/orders'
              />
              <p className='text-label text-muted-foreground'>`/orders` 含 `/orders/1`，不含 `/orders-admin`。</p>
              <Button
                disabled={policyMutation.isPending || !reason.trim()}
                onClick={() => policyMutation.mutate(!enabled)}
              >
                {enabled ? '关闭该目标探索' : '开放该目标探索'}
              </Button>
              <div className='space-y-2 border-t border-border-divider pt-3'>
                <h3 className='text-body font-medium'>探索进入路径</h3>
                {entries.length === 0 ? (
                  <p className='text-label text-muted-foreground'>还没有适用于探索的安全进入路径。</p>
                ) : (
                  <ul className='space-y-1 text-body'>
                    {entries.map((entry) => (
                      <li key={entry.entryId}>
                        {entry.name} · {entry.url}
                      </li>
                    ))}
                  </ul>
                )}
                <Label htmlFor='explore-entry-name'>路径名称</Label>
                <Input id='explore-entry-name' value={entryName} onChange={(event) => setEntryName(event.target.value)} />
                <Label htmlFor='explore-entry-url'>进入 URL</Label>
                <Input id='explore-entry-url' value={entryUrl} onChange={(event) => setEntryUrl(event.target.value)} />
                <Label htmlFor='explore-arrival-name'>到达断言</Label>
                <Input
                  id='explore-arrival-name'
                  value={arrivalName}
                  onChange={(event) => setArrivalName(event.target.value)}
                />
                <Label htmlFor='explore-entry-summary'>安全依据</Label>
                <Input id='explore-entry-summary' value={summary} onChange={(event) => setSummary(event.target.value)} />
                <Button
                  disabled={
                    entryMutation.isPending ||
                    !entryName.trim() ||
                    !entryUrl.trim() ||
                    !arrivalName.trim() ||
                    !summary.trim()
                  }
                  onClick={() => entryMutation.mutate()}
                >
                  登记探索进入路径
                </Button>
              </div>
              <div className='space-y-2 border-t border-border-divider pt-3'>
                <h3 className='text-body font-medium'>手工触发</h3>
                <Label htmlFor='explore-account'>目标账号</Label>
                <select
                  id='explore-account'
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
                <Label htmlFor='explore-entry'>进入路径</Label>
                <select
                  id='explore-entry'
                  className='flex h-10 w-full rounded-md border border-input bg-background px-3 text-body'
                  value={entryId}
                  onChange={(event) => setEntryId(event.target.value)}
                >
                  <option value=''>选择路径</option>
                  {entries.map((entry) => (
                    <option key={entry.entryId} value={entry.entryId}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                <div className='flex flex-wrap gap-2'>
                  <Button
                    variant='outline'
                    disabled={previewMutation.isPending || !accountId || !entryId}
                    onClick={() => previewMutation.mutate()}
                  >
                    预览探索范围
                  </Button>
                  <Button
                    disabled={createMutation.isPending || !factoryOn || !enabled || !accountId || !entryId}
                    onClick={() => createMutation.mutate()}
                  >
                    开始探索
                  </Button>
                </div>
                {previewMutation.data ? (
                  <ul className='space-y-1 text-label text-muted-foreground'>
                    {previewMutation.data.items.map((item) => (
                      <li key={`${item.name}:${item.reason}`}>
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
            <p className='text-label text-muted-foreground'>需要探索和维护权限才能触发探索。</p>
          )}
        </>
      )}
    </section>
  )
}
