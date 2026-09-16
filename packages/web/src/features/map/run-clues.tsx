import { useQuery } from '@tanstack/react-query'
import { fetchMapRunClues } from '@/lib/map-api'
import { useCan } from '@/hooks/use-permissions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { MAP_DIMENSION_LABELS } from './labels'

type RunMapCluesProps = {
  targetId: string
  runId: string
}

export function RunMapClues({ targetId, runId }: RunMapCluesProps) {
  const canReadMap = useCan('map:read')
  const canReadRun = useCan('run:read')
  const allowed = canReadMap && canReadRun
  const query = useQuery({
    queryKey: ['map', targetId, 'runs', runId, 'clues'],
    queryFn: () => fetchMapRunClues(targetId, runId),
    enabled: allowed,
  })

  if (!allowed) return null

  return (
    <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <h2 className='text-section font-semibold'>地图线索</h2>
      <p className='text-label text-muted-foreground'>按验证维度分列，不替代本次运行的步骤证据，也不归因改版。</p>
      {query.isPending ? (
        <p className='text-label text-muted-foreground'>线索加载中…</p>
      ) : query.isError ? (
        <p className='text-label text-muted-foreground'>暂时无法读取地图线索。本次运行证据仍以时间线为准。</p>
      ) : (
        <>
          <ul className='space-y-2'>
            {query.data.clues.map((clue) => (
              <li key={clue.dimension}>
                {MAP_DIMENSION_LABELS[clue.dimension] ?? clue.dimension}：{clue.verdict}
                {clue.notes.length ? ` · ${clue.notes.join('；')}` : ''}
              </li>
            ))}
          </ul>
          {query.data.hypotheses.length ? (
            <Alert>
              <AlertDescription>假设：{query.data.hypotheses.join('；')}</AlertDescription>
            </Alert>
          ) : null}
          {query.data.counterExamples.length ? (
            <p className='text-small'>反例：{query.data.counterExamples.join('；')}</p>
          ) : null}
          {query.data.gaps.length ? (
            <p className='text-small text-muted-foreground'>缺项：{query.data.gaps.join('；')}</p>
          ) : null}
        </>
      )}
    </section>
  )
}
