import { useEffect, useState } from 'react'
import {
  faceScreenshot,
  isFinishedRunStatus,
  readRunVideoPayload,
  resolveEvidencePolicy,
  stepUsesBrowser,
  videoAbsenceCaption,
  videoCoverageLines,
  type EvidenceMetadata,
  type RunDetailDto,
} from '@cairn/shared'
import { toast } from 'sonner'
import { ApiRequestError } from '@/lib/api-client'
import { fetchEvidenceContent } from '@/lib/runs-api'
import { Button } from '@/components/ui/button'
import { missingReasonLabel } from './labels'

function canPlayVp8Webm(): boolean {
  if (typeof document === 'undefined') return true
  return Boolean(document.createElement('video').canPlayType('video/webm; codecs="vp8"'))
}

export function findRunVideo(items: EvidenceMetadata[]): EvidenceMetadata | undefined {
  return items.find((item) => item.type === 'video' && !item.attemptId && !item.stepRunId)
}

export function shouldShowRunVideo(run: RunDetailDto, items: EvidenceMetadata[]): boolean {
  if (findRunVideo(items)) return true
  const policy = resolveEvidencePolicy(run.snapshot.evidencePolicy)
  if (policy.video !== 'always') return false
  if (!run.snapshot.steps.some((step) => stepUsesBrowser(step.type))) return false
  const finishedBrowser = run.stepRuns.some((stepRun) => {
    const step = run.snapshot.steps.find((item) => item.id === stepRun.stepId)
    return Boolean(
      step &&
        stepUsesBrowser(step.type) &&
        stepRun.attempts.some((attempt) => attempt.status !== 'RUNNING'),
    )
  })
  return finishedBrowser || !isFinishedRunStatus(run.status)
}

function payloadFlag(item: EvidenceMetadata | undefined, key: string): unknown {
  if (!item?.payload || typeof item.payload !== 'object' || Array.isArray(item.payload)) return undefined
  return item.payload[key]
}

export function RunVideoSection({
  run,
  items,
}: {
  run: RunDetailDto
  items: EvidenceMetadata[]
}) {
  if (!shouldShowRunVideo(run, items)) return null
  const video = findRunVideo(items)
  const videoPayload = readRunVideoPayload(video?.payload)
  const truncated = videoPayload?.truncated === true || payloadFlag(video, 'truncated') === true
  const passwordMask = videoPayload?.passwordMask ?? payloadFlag(video, 'passwordMask')
  const coverageLines = video?.status === 'available' ? videoCoverageLines(videoPayload) : []
  const absence = videoAbsenceCaption({
    video,
    policyVideo: resolveEvidencePolicy(run.snapshot.evidencePolicy).video,
  })
  return (
    <section className='space-y-3 rounded-lg border border-border-card bg-card p-5 shadow-card'>
      <h2 className='text-section font-semibold'>本次录像</h2>
      {!video ? (
        <p className='text-label text-muted-foreground'>
          {isFinishedRunStatus(run.status)
            ? (absence ?? '没有留下可播录像。')
            : '录像采集中…'}
        </p>
      ) : video.status === 'pending' ? (
        <p className='text-label text-muted-foreground'>录像正在收尾…</p>
      ) : video.status === 'missing' ? (
        <p className='text-label text-status-warning-foreground'>
          {absence ??
            `录像不可用${video.missingReason ? `：${missingReasonLabel(video.missingReason)}` : ''}`}
        </p>
      ) : (
        <RunVideoPlayer runId={run.id} evidence={video} />
      )}
      {coverageLines.map((line) => (
        <p key={line} className='text-label text-muted-foreground'>
          {line}
        </p>
      ))}
      {video?.status === 'available' && video.byteSize != null ? (
        <p className='text-label text-muted-foreground'>体积 {(video.byteSize / 1024).toFixed(1)} KiB</p>
      ) : null}
      {truncated ? <p className='text-label text-status-warning-foreground'>录像已截断</p> : null}
      {video?.status === 'available' && passwordMask === 'failed' ? (
        <p className='text-label text-muted-foreground'>口令遮罩未完全套用，控制台仍仅内部可见。</p>
      ) : null}
    </section>
  )
}

function RunVideoPlayer({
  runId,
  evidence,
}: {
  runId: string
  evidence: EvidenceMetadata
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const playable = canPlayVp8Webm()

  useEffect(() => {
    let revoked: string | undefined
    let cancelled = false
    void fetchEvidenceContent(runId, evidence.id)
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
  }, [runId, evidence.id])

  if (failed) {
    return <p className='text-label text-status-warning-foreground'>录像无法加载</p>
  }
  if (!url) {
    return <p className='text-label text-muted-foreground'>录像加载中…</p>
  }
  return (
    <div className='space-y-2'>
      {playable ? (
        <video controls src={url} className='max-h-96 w-full rounded-sm border border-border-card bg-black'>
          当前浏览器不能播放这段录像。
        </video>
      ) : (
        <p className='text-label text-muted-foreground'>
          当前浏览器不能直接播放 WebM。请下载录像，或查看下方步骤截图。
        </p>
      )}
      <Button
        size='sm'
        variant='outline'
        onClick={() => {
          const link = document.createElement('a')
          link.href = url
          link.download = `run-${runId.slice(0, 8)}.webm`
          link.click()
        }}
      >
        下载录像
      </Button>
    </div>
  )
}

export function StepFaceScreenshot({
  runId,
  item,
}: {
  runId: string
  item: EvidenceMetadata
}) {
  if (item.status === 'missing') {
    return (
      <p className='mt-2 text-label text-status-warning-foreground'>
        步骤截图缺失{item.missingReason ? `：${missingReasonLabel(item.missingReason)}` : ''}
      </p>
    )
  }
  if (item.status !== 'available') {
    return <p className='mt-2 text-label text-muted-foreground'>步骤截图收集中…</p>
  }
  return <StepScreenshotImage runId={runId} evidenceId={item.id} />
}

function StepScreenshotImage({
  runId,
  evidenceId,
}: {
  runId: string
  evidenceId: string
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
      .catch((error) => {
        if (!cancelled) {
          setFailed(true)
          if (error instanceof ApiRequestError) toast.error(error.message)
        }
      })
    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [runId, evidenceId])

  if (failed) return <p className='mt-2 text-label text-status-warning-foreground'>步骤截图无法加载</p>
  if (!url) return <p className='mt-2 text-label text-muted-foreground'>步骤截图加载中…</p>
  return (
    <img
      src={url}
      alt='该步骤最后一次尝试的截图'
      className='mt-2 max-h-56 max-w-full rounded-sm border border-border-card'
    />
  )
}

export function stepFaceScreenshot(
  attempts: { id: string; attemptNo: number; status: string }[],
  items: EvidenceMetadata[],
): EvidenceMetadata | undefined {
  const finished = attempts
    .filter((attempt) => attempt.status !== 'RUNNING')
    .sort((a, b) => a.attemptNo - b.attemptNo)
  const last = finished[finished.length - 1]
  if (!last) return undefined
  return faceScreenshot(items, last.id)
}
