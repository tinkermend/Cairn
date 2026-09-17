import type { MapSummaryResponse } from '@cairn/shared'
import { AlertTriangle, CheckCircle2, FileText, Layers } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { StatusBadge } from '@/components/status-badge'

export function MapSummaryBanner({
  summary,
}: {
  summary?: MapSummaryResponse
}) {
  return (
    <>
      {summary?.projectionStatus === 'missing' ||
      summary?.view.viewRef.kind === 'missing' ? (
        <Alert>
          <AlertDescription>
            还没有知识投影。列表为空，不能发布。
          </AlertDescription>
        </Alert>
      ) : null}
      {summary?.rebuildStatus ? (
        <Alert>
          <AlertDescription>
            {summary.rebuildStatus === 'failed'
              ? '新投影重建失败。'
              : '新投影重建中。'}
            当前显示旧投影，完成后请刷新知识。
          </AlertDescription>
        </Alert>
      ) : null}
      {summary?.projectionStatus === 'failed' ? (
        <Alert>
          <AlertDescription>
            投影处理失败。列表仍可读上次结果，但不能发布。
          </AlertDescription>
        </Alert>
      ) : null}
      {summary?.projectionStatus === 'shadow' ||
      summary?.rebuildCompleteness === 'partial' ? (
        <Alert>
          <AlertDescription>
            {summary.projectionStatus === 'shadow'
              ? '投影重建中。'
              : '证据已过保留期，重建结果不完整。'}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* 知识大盘 KPI 指标条 */}
      <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
        <div className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card'>
          <div className='flex items-center justify-between'>
            <span className='text-small font-medium text-muted-foreground'>
              认识页面
            </span>
            <div className='flex size-7 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground'>
              <FileText className='size-4' />
            </div>
          </div>
          <div className='mt-2 flex items-baseline gap-2'>
            <span className='font-mono text-section font-semibold text-text-primary'>
              {summary?.pageCount ?? 0}
            </span>
            <span className='text-label text-muted-foreground'>个页面表面</span>
          </div>
        </div>

        <div className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card'>
          <div className='flex items-center justify-between'>
            <span className='text-small font-medium text-muted-foreground'>
              识别对象
            </span>
            <div className='flex size-7 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground'>
              <Layers className='size-4' />
            </div>
          </div>
          <div className='mt-2 flex items-baseline gap-2'>
            <span className='font-mono text-section font-semibold text-text-primary'>
              {summary?.objectCount ?? 0}
            </span>
            <span className='text-label text-muted-foreground'>个受管元素</span>
          </div>
        </div>

        <div className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card'>
          <div className='flex items-center justify-between'>
            <span className='text-small font-medium text-muted-foreground'>
              变更与冲突
            </span>
            <div className='flex size-7 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground'>
              <AlertTriangle className='size-4' />
            </div>
          </div>
          <div className='mt-2 flex items-baseline gap-2'>
            <span className='font-mono text-section font-semibold text-text-primary'>
              {(summary?.changeCount ?? 0) + (summary?.conflictCount ?? 0)}
            </span>
            <span className='text-label text-muted-foreground'>
              {summary?.conflictCount
                ? `${summary.conflictCount} 冲突`
                : '待复核'}
            </span>
          </div>
        </div>

        <div className='flex flex-col justify-between rounded-lg border border-border-card bg-card p-4 shadow-card'>
          <div className='flex items-center justify-between'>
            <span className='text-small font-medium text-muted-foreground'>
              知识版本
            </span>
            <div className='flex size-7 items-center justify-center rounded-md bg-surface-subtle text-muted-foreground'>
              <CheckCircle2 className='size-4' />
            </div>
          </div>
          <div className='mt-2 flex items-center gap-2'>
            <StatusBadge
              tone={
                summary?.publicationStatus === 'published'
                  ? 'success'
                  : 'neutral'
              }
            >
              {summary?.publicationStatus === 'published'
                ? '已发布版本'
                : '未发布草稿'}
            </StatusBadge>
            {summary?.view.publicationRevision ? (
              <span className='font-mono text-label text-muted-foreground'>
                Rev.{summary.view.publicationRevision}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </>
  )
}
