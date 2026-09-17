import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  PlatformConfigCurrent,
  PlatformConfigRevision,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import {
  fetchPlatformConfigRevisions,
  restorePlatformConfig,
} from '@/lib/platform-config-api'
import { useCursorPage } from '@/hooks/use-cursor-page'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { CursorPagination } from '@/components/data-table'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'
import { TruncatedText } from '@/components/truncated-text'
import { formatTime } from './helpers'
import { SOURCE_LABELS } from './labels'

export function RevisionPanel({
  canWrite,
  expectedRevision,
  onRestored,
  onBusyChange,
}: {
  canWrite: boolean
  expectedRevision: number
  onRestored: (saved: PlatformConfigCurrent) => Promise<void>
  onBusyChange: (busy: boolean) => void
}) {
  const page = useCursorPage()
  const revisions = useQuery({
    queryKey: ['platform-config', 'revisions', page.cursor, page.pageSize],
    queryFn: () => fetchPlatformConfigRevisions(page.cursor, page.pageSize),
  })
  const [restoreReason, setRestoreReason] = useState('')
  const [busyId, setBusyId] = useState<string>()

  async function restore(item: PlatformConfigRevision) {
    const reason = restoreReason.trim()
    if (!reason) {
      toast.error('恢复旧配置也需要填写原因')
      return
    }
    setBusyId(item.id)
    onBusyChange(true)
    try {
      const saved = await restorePlatformConfig({
        revision: item.revision,
        expectedRevision,
        reason,
      })
      setRestoreReason('')
      toast.success(`已从修订 ${item.revision} 恢复为新修订`)
      await onRestored(saved)
      void revisions.refetch()
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : '恢复失败')
    } finally {
      setBusyId(undefined)
      onBusyChange(false)
    }
  }

  if (revisions.isPending) return <PageSkeleton />
  if (revisions.isError) {
    return (
      <QueryErrorState
        title='无法加载变更记录'
        onRetry={() => void revisions.refetch()}
      />
    )
  }

  return (
    <div className='space-y-4'>
      <p className='text-label text-muted-foreground'>
        恢复会创建新修订，不会改写旧运行。差异不含明文密钥。
      </p>
      {canWrite ? (
        <div className='space-y-2'>
          <Label htmlFor='restore-reason'>恢复原因</Label>
          <Textarea
            id='restore-reason'
            value={restoreReason}
            disabled={busyId !== undefined}
            onChange={(event) => setRestoreReason(event.target.value)}
            placeholder='说明为什么恢复这一版。'
          />
        </div>
      ) : null}
      {!revisions.data.items.length ? (
        <p className='text-body text-muted-foreground'>还没有变更记录。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>修订</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>原因</TableHead>
              <TableHead>差异</TableHead>
              <TableHead>时间</TableHead>
              {canWrite ? <TableHead>操作</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {revisions.data.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>{item.revision}</TableCell>
                <TableCell>{SOURCE_LABELS[item.source]}</TableCell>
                <TableCell>
                  <TruncatedText text={item.reason} />
                </TableCell>
                <TableCell>
                  <TruncatedText
                    text={
                      item.diff.length
                        ? item.diff.map((change) => change.path).join('、')
                        : '初始化'
                    }
                  />
                </TableCell>
                <TableCell>{formatTime(item.createdAt)}</TableCell>
                {canWrite ? (
                  <TableCell>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      loading={busyId === item.id}
                      disabled={busyId !== undefined}
                      onClick={() => void restore(item)}
                    >
                      恢复这一版
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <CursorPagination
        pageIndex={page.pageIndex}
        pageSize={page.pageSize}
        hasPreviousPage={page.pageIndex > 0}
        hasNextPage={Boolean(revisions.data.nextCursor)}
        updating={revisions.isFetching}
        onPageSizeChange={page.setPageSize}
        onPreviousPage={page.goPrev}
        onNextPage={() => {
          if (revisions.data.nextCursor) page.goNext(revisions.data.nextCursor)
        }}
      />
    </div>
  )
}
