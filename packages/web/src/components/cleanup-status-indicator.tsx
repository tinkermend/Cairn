import { useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { CleanupStatusResponse } from '@cairn/shared'
import { ApiRequestError } from '@/lib/api-client'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/status-badge'

export type CleanupStatusIndicatorProps = {
  status: CleanupStatusResponse
  onRetry?: () => Promise<CleanupStatusResponse>
  onStatusUpdated?: (updated: CleanupStatusResponse) => void
}

export function CleanupStatusIndicator({
  status,
  onRetry,
  onStatusUpdated,
}: CleanupStatusIndicatorProps) {
  const [retrying, setRetrying] = useState(false)

  if (status.status === 'completed' && status.totalObjects === 0) {
    return null
  }

  const handleRetry = async () => {
    if (!onRetry) return
    setRetrying(true)
    try {
      const res = await onRetry()
      toast.success('已触发重新清理')
      onStatusUpdated?.(res)
    } catch (err) {
      toast.error(err instanceof ApiRequestError ? err.message : '重试清理失败')
    } finally {
      setRetrying(false)
    }
  }

  return (
    <div className='inline-flex items-center gap-2 text-label'>
      {status.status === 'completed' ? (
        <StatusBadge tone='success'>
          <CheckCircle2 className='mr-1 size-3' />
          附件已清理
        </StatusBadge>
      ) : status.status === 'in_progress' || status.status === 'pending' ? (
        <StatusBadge tone='warning'>
          <Loader2 className='mr-1 size-3 animate-spin' />
          附件清理中 ({status.purgedObjects}/{status.totalObjects})
        </StatusBadge>
      ) : status.status === 'failed' ? (
        <div className='flex items-center gap-1.5'>
          <StatusBadge tone='error'>
            <AlertCircle className='mr-1 size-3' />
            清理失败 ({status.failedObjects} 个失败)
          </StatusBadge>
          {onRetry ? (
            <Button
              size='sm'
              variant='ghost'
              className='h-6 px-1.5 text-label'
              loading={retrying}
              onClick={handleRetry}
            >
              <RefreshCw className='mr-1 size-3' />
              重试
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
