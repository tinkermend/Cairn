import type { ReactNode } from 'react'
import { EmptyState } from '@/components/empty-state'
import { PageSkeleton } from '@/components/page-skeleton'
import { QueryErrorState } from '@/components/query-error-state'

type AuditRecordCardProps = {
  ariaLabel: string
  header?: ReactNode
  toolbar: ReactNode
  pending: boolean
  error: boolean
  errorTitle: string
  onRetry: () => void
  empty: boolean
  emptyTitle: string
  emptyDescription: string
  footer?: ReactNode
  children: ReactNode
}

export function AuditRecordCard({
  ariaLabel,
  header,
  toolbar,
  pending,
  error,
  errorTitle,
  onRetry,
  empty,
  emptyTitle,
  emptyDescription,
  footer,
  children,
}: AuditRecordCardProps) {
  return (
    <section
      aria-label={ariaLabel}
      className='flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border-card bg-card shadow-card'
    >
      {header ? <div className='shrink-0 px-4'>{header}</div> : null}
      <div className='flex shrink-0 flex-wrap items-center gap-2 border-b border-border-divider px-4 py-2.5'>
        {toolbar}
      </div>
      <div className='min-h-0 min-w-0 flex-1 overflow-auto'>
        {pending ? (
          <div className='p-4'>
            <PageSkeleton />
          </div>
        ) : error ? (
          <div className='p-4'>
            <QueryErrorState title={errorTitle} onRetry={onRetry} />
          </div>
        ) : empty ? (
          <EmptyState title={emptyTitle} description={emptyDescription} />
        ) : (
          children
        )}
      </div>
      {footer ? (
        <div className='shrink-0 border-t border-border-divider px-4 py-3'>
          {footer}
        </div>
      ) : null}
    </section>
  )
}
