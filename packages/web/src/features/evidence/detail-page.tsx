import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { fetchEvidenceDetail } from '@/lib/evidence-api'
import { useBreadcrumb } from '@/stores/breadcrumb-store'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { EvidenceDetailBody } from './detail-panel'

export function EvidenceDetailPage() {
  const { evidenceId } = useParams({ strict: false }) as { evidenceId: string }
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const detail = useQuery({
    queryKey: ['evidence', 'detail', evidenceId],
    queryFn: () => fetchEvidenceDetail(evidenceId),
  })

  useBreadcrumb({
    entityId: evidenceId,
    title: detail.data ? `证据 #${detail.data.item.evidence.id.slice(0, 8)}` : undefined,
  })

  const parentSearch = useMemo(() => {
    const params: Record<string, string> = { view: 'materials' }
    if (typeof search?.view === 'string') params.evidenceView = search.view
    if (typeof search?.runId === 'string') params.runId = search.runId
    if (typeof search?.targetId === 'string') params.targetId = search.targetId
    return params
  }, [search])

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
      <PageHeader
        parent={
          <Link to='/runs' search={parentSearch} className='inline-flex items-center gap-1.5 hover:text-link'>
            <ArrowLeft className='size-4' />
            返回证据列表
          </Link>
        }
        title='证据中心'
        description='单条证据的来源、可用性与仍可访问的内容。'
      />
      {detail.isPending ? (
        <PageSkeleton />
      ) : detail.isError || !detail.data ? (
        <QueryErrorState title='无法加载证据' onRetry={() => void detail.refetch()} />
      ) : (
        <section className='rounded-lg border border-border-card bg-card p-5 shadow-card'>
          <EvidenceDetailBody detail={detail.data} />
        </section>
      )}
    </Main>
  )
}
