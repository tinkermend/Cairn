import { useQuery } from '@tanstack/react-query'
import { fetchScenarioResolutionStats } from '@/lib/scenarios-api'

export function ScenarioResolutionStats({ scenarioId }: { scenarioId: string }) {
  const query = useQuery({
    queryKey: ['scenarios', scenarioId, 'resolution-stats'],
    queryFn: () => fetchScenarioResolutionStats(scenarioId),
  })
  const items = query.data?.items ?? []
  if (query.isError) {
    return <p className='text-label text-muted-foreground'>解析兜底率暂时读不到。</p>
  }
  if (query.isLoading) return <p className='text-label text-muted-foreground'>正在读取解析兜底率…</p>
  if (items.length === 0) return null
  return (
    <section className='space-y-2' aria-label='解析兜底率'>
      <h3 className='text-label font-medium text-muted-foreground'>解析兜底率</h3>
      <ul className='space-y-1 text-small'>
        {items.map((item) => {
          const located = item.deterministic + item.map + item.ai
          const rate = item.fallbackRate == null ? '—' : `${Math.round(item.fallbackRate * 100)}%`
          return (
            <li key={`${item.stepId}-${item.scenarioVersionId}-${item.targetId}`}>
              AI {item.ai} / 命中 {located}（{rate}）· 失败 {item.failed}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
