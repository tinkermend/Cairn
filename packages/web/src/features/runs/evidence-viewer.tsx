import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  isAiCallEvidence,
  readScreenshotPayload,
  SCREENSHOT_DIAGNOSIS_LABELS,
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
  trace: '操作轨迹',
  video: '录像',
  file: '文件',
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
  useEffect(() => {
    if (focusEvidenceId) {
      const el = document.getElementById(`evidence-${focusEvidenceId}`)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }
  }, [focusEvidenceId])

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
          className={focusEvidenceId === item.id ? 'ring-2 ring-primary/80 rounded-md transition-shadow motion-reduce:transition-none' : ''}
        >
          <EvidenceItem runId={runId} item={item} forceOpen={focusEvidenceId === item.id} />
        </li>
      ))}
    </ul>
  )
}

function shouldOpenByDefault(item: EvidenceMetadata): boolean {
  if (item.status === 'missing') return true
  if (item.type === 'screenshot') {
    return readScreenshotPayload(item.payload)?.role !== 'before_action'
  }
  return item.type === 'error' || item.type === 'trace' || item.type === 'video'
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
        <div className='flex items-center gap-2'>
          <span>{screenshotTitle(item)}</span>
          {item.externalAccess ? (
            item.externalAccessSource === 'auto' ? (
              <span className='inline-flex items-center px-1.5 py-0.5 rounded text-label font-medium bg-status-success-background text-status-success-foreground'>
                已自动交付
              </span>
            ) : (
              <span className='inline-flex items-center px-1.5 py-0.5 rounded text-label font-medium bg-status-info-background text-status-info-foreground'>
                已对外发布
              </span>
            )
          ) : null}
        </div>
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
            <ScreenshotDiagnosisNote payload={item.payload} />
            <EvidenceScreenshot runId={runId} evidenceId={item.id} label={screenshotTitle(item)} />
          </>
        ) : null}
        {item.type === 'trace' && item.status === 'available' ? (
          <EvidenceTraceDownload runId={runId} evidenceId={item.id} />
        ) : null}
        {item.type === 'file' && item.status === 'available' ? (
          <EvidenceFileDownload runId={runId} evidenceId={item.id} />
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
          <details className='text-label'>
            <summary className='cursor-pointer text-muted-foreground'>技术详情</summary>
            <div className='mt-2'>
              {isAiCallEvidence(item.payload) ? (
                <AiAttemptSummary output={null} evidence={[item]} />
              ) : (
                <StructuredPayload value={item.payload} />
              )}
            </div>
          </details>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}

function screenshotTitle(item: EvidenceMetadata): string {
  if (item.type !== 'screenshot') return TYPE_LABELS[item.type]
  const payload = readScreenshotPayload(item.payload)
  const role = payload?.role
  const diagnosis = payload?.diagnosis === 'suspected_blank' ? ' · 截图疑似空白' : ''
  return role ? `${SCREENSHOT_ROLE_LABELS[role]}${diagnosis}` : TYPE_LABELS.screenshot
}

function ScreenshotDiagnosisNote({ payload }: { payload: EvidenceMetadata['payload'] }) {
  const parsed = readScreenshotPayload(payload)
  if (!parsed) return null
  const diagnosis = parsed.diagnosis ? SCREENSHOT_DIAGNOSIS_LABELS[parsed.diagnosis] : '未检测'
  return (
    <p className='text-label text-muted-foreground'>
      画面：{diagnosis}
      {parsed.omittedBefore === 'initial_blank_page' ? ' · 进入页面前无可见画面' : ''}
    </p>
  )
}

function statusHint(item: EvidenceMetadata): string {
  if (item.status === 'pending') return '收集中'
  if (item.status === 'missing') return '缺失'
  return '已保存'
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
                  : '操作轨迹下载失败'
              )
            })
            .finally(() => setBusy(false))
        }}
      >
        {busy ? '下载中…' : '下载操作轨迹'}
      </Button>
      <p className='text-label text-muted-foreground'>
        用 Playwright 轨迹查看器打开
      </p>
    </div>
  )
}

function EvidenceFileDownload({
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
              link.download = `file-${evidenceId.slice(0, 8)}`
              link.click()
              URL.revokeObjectURL(url)
            })
            .catch((error) => {
              toast.error(
                error instanceof ApiRequestError
                  ? error.message
                  : '文件下载失败'
              )
            })
            .finally(() => setBusy(false))
        }}
      >
        {busy ? '下载中…' : '下载文件'}
      </Button>
    </div>
  )
}

