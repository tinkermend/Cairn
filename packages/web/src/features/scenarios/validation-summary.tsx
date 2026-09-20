import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { SampleValidationState } from '@cairn/shared'
import { fetchScenarioValidation } from '@/lib/demonstrations-api'
import { useCan } from '@/hooks/use-permissions'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'

const labels: Record<SampleValidationState, string> = {
  not_run: '尚未试跑',
  running: '试跑中',
  sample_passed: '本次样本通过',
  failed: '本次样本失败',
  inconclusive: '样本不足以确认',
  stale: '旧版本样本',
}

export function ScenarioValidationSummary({
  scenarioId,
  revision,
  runUpdate,
  dirty,
}: {
  scenarioId: string
  revision: number
  runUpdate?: string
  dirty?: boolean
}) {
  const canRead = useCan('run:read')
  const canReadTarget = useCan('target:read')
  // SSE changes runUpdate; no periodic polling is needed.
  const query = useQuery({
    queryKey: ['scenario-validation', scenarioId, revision, runUpdate],
    queryFn: () => fetchScenarioValidation(scenarioId),
    enabled: canRead && canReadTarget,
  })
  if (!canRead || !canReadTarget) return null
  return (
    <section
      className='space-y-2 rounded-lg border border-border-card bg-card p-4'
      aria-label='试跑样本验证'
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <h3 className='text-body font-medium'>试跑样本验证</h3>
        <StatusBadge
          tone={
            query.data?.state === 'sample_passed' && !dirty
              ? 'success'
              : 'neutral'
          }
        >
          {dirty
            ? '草稿有未保存修改'
            : query.data
              ? labels[query.data.state]
              : query.isError
                ? '暂时无法读取'
                : '读取中'}
        </StatusBadge>
      </div>
      <p className='text-label text-muted-foreground'>
        通过仅适用于对应版本、输入、账号与运行配置的一次完整试跑。发布与上传不等于验证通过。
      </p>
      {dirty && (
        <p className='text-label text-status-warning-foreground'>
          下列结果对应已保存版本；保存修改后需要重新核对。
        </p>
      )}
      {query.isError && (
        <Button
          size='sm'
          variant='outline'
          onClick={() => void query.refetch()}
        >
          重试读取
        </Button>
      )}
      {query.data?.diagnostics.map((message) => (
        <p key={message} className='text-label'>
          {message}
        </p>
      ))}
      {query.data && query.data.samples.length > 0 && (
        <details>
          <summary className='cursor-pointer py-1 text-label'>
            最近样本（{query.data.samples.length}）
          </summary>
          <ol className='mt-2 space-y-2'>
            {query.data.samples.map((sample) => (
              <li
                key={sample.runId}
                className='rounded border border-border-divider p-3 text-label'
              >
                <div className='flex flex-wrap justify-between gap-2'>
                  <Link
                    className='text-link hover:underline'
                    to='/runs/$runId'
                    params={{ runId: sample.runId }}
                  >
                    {new Date(sample.createdAt).toLocaleString()}
                  </Link>
                  <span>{labels[sample.state]}</span>
                </div>
                <p>{sample.reasons.join('；')}</p>
                <p className='mt-1 text-muted-foreground'>
                  账号 {sample.targetAccountId?.slice(0, 8) ?? '未指定'} · 模型{' '}
                  {sample.modelName ?? '无 AI 模型'} · 配置版本{' '}
                  {sample.platformConfigRevision ?? '未记录'}
                </p>
                <details className='mt-1'>
                  <summary className='cursor-pointer text-muted-foreground'>
                    版本与范围标识
                  </summary>
                  <p className='break-all'>
                    定义：{sample.subjectDigest ?? '历史样本未记录'}
                    <br />
                    范围：{sample.executionScopeDigest ?? '未记录'}
                    <br />
                    输入：{sample.inputDigest ?? '未记录'}
                  </p>
                </details>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}
