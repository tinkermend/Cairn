import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { ModuleBatchUpgradeResponse } from '@cairn/shared'
import { latestSelectableVersion } from '@cairn/shared'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { QueryErrorState } from '@/components/query-error-state'
import {
  batchUpgradeActionModuleDrafts,
  fetchActionModuleQuality,
  fetchActionModuleReferences,
  fetchActionModuleVersions,
} from '@/lib/action-modules-api'
import { ModuleUpgradeDialog } from './upgrade-dialog'
import { ModuleHealthBadge } from './health-badge'

const BATCH_STATUS = { upgraded: '已升级', skipped: '已跳过', conflict: '冲突' } as const

export function ActionModuleReferencesPanel({ moduleId }: { moduleId: string }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const refs = useQuery({
    queryKey: ['action-module-references', moduleId],
    queryFn: () => fetchActionModuleReferences(moduleId, { page: 1, pageSize: 50 }),
  })
  const versions = useQuery({
    queryKey: ['action-module-versions', moduleId],
    queryFn: () => fetchActionModuleVersions(moduleId),
  })
  const quality = useQuery({
    queryKey: ['action-module-quality', moduleId],
    queryFn: () => fetchActionModuleQuality(moduleId, { window: 7 }),
  })
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [batch, setBatch] = useState<ModuleBatchUpgradeResponse | null>(null)
  const [upgrade, setUpgrade] = useState<{ scenarioId: string; invocationId: string } | null>(null)
  const latest = latestSelectableVersion(versions.data?.items ?? [])
  const rows = refs.data?.items ?? []
  const userRows = useMemo(() => rows.filter((item) => item.purpose === 'user'), [rows])
  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => (checked ? [...current, id] : current.filter((item) => item !== id)))
  }
  const runBatch = async () => {
    if (!latest || selected.length === 0) return
    setBusy(true)
    try {
      const result = await batchUpgradeActionModuleDrafts(moduleId, {
        toVersionId: latest.id,
        scenarioIds: selected,
        idempotencyKey: crypto.randomUUID(),
      })
      setBatch(result)
      const upgraded = result.results.filter((item) => item.status === 'upgraded').length
      toast.message(`批量升级完成：${upgraded} 个成功，${result.results.length - upgraded} 个跳过或冲突`)
      await client.invalidateQueries({ queryKey: ['action-module-references', moduleId] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批量升级失败')
    } finally {
      setBusy(false)
    }
  }
  if (refs.isLoading) return <p className='text-body text-muted-foreground'>正在加载引用…</p>
  if (refs.isError) {
    return <QueryErrorState description={refs.error.message} onRetry={() => void refs.refetch()} />
  }
  if (rows.length === 0) {
    return (
      <div className='rounded-xl border border-dashed p-8 text-center bg-card/40'>
        <p className='text-body text-muted-foreground'>还没有场景引用这个模块。</p>
      </div>
    )
  }
  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card/60 px-4 py-3'>
        <div className='flex items-center gap-3'>
          <span className='text-body font-medium'>
            {latest ? `最新可选版本 v${latest.versionNo}` : '没有可升级的版本'}
          </span>
          <ModuleHealthBadge health={quality.data?.health} />
        </div>
        <Button disabled={!latest || selected.length === 0 || busy} onClick={() => void runBatch()}>
          {busy ? '处理中…' : `批量升级已选（${selected.length}）`}
        </Button>
      </div>
      <div className='overflow-x-auto rounded-xl border border-card bg-card shadow-card'>
        <table className='w-full min-w-[40rem] text-left text-body'>
          <thead>
            <tr className='border-b bg-surface-header text-label text-muted-foreground'>
              <th className='p-3 font-medium'>选择</th>
              <th className='p-3 font-medium'>场景</th>
              <th className='p-3 font-medium'>草稿</th>
              <th className='p-3 font-medium'>已发布</th>
              <th className='p-3 font-medium'>最近运行</th>
              <th className='p-3 font-medium'>操作</th>
            </tr>
          </thead>
          <tbody className='divide-y'>
            {rows.map((item) => (
              <tr key={item.scenarioId} className='hover:bg-muted/30 transition-[background-color]'>
                <td className='p-3'>
                  {item.purpose === 'user' ? (
                    <Checkbox
                      aria-label={`选择 ${item.name}`}
                      checked={selected.includes(item.scenarioId)}
                      onCheckedChange={(value) => toggle(item.scenarioId, value === true)}
                    />
                  ) : (
                    <span className='text-label text-muted-foreground'>验证</span>
                  )}
                </td>
                <td className='p-3'>
                  <button
                    type='button'
                    className='text-left font-medium text-foreground underline-offset-2 hover:underline'
                    onClick={() => void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId: item.scenarioId } })}
                  >
                    {item.name}
                  </button>
                  <p className='text-label text-muted-foreground'>
                    {item.status}{item.purpose !== 'user' ? ' · 验证场景' : ''}
                  </p>
                </td>
                <td className='p-3 font-mono text-small'>
                  {item.draftUses.map((use) => (use.versionNo ? `v${use.versionNo}` : `草稿 r${use.moduleDraftRevision ?? '?'}`)).join('、') || '—'}
                </td>
                <td className='p-3 font-mono text-small'>{item.publishedUses.map((use) => `v${use.versionNo}`).join('、') || '—'}</td>
                <td className='p-3 text-small'>{item.lastRun ? item.lastRun.status : '无'}</td>
                <td className='p-3'>
                  {item.upgradeAvailable && item.draftUses[0] && latest ? (
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => setUpgrade({ scenarioId: item.scenarioId, invocationId: item.draftUses[0]!.invocationId })}
                    >
                      升级
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {batch ? (
        <section className='space-y-2 rounded-xl border p-4'>
          <h3 className='text-section font-semibold'>批量结果</h3>
          {batch.results.map((item) => {
            const name = rows.find((row) => row.scenarioId === item.scenarioId)?.name ?? item.scenarioId
            return (
              <div key={item.scenarioId} className='flex flex-wrap items-center justify-between gap-2 text-body'>
                <button
                  type='button'
                  className='text-left underline-offset-2 hover:underline'
                  onClick={() => void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId: item.scenarioId } })}
                >
                  {name}
                </button>
                <span>
                  {BATCH_STATUS[item.status]}
                  {item.reason ? ` · ${item.reason}` : ''}
                </span>
              </div>
            )
          })}
        </section>
      ) : null}
      {upgrade && latest ? (
        <ModuleUpgradeDialog
          open
          onOpenChange={(open) => {
            if (!open) setUpgrade(null)
          }}
          scenarioId={upgrade.scenarioId}
          invocationId={upgrade.invocationId}
          toVersionId={latest.id}
          onUpgraded={async (scenarioId) => {
            setUpgrade(null)
            toast.success('草稿已升级')
            await client.invalidateQueries({ queryKey: ['action-module-references', moduleId] })
            void navigate({ to: '/scenarios/$scenarioId', params: { scenarioId } })
          }}
        />
      ) : null}
      {userRows.length === 0 ? <p className='text-label text-muted-foreground'>当前页只有验证场景。</p> : null}
    </div>
  )
}