const imageCache = new Map<string, string>()

function EvidenceScreenshot({
  runId,
  evidenceId,
  label = '步骤截图',
}: {
  runId: string
  evidenceId: string
  label?: string
}) {
  const [url, setUrl] = useState<string | null>(imageCache.get(`${runId}:${evidenceId}`) ?? null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const hostRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const node = hostRef.current
    if (!node || url) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true)
      },
      { rootMargin: '80px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hostRef, url])

  useEffect(() => {
    if (!visible || url) return
    const key = `${runId}:${evidenceId}`
    const cached = imageCache.get(key)
    if (cached) {
      setUrl(cached)
      return
    }
    let cancelled = false
    void fetchEvidenceContent(runId, evidenceId)
      .then(({ blob }) => {
        if (cancelled) return
        const created = URL.createObjectURL(blob)
        imageCache.set(key, created)
        setUrl(created)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [runId, evidenceId, url, visible])

  if (failed) {
    return <p className='text-label text-status-warning-foreground'>截图无法加载</p>
  }
  return (
    <>
      <button
        ref={hostRef}
        type='button'
        className='flex h-24 w-40 items-center justify-center overflow-hidden rounded-sm border border-border-card bg-muted/30 text-left'
        aria-label={`查看${label}大图`}
        onClick={() => setOpen(true)}
      >
        {url ? (
          <img src={url} alt={label} className='max-h-full max-w-full object-contain' />
        ) : (
          <span className='text-label text-muted-foreground'>截图加载中…</span>
        )}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className='max-h-[90vh] overflow-auto sm:max-w-5xl'>
          <DialogTitle>{label}</DialogTitle>
          {url ? (
            <img src={url} alt={`${label}原始分辨率`} className='max-h-[75vh] w-auto max-w-full object-contain' />
          ) : (
            <p className='text-label text-muted-foreground'>截图加载中…</p>
          )}
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
  const isAuto = item.externalAccessSource === 'auto'

  async function save() {
    setBusy(true)
    try {
      await releaseEvidence(runId, item.id, !allowed)
      await queryClient.invalidateQueries({ queryKey: ['runs', runId] })
      setOpen(false)
      toast.success(allowed ? '已撤回对外访问' : '证据已对外发布')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='space-y-2 rounded-md border border-border-card/60 bg-muted/20 p-2.5'>
      <div className='flex items-center justify-between'>
        <div className='space-y-0.5'>
          <div className='flex items-center gap-1.5'>
            {allowed ? (
              isAuto ? (
                <span className='inline-flex items-center px-1.5 py-0.5 rounded text-label font-medium bg-status-success-background text-status-success-foreground'>
                  已自动交付
                </span>
              ) : (
                <span className='inline-flex items-center px-1.5 py-0.5 rounded text-label font-medium bg-status-info-background text-status-info-foreground'>
                  已对外发布
                </span>
              )
            ) : null}
            <span className='text-label font-medium text-foreground'>
              {allowed
                ? isAuto
                  ? '根据调用方交付策略已自动交付'
                  : '已人工放行对外访问'
                : '此证据仅控制台可见'}
            </span>
          </div>
          <p className='text-label text-muted-foreground'>
            {allowed
              ? '外部调用方可通过 OpenAPI 查询或下载此证据。'
              : '默认不向外部调用方开放。如需放行请人工复核。'}
          </p>
        </div>
        <Button variant='outline' size='sm' onClick={() => setOpen(true)}>
          {allowed ? '撤回对外访问' : '发布给外部调用方'}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={allowed ? '撤回证据对外访问' : '发布证据给外部调用方'}
        desc={
          allowed
            ? '撤回对外访问将关闭后续 API 查询通道；已通过 Webhook 投递的快照无法撤回。确认撤回？'
            : '请确认已检查此证据，不含口令、令牌或不应对外公开的业务信息。发布后，拥有该运行和证据读取权限的服务调用方可以下载。'
        }
        confirmText={allowed ? '确认撤回' : '确认已检查并发布'}
        isLoading={busy}
        handleConfirm={() => void save()}
      />
    </div>
  )
}
