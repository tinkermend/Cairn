import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

type PageSkeletonProps = {
  rows?: number
  className?: string
}

export function PageSkeleton({ rows = 4, className }: PageSkeletonProps) {
  return (
    <div
      aria-busy='true'
      aria-live='polite'
      className={cn('space-y-4', className)}
    >
      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className='space-y-3 rounded-lg border border-border bg-card p-5'
          >
            <Skeleton className='h-4 w-24' />
            <Skeleton className='h-9 w-32' />
            <Skeleton className='h-3 w-40' />
          </div>
        ))}
      </div>
      <div className='rounded-lg border border-border bg-card p-5'>
        <Skeleton className='mb-4 h-5 w-40' />
        <div className='space-y-3'>
          {Array.from({ length: rows }).map((_, index) => (
            <Skeleton key={index} className='h-12 w-full' />
          ))}
        </div>
      </div>
    </div>
  )
}
