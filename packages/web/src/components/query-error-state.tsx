import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

type QueryErrorStateProps = {
  title?: string
  description?: ReactNode
  onRetry?: () => void
  className?: string
}

export function QueryErrorState({
  title = '加载失败',
  description = '当前筛选条件会保留。可以重试，不会离开本页。',
  onRetry,
  className,
}: QueryErrorStateProps) {
  return (
    <Alert variant='destructive' className={cn('items-center', className)}>
      <AlertCircle />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
        <span>{description}</span>
        {onRetry ? (
          <Button variant='outline' size='sm' onClick={onRetry}>
            重试
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
