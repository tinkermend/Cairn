import { useEffect, useState } from 'react'
import { fetchEvidenceContent } from '@/lib/runs-api'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'

export function EvidenceHoverPreview({
  runId,
  evidenceId,
  stepName,
  createdAt,
  alt = '步骤截图预览',
}: {
  runId: string
  evidenceId: string
  stepName?: string | null
  createdAt?: string | null
  alt?: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let revoked: string | undefined
    let cancelled = false
    void fetchEvidenceContent(runId, evidenceId)
      .then(({ blob }) => {
        if (cancelled) return
        revoked = URL.createObjectURL(blob)
        setUrl(revoked)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [runId, evidenceId])

  if (failed) {
    return (
      <div className='flex h-8 w-12 items-center justify-center rounded border border-border-card bg-surface-subtle text-caption text-muted-foreground'>
        无图
      </div>
    )
  }

  if (!url) {
    return <Skeleton className='h-8 w-12 rounded' />
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='group relative flex h-8 w-12 shrink-0 cursor-pointer overflow-hidden rounded border border-border-card bg-black/5 transition hover:border-primary/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary'
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          onClick={(e) => {
            // 点击时不拦截外层的行点击事件
            e.stopPropagation()
            setOpen((prev) => !prev)
          }}
          aria-label='悬浮预览大图'
        >
          <img
            src={url}
            alt={alt}
            className='h-full w-full object-cover transition-transform group-hover:scale-105'
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side='right'
        align='center'
        sideOffset={8}
        className='w-80 p-2 shadow-card-lg'
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        <div className='space-y-1.5'>
          <div className='overflow-hidden rounded border border-border-card bg-black/10'>
            <img
              src={url}
              alt={alt}
              className='max-h-56 w-full object-contain'
            />
          </div>
          {(stepName || createdAt) ? (
            <div className='flex items-center justify-between text-caption text-muted-foreground px-0.5'>
              <span className='truncate font-medium text-foreground'>{stepName ?? '步骤截图'}</span>
              {createdAt ? <span>{new Date(createdAt).toLocaleTimeString()}</span> : null}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
