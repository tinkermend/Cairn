import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  isAiCallEvidence,
  readScreenshotPayload,
  SCREENSHOT_ROLE_LABELS,
  type EvidenceMetadata,
  type JsonValue,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchEvidenceContent } from '@/lib/runs-api'
import { releaseEvidence } from '@/lib/services-api'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Can } from '@/components/rbac/can'
import { AiAttemptSummary } from './ai-evidence'
import { missingReasonLabel } from './labels'

const TYPE_LABELS: Record<EvidenceMetadata['type'], string> = {
  input: '输入',
  output: '输出',
  error: '错误',
  screenshot: '截图',
  log: '诊断',
  trace: 'Trace',
  video: '录像',
}

export function AttemptEvidenceList({
  runId,
  items,
  focusEvidenceId,
}: {
  runId: string
  items: EvidenceMetadata[]
  focusEvidenceId?: string
}) {
  if (items.length === 0) {
    return (
      <p className='mt-2 text-label text-muted-foreground'>
        这一次尝试还没有证据。
      </p>
    )
  }
  return (
    <ul className='mt-2 space-y-2'>
      {items.map((item) => (
        <li
          key={item.id}
          id={`evidence-${item.id}`}
          data-focused={focusEvidenceId === item.id ? 'true' : undefined}
        >
          <EvidenceItem runId={runId} item={item} forceOpen={focusEvidenceId === item.id} />
        </li>
      ))}
    </ul>
  )
}

function shouldOpenByDefault(item: EvidenceMetadata): boolean {
  if (item.status === 'missing') return true
  return (
    item.type === 'error' || item.type === 'screenshot' || item.type === 'trace' || item.type === 'video'
  )
}

function EvidenceItem({
  runId,
  item,
  forceOpen,
}: {
  runId: string
  item: EvidenceMetadata
  forceOpen?: boolean
}) {
  return (
    <Collapsible
      defaultOpen={forceOpen || shouldOpenByDefault(item)}
      className='rounded-sm border border-border-card bg-card'
    >
      <CollapsibleTrigger className='flex w-full items-center justify-between px-3 py-2 text-left text-label'>
        <span>{screenshotTitle(item)}</span>
        <span className='text-muted-foreground'>{statusHint(item)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className='space-y-2 border-t border-border-card px-3 py-2'>
        {item.missingReason ? (
          <p className='text-label text-status-warning-foreground'>
            缺失原因：{missingReasonLabel(item.missingReason)}
          </p>
        ) : null}
        {item.type === 'screenshot' && item.status === 'available' ? (
          <>
            <EvidenceScreenshot runId={runId} evidenceId={item.id} />
          </>
        ) : null}
        {item.type === 'trace' && item.status === 'available' ? (
          <EvidenceTraceDownload runId={runId} evidenceId={item.id} />
        ) : null}
        {item.status === 'available' &&
          (item.type === 'screenshot' ||
            (item.type === 'output' &&
              item.payload !== undefined &&
              !isAiCallEvidence(item.payload))) && (
            <Can permission='service:write'>
              <EvidenceRelease runId={runId} item={item} />
            </Can>
          )}
        {item.payload !== undefined ? (
          isAiCallEvidence(item.payload) ? (
            <AiAttemptSummary output={null} evidence={[item]} />
          ) : (
            <StructuredPayload value={item.payload} />
          )
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

function screenshotTitle(item: EvidenceMetadata): string {
  if (item.type !== 'screenshot') return TYPE_LABELS[item.type]
  const role = readScreenshotPayload(item.payload)?.role
  return role ? `${TYPE_LABELS.screenshot} · ${SCREENSHOT_ROLE_LABELS[role]}` : TYPE_LABELS.screenshot
}

function statusHint(item: EvidenceMetadata): string {
  if (item.status === 'pending') return '收集中'
  if (item.status === 'missing') return '缺失'
  return '已就绪'
}

function EvidenceTraceDownload({
  runId,
  evidenceId,
}: {
  runId: string
  evidenceId: string
}) {
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
              link.download = `trace-${evidenceId.slice(0, 8)}.zip`
              link.click()
              URL.revokeObjectURL(url)
            })
            .catch((error) => {
              toast.error(
                error instanceof ApiRequestError
                  ? error.message
                  : 'Trace 下载失败'
              )
            })
            .finally(() => setBusy(false))
        }}
      >
        {busy ? '下载中…' : '下载 Trace'}
      </Button>
      <p className='text-label text-muted-foreground'>
        用 Playwright Trace Viewer 打开
      </p>
    </div>
  )
}

function EvidenceScreenshot({
  runId,
  evidenceId,
}: {
  runId: string
  evidenceId: string
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

  if (failed)
    return (
      <p className='text-label text-status-warning-foreground'>截图无法加载</p>
    )
  if (!url)
    return <p className='text-label text-muted-foreground'>截图加载中…</p>
  return (
    <>
      <button
        type='button'
        className='block max-w-full text-left'
        onClick={() => setOpen(true)}
      >
        <img
          src={url}
          alt='步骤截图，点击看大图'
          className='max-h-96 max-w-full rounded-sm border border-border-card'
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='max-h-[90vh] overflow-auto sm:max-w-5xl'>
          <DialogTitle>步骤截图</DialogTitle>
          <img
            src={url}
            alt='步骤截图大图'
            className='max-h-[75vh] w-auto max-w-full'
          />
        </DialogContent>
      </Dialog>
    </>
  )
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
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  return JSON.stringify(value)
}

function EvidenceRelease({
  runId,
  item,
}: {
  runId: string
  item: EvidenceMetadata
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false)
  const queryClient = useQueryClient()
  const allowed = !!item.externalAccess
  async function save() {
    setBusy(true)
    try {
      await releaseEvidence(runId, item.id, !allowed)
      await queryClient.invalidateQueries({ queryKey: ['runs', runId] })
      setOpen(false)
      toast.success(allowed ? '已取消对外发布' : '证据已对外发布')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className='space-y-2'>
      <p className='text-small text-muted-foreground'>
        {allowed ? '已允许对应服务调用方读取此证据' : '此证据仅控制台可见'}
      </p>
      <Button variant='outline' size='sm' onClick={() => setOpen(true)}>
        {allowed ? '取消对外发布' : '发布给外部调用方'}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={allowed ? '取消证据对外发布' : '发布证据给外部调用方'}
        desc={
          allowed
            ? '取消后，外部 API 将无法读取此证据。'
            : '请确认已检查此证据，不含口令、令牌或不应对外公开的业务信息。发布后，拥有该运行和证据读取权限的服务调用方可以下载。'
        }
        confirmText={allowed ? '取消发布' : '确认已检查并发布'}
        isLoading={busy}
        handleConfirm={() => void save()}
      />
    </div>
  )
}
