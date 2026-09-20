import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { fetchEvidenceDetail } from '@/lib/evidence-api'
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

  return (
    <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
      <PageHeader
        parent={
          <Link to='/evidence' search={search} className='inline-flex items-center gap-1.5 hover:text-link'>
            <ArrowLeft className='size-4' />
            返回证据中心
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
