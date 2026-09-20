import { useEffect, useRef, useState } from 'react'
import {
  DEMONSTRATION_LIMITS,
  inspectRecordingImage,
  syncSha256Bytes,
  type DemonstrationSource,
} from '@cairn/shared'
import { newDemonstrationId } from '@/lib/demonstrations-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export type ReviewedImage = {
  factId: string
  phase: 'before' | 'after'
  manifest: DemonstrationSource['assetManifest'][number]
  blob: Blob
}
type Rect = { x: number; y: number; width: number; height: number }
export type LocalSourceImage = {
  factId: string
  phase: 'before' | 'after'
  dataUrl: string
  inputRect?: Rect
}

export function localSourceImages(
  text: string,
  source: DemonstrationSource
): LocalSourceImage[] {
  if (source.importProfile !== 'midscene-recorder-json@1') return []
  const events: unknown = JSON.parse(text)
  if (!Array.isArray(events)) return []
  return events
    .flatMap((event: Record<string, unknown>) => {
      if (!source.facts.some((f) => f.id === event.hashId)) return []
      const raw = event.rawPayload as { elementRect?: Rect } | undefined
      const rect = raw?.elementRect
      const inputRect =
        event.type === 'input' &&
        rect &&
        ['x', 'y', 'width', 'height'].every(
          (k) =>
            typeof rect[k as keyof Rect] === 'number' &&
            Number.isFinite(rect[k as keyof Rect])
        )
          ? rect
          : undefined
      return (['before', 'after'] as const).flatMap((phase) => {
        const dataUrl =
          event[phase === 'before' ? 'screenshotBefore' : 'screenshotAfter']
        return typeof dataUrl === 'string' &&
          /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)
          ? [{ factId: String(event.hashId), phase, dataUrl, inputRect }]
          : []
      })
    })
    .slice(0, DEMONSTRATION_LIMITS.images)
}

