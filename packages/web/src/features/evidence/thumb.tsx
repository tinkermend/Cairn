import { useEffect, useState } from 'react'
import { fetchEvidenceContent } from '@/lib/runs-api'

export function EvidenceThumb({
  runId,
  evidenceId,
  compact = false,
}: {
  runId: string
  evidenceId: string
  compact?: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

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
    return <span className='text-label text-muted-foreground'>无法预览</span>
  }
  if (!url) {
    return <span className='text-label text-muted-foreground'>加载中…</span>
  }
  return (
    <img
      src={url}
      alt='步骤截图预览'
      className={
        compact
          ? 'size-12 rounded-sm border border-border-card object-cover'
          : 'max-h-96 max-w-full rounded-sm border border-border-card'
      }
    />
  )
}
