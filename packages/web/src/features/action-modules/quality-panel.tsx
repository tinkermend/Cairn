import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { ActionModuleVersionDto, ModuleQualityWindowDays } from '@cairn/shared'
import { QueryErrorState } from '@/components/query-error-state'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { fetchActionModuleQuality, fetchModuleInvocations } from '@/lib/action-modules-api'
import { ModuleHealthBadge, healthHint } from './health-badge'

const OUTCOME_LABELS: Record<string, string> = {
  VERIFIED: '已验证',
  FAILED_IMPLEMENTATION: '实现失败',
  FAILED_VERIFICATION: '验证失败',
  NEEDS_REVIEW: '待核查',
  NOT_REACHED: '未执行',
  CANCELLED: '已取消',
  UNKNOWN: '未知',
}

const ATTRIBUTION_LABELS: Record<string, string> = {
  MODULE: '模块',
  EXTERNAL_INFRA: '外部基础设施',
  UPSTREAM: '上游',
  UNKNOWN: '未知',
}

export function ActionModuleQualityPanel({
  moduleId,
  versions,
}: {
  moduleId: string
  versions: ActionModuleVersionDto[]
}) {
  const [versionId, setVersionId] = useState('all')
  const [windowDays, setWindowDays] = useState<ModuleQualityWindowDays>(7)
  const [page, setPage] = useState(1)
  const query = useMemo(
    () => ({
      versionId: versionId === 'all' ? undefined : versionId,
      window: windowDays,
      groupBy: 'account' as const,
    }),
    [versionId, windowDays],
  )
  const quality = useQuery({
    queryKey: ['action-module-quality', moduleId, query],
    queryFn: () => fetchActionModuleQuality(moduleId, query),
  })
  const invocations = useQuery({
    queryKey: ['action-module-invocations', moduleId, query.versionId, page],
    queryFn: () => fetchModuleInvocations(moduleId, { versionId: query.versionId, page, pageSize: 20 }),
  })

  if (quality.isError) {
    return <QueryErrorState description={quality.error.message} onRetry={() => void quality.refetch()} />
  }
  if (quality.isLoading || !quality.data) {
    return <p className='text-body text-muted-foreground'>正在加载运行质量…</p>
  }

  const data = quality.data
  const items = invocations.data?.items ?? []
  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-end gap-3'>
        <label className='space-y-1 text-body'>
          版本
          <Select
            value={versionId}
            onValueChange={(value) => {
              setVersionId(value)
              setPage(1)
            }}
          >
            <SelectTrigger className='w-44' aria-label='质量版本'>
              <SelectValue placeholder='全部版本' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>全部版本</SelectItem>
              {versions.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  v{item.versionNo}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className='space-y-1 text-body'>
          窗口
          <Select
            value={String(windowDays)}
            onValueChange={(value) => {
              setWindowDays(Number(value) as ModuleQualityWindowDays)
              setPage(1)
            }}
          >
            <SelectTrigger className='w-28' aria-label='质量窗口'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='7'>7 天</SelectItem>
              <SelectItem value='30'>30 天</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <ModuleHealthBadge health={data.health} />
      </div>
      <p className='text-label text-muted-foreground' title={healthHint(data.health)}>
        统计截至 {new Date(data.asOf).toLocaleString()} · 配置修订 {data.configRevision}
        {data.pendingBackfill > 0 ? ` · 待补算 ${data.pendingBackfill}` : ''}
        {data.health.verificationInsufficient ? ' · 验证强度不足，不参与退化判定' : ''}
      </p>
      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <div className='space-y-1.5 rounded-xl border border-card bg-card p-4 shadow-card'>
          <p className='text-label font-medium text-muted-foreground'>正式调用</p>
          <div className='text-stat font-semibold tracking-tight text-foreground'>
            {data.overall.calls}
          </div>
          <p className='text-label text-muted-foreground'>
            经重试成功 {data.overall.retriedSuccess}
            {data.trial.calls > 0 ? ` · 试跑 ${data.trial.calls}` : ''}
          </p>
        </div>
        <div className='space-y-1.5 rounded-xl border border-card bg-card p-4 shadow-card'>
          <p className='text-label font-medium text-muted-foreground'>验证通过率</p>
          <div className='text-stat font-semibold tracking-tight text-foreground'>
            {data.overall.verifiedRate === null ? '—' : `${(data.overall.verifiedRate * 100).toFixed(0)}%`}
          </div>
          <p className='text-label text-muted-foreground'>
            通过率 {data.overall.verifiedRate === null ? '样本不足' : `${(data.overall.verifiedRate * 100).toFixed(0)}%`}（样本 {data.overall.sampleCount}）
          </p>
        </div>
        <div className='space-y-1.5 rounded-xl border border-card bg-card p-4 shadow-card'>
          <p className='text-label font-medium text-muted-foreground'>响应延迟 (P50)</p>
          <div className='text-stat font-semibold tracking-tight text-foreground'>
            {data.overall.durationMsP50 ?? '—'} <span className='text-body font-normal text-muted-foreground'>ms</span>
          </div>
          <p className='text-label text-muted-foreground'>
            耗时中位 {data.overall.durationMsP50 ?? '—'} ms · p95 {data.overall.durationMsP95 ?? '—'} ms
          </p>
        </div>
        <div className='space-y-1.5 rounded-xl border border-card bg-card p-4 shadow-card'>
          <p className='text-label font-medium text-muted-foreground'>异常与未执行</p>
          <div className='text-stat font-semibold tracking-tight text-foreground'>
            {data.overall.externalInfra + data.overall.notReached + data.overall.cancelled + data.overall.needsReview}
          </div>
          <p className='text-label text-muted-foreground truncate' title={`外部原因 ${data.overall.externalInfra} · 未执行 ${data.overall.notReached} · 取消 ${data.overall.cancelled} · 待核查 ${data.overall.needsReview}`}>
            外部原因 {data.overall.externalInfra} · 未执行 {data.overall.notReached} · 取消 {data.overall.cancelled} · 待核查 {data.overall.needsReview}
          </p>
        </div>
      </div>
      {(data.overall.aiCalls > 0 || Boolean(data.overall.aiCost) || Boolean(data.fallback)) && (
        <div className='flex flex-wrap items-center gap-4 rounded-lg border bg-muted/20 px-4 py-2 text-body text-muted-foreground'>
          {data.overall.aiCalls > 0 ? (
            <span>
              AI 调用 {data.overall.aiCalls}
              {data.overall.aiCost !== null ? ` · 成本 ${data.overall.aiCost}` : ''}
            </span>
          ) : null}
          {data.fallback ? (
            <span>
              回退发生 {data.fallback.occurred} 次 · 回退后成功 {data.fallback.succeeded} 次
            </span>
          ) : null}
        </div>
      )}
      {data.implementations && data.implementations.length > 0 ? (
        <div className='overflow-x-auto rounded-xl border'>
          <table className='w-full min-w-[28rem] text-left text-body'>
            <thead>
              <tr className='border-b text-label text-muted-foreground'>
                <th className='p-3 font-medium'>实现</th>
                <th className='p-3 font-medium'>正式调用</th>
                <th className='p-3 font-medium'>通过率</th>
              </tr>
            </thead>
            <tbody>
              {data.implementations.map((item) => (
                <tr key={item.implementationKey} className='border-b last:border-0'>
                  <td className='p-3 font-mono'>{item.implementationKey}</td>
                  <td className='p-3'>{item.calls}</td>
                  <td className='p-3'>
                    {item.verifiedRate === null ? '样本不足' : `${(item.verifiedRate * 100).toFixed(0)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data.trial.calls > 0 ? (
        <p className='text-body text-muted-foreground'>
          试跑调用 {data.trial.calls}（单独统计，不计入正式通过率）
        </p>
      ) : null}
      {data.accounts && data.accounts.length > 0 ? (
        <div className='overflow-x-auto rounded-xl border'>
          <table className='w-full min-w-[28rem] text-left text-body'>
            <thead>
              <tr className='border-b text-label text-muted-foreground'>
                <th className='p-3 font-medium'>账号</th>
                <th className='p-3 font-medium'>正式调用</th>
                <th className='p-3 font-medium'>通过率</th>
              </tr>
            </thead>
            <tbody>
              {data.accounts.map((account) => (
                <tr key={account.targetAccountId ?? 'none'} className='border-b last:border-0'>
                  <td className='p-3'>{account.targetAccountId ?? '未指定账号'}</td>
                  <td className='p-3'>{account.calls}</td>
                  <td className='p-3'>
                    {account.verifiedRate === null ? '样本不足' : `${(account.verifiedRate * 100).toFixed(0)}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {invocations.isError ? (
        <QueryErrorState description={invocations.error.message} onRetry={() => void invocations.refetch()} />
      ) : items.length === 0 ? (
        <div className='rounded-xl border border-dashed border-border-default bg-card/40 p-8 text-center'>
          <p className='text-body text-muted-foreground'>还没有可展示的模块调用结果。</p>
        </div>
      ) : (
        <div className='overflow-x-auto rounded-xl border'>
          <table className='w-full min-w-[40rem] text-left text-body'>
            <thead>
              <tr className='border-b text-label text-muted-foreground'>
                <th className='p-3 font-medium'>结果</th>
                <th className='p-3 font-medium'>归因</th>
                <th className='p-3 font-medium'>说明</th>
                <th className='p-3 font-medium'>时间</th>
                <th className='p-3 font-medium'>运行</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={`${item.runId}:${item.invocationId}`} className='border-b last:border-0'>
                  <td className='p-3'>{OUTCOME_LABELS[item.outcome] ?? item.outcome}</td>
                  <td className='p-3'>{ATTRIBUTION_LABELS[item.attribution] ?? item.attribution}</td>
                  <td className='p-3 text-muted-foreground'>
                    {[
                      item.manualRequirementsUnverified > 0
                        ? `人工说明未验证 ${item.manualRequirementsUnverified} 项`
                        : null,
                      item.verificationStrength === 'insufficient' ? '验证强度不足' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </td>
                  <td className='p-3'>{item.finishedAt ? new Date(item.finishedAt).toLocaleString() : '—'}</td>
                  <td className='p-3'>
                    <Button variant='link' className='h-auto p-0' asChild>
                      <Link to='/runs/$runId' params={{ runId: item.runId }} search={{ invocation: item.invocationId }}>
                        打开运行
                      </Link>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {invocations.data && invocations.data.total > invocations.data.pageSize ? (
        <div className='flex items-center gap-2'>
          <Button variant='outline' disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
            上一页
          </Button>
          <span className='text-label text-muted-foreground'>第 {invocations.data.page} 页</span>
          <Button
            variant='outline'
            disabled={page * invocations.data.pageSize >= invocations.data.total}
            onClick={() => setPage((current) => current + 1)}
          >
            下一页
          </Button>
        </div>
      ) : null}
    </div>
  )
}
