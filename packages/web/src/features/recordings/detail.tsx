import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import type { RecordingItem } from '@cairn/shared'
import { fetchRecording } from '@/lib/recordings-api'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'

const STATUS_LABEL: Record<RecordingItem['status'], string> = {
  mapped: '已映射',
  parameterized: '待补参数',
  unresolved: '待处理',
}

export function RecordingDetailPage() {
  const { recordingId } = useParams({ from: '/_authenticated/recordings/$recordingId/' })
  const query = useQuery({
    queryKey: ['recordings', recordingId],
    queryFn: () => fetchRecording(recordingId),
  })
  const draft = query.data

  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title={draft?.name ?? '录制草稿'}
          description='来自识途录制器的 IR。未解决项会阻止以后发布，本期只展示。'
        />
        {query.isPending ? (
          <PageSkeleton />
        ) : query.isError || !draft ? (
          <QueryErrorState title='无法加载录制草稿' onRetry={() => void query.refetch()} />
        ) : (
          <div className='space-y-4 rounded-lg border border-border-card bg-card p-5 shadow-card'>
            <p className='text-body text-muted-foreground'>
              目标系统{' '}
              <Link
                to='/targets/$targetId'
                params={{ targetId: draft.targetId }}
                className='text-primary hover:underline'
              >
                {draft.targetName}
              </Link>
              {' · '}
              {draft.itemCount} 步 · {draft.unresolvedCount} 项待处理 · {draft.sourceVersion}
            </p>
            {draft.diagnostics.length > 0 ? (
              <ul className='list-disc space-y-1 pl-5 text-body text-status-warning-foreground'>
                {draft.diagnostics.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
            <ol className='space-y-3'>
              {draft.items.map((item) => (
                <li key={`${item.index}-${item.sourceAction}`} className='rounded-md border border-border-card p-3'>
                  <p className='font-medium'>
                    {item.index + 1}. {item.name}
                  </p>
                  <p className='text-label text-muted-foreground'>
                    {STATUS_LABEL[item.status]}
                    {item.candidateStepType ? ` · ${item.candidateStepType}` : ''}
                    {item.sensitive ? ' · 敏感值已排除' : ''}
                    {item.framePath?.length ? ` · frame ${item.framePath.join(' > ')}` : ''}
                  </p>
                  {item.diagnostics.length > 0 ? (
                    <ul className='mt-2 list-disc pl-5 text-label text-status-warning-foreground'>
                      {item.diagnostics.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  ) : null}
                  {item.input !== undefined ? (
                    <pre className='mt-2 overflow-x-auto text-label'>{JSON.stringify(item.input, null, 2)}</pre>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        )}
      </Main>
    </>
  )
}
