import { useEffect, useState } from 'react'
import type { EvidenceMetadata, JsonValue } from '@cairn/shared'
import { fetchEvidenceContent } from '@/lib/runs-api'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

const TYPE_LABELS: Record<EvidenceMetadata['type'], string> = {
  input: '输入',
  output: '输出',
  error: '错误',
  screenshot: '截图',
  log: '诊断',
  trace: 'Trace',
}

export function AttemptEvidenceList({
  runId,
  items,
}: {
  runId: string
  items: EvidenceMetadata[]
}) {
  if (items.length === 0) {
    return <p className='mt-2 text-label text-muted-foreground'>这一次尝试还没有证据。</p>
  }
  return (
    <ul className='mt-2 space-y-2'>
      {items.map((item) => (
        <li key={item.id}>
          <EvidenceItem runId={runId} item={item} />
        </li>
      ))}
    </ul>
  )
}

function EvidenceItem({ runId, item }: { runId: string; item: EvidenceMetadata }) {
  return (
    <Collapsible defaultOpen={false} className='rounded-sm border border-border-card bg-card'>
      <CollapsibleTrigger className='flex w-full items-center justify-between px-3 py-2 text-left text-label'>
        <span>{TYPE_LABELS[item.type]}</span>
        <span className='text-muted-foreground'>{statusHint(item)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className='space-y-2 border-t border-border-card px-3 py-2'>
        {item.missingReason ? (
          <p className='text-label text-status-warning-foreground'>缺失原因：{item.missingReason}</p>
        ) : null}
        {item.type === 'screenshot' && item.status === 'available' ? (
          <EvidenceScreenshot runId={runId} evidenceId={item.id} />
        ) : null}
        {item.type === 'trace' && item.status === 'available' ? (
          <EvidenceTraceDownload runId={runId} evidenceId={item.id} />
        ) : null}
        {item.payload !== undefined ? <StructuredPayload value={item.payload} /> : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

function statusHint(item: EvidenceMetadata): string {
  if (item.status === 'pending') return '收集中'
  if (item.status === 'missing') return '缺失'
  return '已就绪'
}

function EvidenceTraceDownload({ runId, evidenceId }: { runId: string; evidenceId: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className='space-y-1'>
      <Button
        size='sm'
        variant='outline'
        disabled={busy}
        onClick={() => {
          setBusy(true)
          void fetchEvidenceContent(runId, evidenceId)
            .then(({ blob }) => {
              const url = URL.createObjectURL(blob)
              const link = document.createElement('a')
              link.href = url
              link.download = 'trace.zip'
              link.click()
              URL.revokeObjectURL(url)
            })
            .finally(() => setBusy(false))
        }}
      >
        下载 Trace
      </Button>
      <p className='text-label text-muted-foreground'>用 Playwright Trace Viewer 打开</p>
    </div>
  )
}

function EvidenceScreenshot({ runId, evidenceId }: { runId: string; evidenceId: string }) {
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

  if (failed) return <p className='text-label text-status-warning-foreground'>截图无法加载</p>
  if (!url) return <p className='text-label text-muted-foreground'>截图加载中</p>
  return <img src={url} alt='步骤截图' className='max-h-96 max-w-full rounded-sm border border-border-card' />
}

function StructuredPayload({ value }: { value: JsonValue }) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value)
    return (
      <dl className='grid gap-1 text-label'>
        {entries.map(([key, item]) => (
          <div key={key} className='grid grid-cols-[7rem_1fr] gap-2'>
            <dt className='text-muted-foreground'>{key}</dt>
            <dd className='break-all'>{formatValue(item)}</dd>
          </div>
        ))}
      </dl>
    )
  }
  return <p className='text-label'>{formatValue(value)}</p>
}

function formatValue(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (value === null) return '空'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