/** Only a reviewed, re-encoded canvas may leave this tab. */
export function DemonstrationImages({
  source,
  images,
  onChange,
  embedded = [],
}: {
  source: DemonstrationSource
  images: ReviewedImage[]
  onChange: (images: ReviewedImage[]) => void
  embedded?: LocalSourceImage[]
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const [rects, setRects] = useState<Rect[]>([])
  const [loaded, setLoaded] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [error, setError] = useState('')
  const [factId, setFactId] = useState(source.facts[0].id)
  const [phase, setPhase] = useState<'before' | 'after'>('after')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const c = canvas.current
    const i = image.current
    if (!c || !i) return
    c.width = i.naturalWidth
    c.height = i.naturalHeight
    const ctx = c.getContext('2d')!
    ctx.drawImage(i, 0, 0)
    ctx.fillStyle = '#000'
    rects.forEach((r) => ctx.fillRect(r.x, r.y, r.width, r.height))
  }, [rects, loaded])
  async function load(file?: File) {
    if (!file) return
    setError('')
    setReviewed(false)
    setLoaded(false)
    setRects([])
    image.current = null
    if (
      !['image/png', 'image/jpeg'].includes(file.type) ||
      file.size > DEMONSTRATION_LIMITS.fileBytes
    ) {
      setError('请选择 32 MiB 内的 PNG/JPEG 原图')
      return
    }
    const local = URL.createObjectURL(file)
    try {
      const i = new Image()
      i.src = local
      await i.decode()
      if (i.naturalWidth * i.naturalHeight > DEMONSTRATION_LIMITS.imagePixels)
        throw new Error('截图超过 400 万像素，请在本地缩小后再选取')
      image.current = i
      setLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : '图片无法读取')
    } finally {
      URL.revokeObjectURL(local)
    }
  }
  async function loadEmbedded(item: LocalSourceImage) {
    setError('')
    setReviewed(false)
    setLoaded(false)
    setRects([])
    image.current = null
    setFactId(item.factId)
    setPhase(item.phase)
    try {
      const i = new Image()
      i.src = item.dataUrl
      await i.decode()
      if (i.naturalWidth * i.naturalHeight > DEMONSTRATION_LIMITS.imagePixels)
        throw new Error('内嵌截图超过 400 万像素，请在本地缩小后另行选取')
      image.current = i
      setRects(item.inputRect ? [item.inputRect] : [])
      setLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : '内嵌截图无法读取')
    }
  }
  async function confirm() {
    if (!canvas.current || !reviewed) return
    setBusy(true)
    setError('')
    try {
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.current!.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('图片重新编码失败'))),
          'image/png'
        )
      )
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const size = inspectRecordingImage(bytes, 'image/png')
      if (
        images.length >= DEMONSTRATION_LIMITS.images ||
        images.reduce((n, i) => n + i.blob.size, blob.size) >
          DEMONSTRATION_LIMITS.totalImageBytes
      )
        throw new Error('截图数量或总大小已达限制')
      const next: ReviewedImage = {
        factId,
        phase,
        blob,
        manifest: {
          clientAssetId: newDemonstrationId(),
          kind: 'screenshot',
          digest: syncSha256Bytes(bytes),
          byteSize: bytes.length,
          contentType: 'image/png',
          ...size,
          redaction: 'locally_reviewed',
        },
      }
      onChange([
        ...images.filter((i) => i.factId !== factId || i.phase !== phase),
        next,
      ])
      setLoaded(false)
      setReviewed(false)
      image.current = null
    } catch (e) {
      setError(e instanceof Error ? e.message : '截图检查失败')
    } finally {
      setBusy(false)
    }
  }
  const position = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    return {
      x: ((event.clientX - box.left) * event.currentTarget.width) / box.width,
      y: ((event.clientY - box.top) * event.currentTarget.height) / box.height,
    }
  }
  return (
    <details className='rounded-lg border border-border-divider p-4'>
      <summary className='cursor-pointer text-body font-medium'>
        附加截图（可选，默认不上传）
        {images.length ? ` · 已确认 ${images.length} 张` : ''}
      </summary>
      <div className='mt-3 space-y-3'>
        <p className='text-label text-muted-foreground'>
          仅选择本地图片。拖动框选敏感区域进行遮罩，检查整张图片后确认。每张不超过
          2 MiB、400 万像素；不会读取录制中的外部路径或网址。
        </p>
        {embedded.length > 0 && (
          <div className='space-y-2'>
            <p className='text-label'>
              文件内有 {embedded.length}{' '}
              张来源图片。已知输入区域会先遮罩，其他敏感区域仍需检查。
            </p>
            <div className='flex flex-wrap gap-2'>
              {embedded.map((item) => (
                <Button
                  key={`${item.factId}-${item.phase}`}
                  size='sm'
                  variant='outline'
                  onClick={() => void loadEmbedded(item)}
                >
                  检查第{' '}
                  {source.facts.findIndex((f) => f.id === item.factId) + 1} 条
                  {item.phase === 'before' ? '前' : '后'}截图
                </Button>
              ))}
            </div>
          </div>
        )}
        <div className='grid gap-3 sm:grid-cols-2'>
          <label className='space-y-1 text-label'>
            关联操作
            <select
              className='h-10 w-full rounded border bg-background px-2'
              value={factId}
              onChange={(e) => setFactId(e.target.value)}
            >
              {source.facts.map((f, i) => (
                <option key={f.id} value={f.id}>
                  {i + 1}. {f.action}
                </option>
              ))}
            </select>
          </label>
          <label className='space-y-1 text-label'>
            截图时点
            <select
              className='h-10 w-full rounded border bg-background px-2'
              value={phase}
              onChange={(e) => setPhase(e.target.value as typeof phase)}
            >
              <option value='before'>动作前</option>
              <option value='after'>动作后</option>
            </select>
          </label>
        </div>
        <Label htmlFor='demonstration-image-file'>本地截图</Label>
        <Input
          id='demonstration-image-file'
          type='file'
          accept='image/png,image/jpeg'
          onChange={(e) => void load(e.target.files?.[0])}
        />
        <canvas
          ref={canvas}
          className={
            loaded
              ? 'max-h-96 max-w-full touch-none rounded border object-contain'
              : 'hidden'
          }
          aria-label='截图遮罩画布，拖动框选需要遮挡的区域'
          onPointerDown={(e) => {
            drag.current = position(e)
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerUp={(e) => {
            if (!drag.current) return
            const end = position(e)
            const start = drag.current
            drag.current = null
            setRects((old) => [
              ...old,
              {
                x: Math.min(start.x, end.x),
                y: Math.min(start.y, end.y),
                width: Math.abs(start.x - end.x),
                height: Math.abs(start.y - end.y),
              },
            ])
            setReviewed(false)
          }}
        />
        {loaded && (
          <>
            <Button
              variant='outline'
              size='sm'
              onClick={() => {
                setRects([])
                setReviewed(false)
              }}
            >
              重置遮罩
            </Button>
            <label className='flex gap-2 text-label'>
              <input
                type='checkbox'
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              我已检查整张图片，确认密码、个人资料等敏感内容已遮挡。
            </label>
            <Button
              size='sm'
              disabled={!reviewed || busy}
              onClick={() => void confirm()}
            >
              确认这张截图
            </Button>
          </>
        )}
        {error && (
          <p role='alert' className='text-label text-destructive'>
            {error}
          </p>
        )}
        {images.map((item) => (
          <div
            key={item.manifest.clientAssetId}
            className='flex items-center justify-between gap-2 text-label'
          >
            <span>
              第 {source.facts.findIndex((f) => f.id === item.factId) + 1} 条 ·{' '}
              {item.phase === 'before' ? '动作前' : '动作后'} ·{' '}
              {Math.ceil(item.blob.size / 1024)} KiB
            </span>
            <Button
              size='sm'
              variant='ghost'
              onClick={() => onChange(images.filter((i) => i !== item))}
            >
              移除
            </Button>
          </div>
        ))}
      </div>
    </details>
  )
}
