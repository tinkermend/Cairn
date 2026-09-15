import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import type { RecordingItem } from '@cairn/shared'
import { hasPermission } from '@cairn/shared'
import { deleteRecording, fetchRecording } from '@/lib/recordings-api'
import { useAuthStore } from '@/stores/auth-store'
import { AppHeader } from '@/components/layout/app-header'
import { Main } from '@/components/layout/main'
import { PageHeader } from '@/components/layout/page-header'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { ResourceDeleteDialog } from '@/components/resource-delete-dialog'
import { Button } from '@/components/ui/button'
import { RecordingRenameDialog } from './rename-dialog'

const STATUS_LABEL: Record<RecordingItem['status'], string> = {
  mapped: '已映射',
  parameterized: '待补参数',
  unresolved: '待处理',
}

export function RecordingDetailPage() {
  const { recordingId } = useParams({ from: '/_authenticated/recordings/$recordingId/' })
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.auth.user)
  const isAdmin = Boolean(user?.roles.includes('admin'))
  const query = useQuery({
    queryKey: ['recordings', recordingId],
    queryFn: () => fetchRecording(recordingId),
  })
  const draft = query.data
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const canWrite =
    Boolean(draft) &&
    hasPermission(user?.permissions ?? [], 'workflow:write') &&
    (isAdmin || draft?.createdBy.id === user?.id)
  const canDelete =
    Boolean(draft) &&
    hasPermission(user?.permissions ?? [], 'workflow:delete') &&
    (isAdmin || draft?.createdBy.id === user?.id)

  return (
    <>
      <AppHeader fixed />
      <Main className='flex min-w-0 flex-1 flex-col gap-4 sm:gap-6'>
        <PageHeader
          title={draft?.name ?? '录制草稿'}
          description='来自识途录制器的操作序列。可重命名、删除，或前往已回填的场景继续编辑。'
          actions={
            draft ? (
              <div className='flex flex-wrap gap-2'>
                {canWrite ? (
                  <Button variant='outline' onClick={() => setRenaming(true)}>
                    重命名
                  </Button>
                ) : null}
                {canDelete ? (
                  <Button variant='ghost' className='text-destructive' onClick={() => setRemoving(true)}>
                    删除
                  </Button>
                ) : null}
              </div>
            ) : null
          }
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
            {draft.imported && draft.importedScenarioId ? (
              <p className='text-body'>
                已回填到场景，原始录制删除不会改写已导入步骤。
                <Link
                  to='/scenarios/$scenarioId'
                  params={{ scenarioId: draft.importedScenarioId }}
                  search={{ import: draft.id }}
                  className='ms-2 text-primary hover:underline'
                >
                  前往对应 Studio
                </Link>
              </p>
            ) : (
              <p className='text-body text-muted-foreground'>尚未回填到场景。</p>
            )}
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
      <RecordingRenameDialog
        open={renaming}
        onOpenChange={setRenaming}
        recording={draft ?? null}
        onRenamed={() => {
          setRenaming(false)
          void queryClient.invalidateQueries({ queryKey: ['recordings', recordingId] })
        }}
      />
      <ResourceDeleteDialog
        open={removing}
        onOpenChange={setRemoving}
        resourceId={recordingId}
        resourceName={draft?.name ?? ''}
        resourceType='recording'
        deleteFn={() => deleteRecording(recordingId)}
        onSuccess={() => {
          setRemoving(false)
          void queryClient.invalidateQueries({ queryKey: ['recordings'] })
          void navigate({ to: '/recordings' })
        }}
      />
    </>
  )
}
