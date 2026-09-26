import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  captureMsToMediaSeconds,
  chapterAtPlayhead,
  gapAtPlayhead,
  mediaSecondsToCaptureMs,
  type EvidenceMetadata,
  type RunVideoChapter,
  type RunVideoChapterModel,
  type RunVideoGap,
} from '@cairn/shared'
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { STEP_RUN_STATUS_LABELS } from '@/features/scenarios/labels'
import { fetchEvidenceContent } from '@/lib/runs-api'

export type RunVideoPlayerProps = {
  runId: string
  evidence: EvidenceMetadata
  chapterModel: RunVideoChapterModel
  currentStepRunId?: string | null
  onChapterChange?: (stepRunId: string | null) => void
  seekRequest?: {
    token: number
    ms: number
    source: 'chapter' | 'list' | 'deeplink' | 'pin'
  } | null
  onSeek?: (ms: number) => void
  offAxisSelectedStep?: { ordinal: number; name: string } | null
  onSelectStep?: (stepRunId: string, attemptId?: string) => void
}

function formatWallClockDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
  if (ms < 1000) return `${ms} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${Math.round(ms / 1000)} 秒`
}

function formatMediaTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const totalSec = Math.floor(seconds)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function HoverThumbnail({
  runId,
  evidenceId,
}: {
  runId: string
  evidenceId: string
}) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let revoked: string | undefined
    void fetchEvidenceContent(runId, evidenceId)
      .then(({ blob }) => {
        if (cancelled) return
        revoked = URL.createObjectURL(blob)
        setSrc(revoked)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      if (revoked) URL.revokeObjectURL(revoked)
    }
  }, [runId, evidenceId])

  if (!src) return null
  return (
    <img
      src={src}
      alt='步骤主截图'
      className='mt-1 max-h-20 max-w-36 rounded-xs border border-border-card object-cover'
    />
  )
}

export function RunVideoPlayer({
  runId,
  evidence,
  chapterModel,
  currentStepRunId: _currentStepRunId,
  onChapterChange,
  seekRequest,
  onSeek,
  offAxisSelectedStep,
  onSelectStep,
}: RunVideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const progressBarRef = useRef<HTMLDivElement>(null)

  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentMs, setCurrentMs] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [hoverState, setHoverState] = useState<{
    ms: number
    clientX: number
    chapter: RunVideoChapter | null
    gap: RunVideoGap | null
  } | null>(null)

  const spanMs = chapterModel.clock?.spanMs ?? 0
  const mediaMs = chapterModel.clock?.mediaMs ?? 0
  const currentChapter = useMemo(
    () => chapterAtPlayhead(chapterModel.chapters, currentMs, chapterModel.gaps),
    [chapterModel.chapters, currentMs, chapterModel.gaps],
  )
  const currentGap = useMemo(
    () => gapAtPlayhead(chapterModel.gaps, currentMs),
    [chapterModel.gaps, currentMs],
  )
  const stillGapAtPlayhead = currentGap?.kind === 'still'
  const blankGapAtPlayhead = currentGap?.kind === 'blank'

  // 加载录像内容 Blob
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

  // 章节切换向上同步（每步一次）
  const prevChapterIdRef = useRef<string | null>(null)
  useEffect(() => {
    const chapId = currentChapter?.stepRunId ?? null
    if (chapId !== prevChapterIdRef.current) {
      prevChapterIdRef.current = chapId
      onChapterChange?.(chapId)
    }
  }, [currentChapter, onChapterChange])

  // 受控 Seek
  const prevTokenRef = useRef<number | null>(null)
  useEffect(() => {
    if (!seekRequest || seekRequest.token === prevTokenRef.current) return
    prevTokenRef.current = seekRequest.token
    const targetSec = chapterModel.clock
      ? captureMsToMediaSeconds(seekRequest.ms, chapterModel.clock)
      : seekRequest.ms / 1000
    if (videoRef.current) {
      videoRef.current.currentTime = targetSec
    }
    setCurrentMs(seekRequest.ms)
    onSeek?.(seekRequest.ms)
  }, [seekRequest, chapterModel.clock, onSeek])

  const maxPlayableMs = useMemo(() => {
    if (mediaMs > 0 && spanMs > 0) return Math.min(mediaMs, spanMs)
    return mediaMs || spanMs || 0
  }, [mediaMs, spanMs])

  // Seek 处理
  const handleSeekTo = useCallback(
    (targetMs: number, _source: 'chapter' | 'list' | 'deeplink' | 'pin') => {
      const limit = maxPlayableMs || targetMs
      const clamped = Math.max(0, Math.min(limit, targetMs))
      const targetSec = chapterModel.clock
        ? captureMsToMediaSeconds(clamped, chapterModel.clock)
        : clamped / 1000
      if (videoRef.current) {
        videoRef.current.currentTime = targetSec
      }
      setCurrentMs(clamped)
      onSeek?.(clamped)
    },
    [chapterModel.clock, maxPlayableMs, onSeek],
  )

  // 播放头进度更新
  const handleTimeUpdate = useCallback(() => {
    if (!videoRef.current) return
    const sec = videoRef.current.currentTime
    const ms = mediaSecondsToCaptureMs(sec, chapterModel.clock ?? undefined)
    setCurrentMs(ms)
  }, [chapterModel.clock])

  // 播放 / 暂停切换
  const togglePlay = useCallback(() => {
    if (!videoRef.current) return
    if (videoRef.current.paused) {
      void videoRef.current.play().catch(() => undefined)
    } else {
      videoRef.current.pause()
    }
  }, [])

  // 全屏切换
  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return
    if (!document.fullscreenElement) {
      await containerRef.current.requestFullscreen().catch(() => undefined)
      setIsFullscreen(true)
    } else {
      await document.exitFullscreen().catch(() => undefined)
      setIsFullscreen(false)
    }
  }, [])

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [])

  // 键盘快捷键（焦点在播放器内）
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handleSeekTo(Math.max(0, currentMs - 2000), 'chapter')
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleSeekTo(Math.min(maxPlayableMs || currentMs + 2000, currentMs + 2000), 'chapter')
      } else if (e.key === 'Home') {
        e.preventDefault()
        handleSeekTo(0, 'chapter')
      } else if (e.key === 'End') {
        e.preventDefault()
        handleSeekTo(maxPlayableMs, 'chapter')
      }
    },
    [togglePlay, handleSeekTo, currentMs, maxPlayableMs],
  )

  // 点击进度条
  const handleProgressBarClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!progressBarRef.current) return
      const rect = progressBarRef.current.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const targetMs = Math.round(ratio * (spanMs || mediaMs || 1))
      handleSeekTo(targetMs, 'chapter')
    },
    [handleSeekTo, spanMs, mediaMs],
  )

  // 悬停进度条
  const handleProgressBarMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!progressBarRef.current) return
      const rect = progressBarRef.current.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const hoverMs = Math.round(ratio * (spanMs || mediaMs || 1))
      const chap = chapterAtPlayhead(chapterModel.chapters, hoverMs, chapterModel.gaps)
      const gap = gapAtPlayhead(chapterModel.gaps, hoverMs)
      setHoverState({
        ms: hoverMs,
        clientX: e.clientX - rect.left,
        chapter: chap,
        gap,
      })
    },
    [chapterModel.chapters, chapterModel.gaps, spanMs, mediaMs],
  )

  const handleProgressBarMouseLeave = useCallback(() => {
    setHoverState(null)
  }, [])

  // 上一步 / 下一步
  const currentChapterIndex = useMemo(() => {
    if (!currentChapter) return -1
    return chapterModel.chapters.findIndex((c) => c.stepRunId === currentChapter.stepRunId)
  }, [chapterModel.chapters, currentChapter])

  const handlePrevChapter = useCallback(() => {
    if (currentChapterIndex > 0) {
      const prev = chapterModel.chapters[currentChapterIndex - 1]!
      handleSeekTo(prev.fromMs, 'chapter')
      onSelectStep?.(prev.stepRunId)
    } else if (chapterModel.chapters.length > 0 && currentChapterIndex === -1) {
      const first = chapterModel.chapters[0]!
      handleSeekTo(first.fromMs, 'chapter')
      onSelectStep?.(first.stepRunId)
    }
  }, [currentChapterIndex, chapterModel.chapters, handleSeekTo, onSelectStep])

  const handleNextChapter = useCallback(() => {
    if (currentChapterIndex >= 0 && currentChapterIndex < chapterModel.chapters.length - 1) {
      const next = chapterModel.chapters[currentChapterIndex + 1]!
      handleSeekTo(next.fromMs, 'chapter')
      onSelectStep?.(next.stepRunId)
    } else if (chapterModel.chapters.length > 0 && currentChapterIndex === -1) {
      const first = chapterModel.chapters[0]!
      handleSeekTo(first.fromMs, 'chapter')
      onSelectStep?.(first.stepRunId)
    }
  }, [currentChapterIndex, chapterModel.chapters, handleSeekTo, onSelectStep])

  if (failed) {
    return <p className='text-label text-status-warning-foreground'>录像无法加载</p>
  }
  if (!url) {
    return <p className='text-label text-muted-foreground'>录像加载中…</p>
  }

  // 进度条无障碍数值文本
  const ariaValueText = currentChapter
    ? `第 ${currentChapter.ordinal + 1} 步 ${currentChapter.name}，${Math.round(currentMs / 1000)} 秒 / ${Math.round((spanMs || mediaMs) / 1000)} 秒`
    : `${Math.round(currentMs / 1000)} 秒 / ${Math.round((spanMs || mediaMs) / 1000)} 秒`

  // 说明行文本
  const descriptionText = (() => {
    if (offAxisSelectedStep) {
      return `正在看：${offAxisSelectedStep.ordinal + 1}. ${offAxisSelectedStep.name} · 不在录像里`
    }
    if (blankGapAtPlayhead) {
      return '正在看：这段没有画面'
    }
    if (currentChapter) {
      const modPrefix = currentChapter.moduleName ? `${currentChapter.moduleName} · ` : ''
      const durationStr = formatWallClockDuration(currentChapter.durationMs)
      const statusStr = STEP_RUN_STATUS_LABELS[currentChapter.status] ?? currentChapter.status
      const stillSuffix = stillGapAtPlayhead ? ' · 画面无变化' : ''
      return `正在看：${modPrefix}${currentChapter.ordinal + 1}. ${currentChapter.name} · ${durationStr} · ${statusStr}${stillSuffix}`
    }
    if (!chapterModel.clock) {
      return '历史录像，步骤对不上时间'
    }
    if (chapterModel.chapters.length === 0) {
      return '没有能对上录像的步骤'
    }
    return '正在看：步骤之间'
  })()

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className='run-video-player group/player space-y-2 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
    >
      {/* 画面区域 */}
      <div className='run-video-frame relative mx-auto w-full max-w-5xl overflow-hidden rounded-sm border border-border-card bg-black'>
        <video
          ref={videoRef}
          src={url}
          playsInline
          className='block h-auto w-full'
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        >
          当前浏览器不能播放这段录像。
        </video>
      </div>

      {/* 控件第一层：播放控制与进度条 */}
      <div className='flex items-center gap-3 px-1'>
        {/* 播放 / 暂停 */}
        <Button
          type='button'
          size='sm'
          variant='ghost'
          className='h-8 w-8 shrink-0 p-0 text-foreground hover:text-primary'
          onClick={togglePlay}
          aria-label={isPlaying ? '暂停' : '播放'}
        >
          {isPlaying ? <Pause className='size-4' /> : <Play className='size-4' />}
        </Button>

        {/* 进度条 */}
        <div
          ref={progressBarRef}
          role='slider'
          aria-label='录像进度'
          aria-valuemin={0}
          aria-valuemax={spanMs || mediaMs || 100}
          aria-valuenow={currentMs}
          aria-valuetext={ariaValueText}
          tabIndex={0}
          onClick={handleProgressBarClick}
          onMouseMove={handleProgressBarMouseMove}
          onMouseLeave={handleProgressBarMouseLeave}
          className='relative flex h-2.5 flex-1 cursor-pointer select-none items-center rounded-full bg-muted/60'
        >
          {/* 章节色块分段 */}
          {chapterModel.chapters.length > 0 ? (
            chapterModel.chapters.map((chap) => {
              const leftPct = (chap.fromMs / (spanMs || 1)) * 100
              const widthPct = Math.max(0.5, ((chap.toMs - chap.fromMs) / (spanMs || 1)) * 100)
              const toneBg =
                chap.status === 'SUCCEEDED'
                  ? 'bg-status-success-accent'
                  : chap.status === 'FAILED'
                    ? 'bg-status-error-accent'
                    : chap.status === 'RUNNING'
                      ? 'bg-status-info-accent'
                      : 'bg-status-warning-accent'

              // 检查是否有 still gap 落在该章节内，若有则叠加低对比点纹
              const hasStill = chapterModel.gaps.some(
                (g) => g.kind === 'still' && g.fromMs < chap.toMs && g.toMs > chap.fromMs,
              )

              return (
                <div
                  key={chap.stepRunId}
                  className={`absolute top-0 bottom-0 overflow-hidden ${toneBg} ${
                    chap.ordinal === 0 ? 'rounded-l-full' : ''
                  } ${chap.ordinal === chapterModel.chapters.length - 1 ? 'rounded-r-full' : ''}`}
                  style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                >
                  {hasStill ? (
                    <div className='absolute inset-0 video-still-pattern opacity-70 pointer-events-none' />
                  ) : null}
                </div>
              )
            })
          ) : (
            // 无章节时降级为普通单条进度
            <div
              className='h-full rounded-full bg-primary'
              style={{
                width: `${Math.min(
                  100,
                  Math.max(0, (currentMs / (spanMs || mediaMs || 1)) * 100),
                )}%`,
              }}
            />
          )}

          {/* 真无画面缺口（blank）：斜线灰段 */}
          {chapterModel.gaps
            .filter((g) => g.kind === 'blank')
            .map((gap, idx) => {
              const gLeft = (gap.fromMs / (spanMs || 1)) * 100
              const gWidth = Math.max(0.5, ((gap.toMs - gap.fromMs) / (spanMs || 1)) * 100)
              return (
                <div
                  key={`blank-${idx}`}
                  title='这段没有画面'
                  className='absolute top-0 bottom-0 rounded-xs bg-[repeating-linear-gradient(45deg,var(--text-disabled),var(--text-disabled)_2px,transparent_2px,transparent_6px)] opacity-60 pointer-events-none'
                  style={{ left: `${gLeft}%`, width: `${gWidth}%` }}
                />
              )
            })}

          {/* 失败钉 */}
          {chapterModel.pins.map((pin) => {
            const pLeft = (pin.atMs / (spanMs || 1)) * 100
            return (
              <button
                key={pin.attemptId}
                type='button'
                aria-label={`第 ${pin.attemptNo} 次尝试失败现场`}
                title={`第 ${pin.attemptNo} 次尝试失败现场`}
                className='absolute -top-1.5 z-20 flex h-5 w-4 -translate-x-1/2 cursor-pointer items-center justify-center'
                style={{ left: `${pLeft}%` }}
                onClick={(e) => {
                  e.stopPropagation()
                  handleSeekTo(pin.atMs, 'pin')
                }}
              >
                <span className='flex size-3 items-center justify-center rounded-full bg-status-error-accent text-white shadow-xs ring-1 ring-background'>
                  <X className='size-2 stroke-[3]' />
                </span>
              </button>
            )
          })}

          {/* 播放头游标 */}
          <div
            className='pointer-events-none absolute top-1/2 z-10 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-xs bg-white shadow-xs ring-1 ring-black/20'
            style={{
              left: `${spanMs > 0 ? Math.min(100, Math.max(0, (currentMs / spanMs) * 100)) : 0}%`,
            }}
          />

          {/* 悬停 Tooltip */}
          {hoverState ? (
            <div
              className='pointer-events-none absolute -top-12 z-30 flex -translate-x-1/2 flex-col items-center rounded-md border border-border-card bg-popover px-2.5 py-1 text-label text-popover-foreground shadow-popover'
              style={{ left: `${hoverState.clientX}px` }}
            >
              {hoverState.chapter ? (
                <>
                  <p className='whitespace-nowrap font-medium'>
                    {hoverState.chapter.ordinal + 1}. {hoverState.chapter.name} ·{' '}
                    {formatWallClockDuration(hoverState.chapter.durationMs)} ·{' '}
                    {STEP_RUN_STATUS_LABELS[hoverState.chapter.status] ??
                      hoverState.chapter.status}
                    {hoverState.gap?.kind === 'still' ? ' · 画面无变化' : ''}
                  </p>
                  {hoverState.chapter.faceEvidenceId ? (
                    <HoverThumbnail
                      runId={runId}
                      evidenceId={hoverState.chapter.faceEvidenceId}
                    />
                  ) : null}
                </>
              ) : hoverState.gap?.kind === 'blank' ? (
                <p className='whitespace-nowrap font-medium text-status-warning-foreground'>
                  这段没有画面
                </p>
              ) : (
                <p className='whitespace-nowrap font-medium text-muted-foreground'>
                  步骤之间 · {formatMediaTime(hoverState.ms / 1000)}
                </p>
              )}
            </div>
          ) : null}
        </div>

        {/* 时间码：0:08 / 0:23 */}
        <span className='shrink-0 select-none text-label tabular-nums text-muted-foreground'>
          {formatMediaTime(currentMs / 1000)} / {formatMediaTime((mediaMs || spanMs) / 1000)}
        </span>

        {/* 全屏按钮 */}
        <Button
          type='button'
          size='sm'
          variant='ghost'
          className='h-8 w-8 shrink-0 p-0 text-foreground hover:text-primary'
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? '退出全屏' : '全屏'}
        >
          {isFullscreen ? <Minimize2 className='size-4' /> : <Maximize2 className='size-4' />}
        </Button>

        {/* 下载录像 */}
        <Button
          type='button'
          size='sm'
          variant='outline'
          className='h-8 shrink-0 text-label'
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

      {/* 控件第二层：说明行与步骤互跳 */}
      <div className='flex flex-wrap items-center justify-between gap-2 border-t border-border-card/40 px-1 pt-1.5'>
        {/* 当前步骤说明 */}
        <p className='text-label font-medium text-foreground'>{descriptionText}</p>

        {/* 右侧：标签与导航按钮 */}
        <div className='flex flex-wrap items-center gap-1.5'>
          {/* 章节 <= 8 且屏幕宽度允许时放可点标签 */}
          {chapterModel.chapters.length > 0 && chapterModel.chapters.length <= 8 ? (
            <div className='hidden items-center gap-1 sm:flex'>
              {chapterModel.chapters.map((chap) => (
                <button
                  key={chap.stepRunId}
                  type='button'
                  onClick={() => {
                    handleSeekTo(chap.fromMs, 'chapter')
                    onSelectStep?.(chap.stepRunId)
                  }}
                  className={`rounded-sm px-1.5 py-0.5 text-small transition-colors ${
                    currentChapter?.stepRunId === chap.stepRunId
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {chap.ordinal + 1}. {chap.name}
                </button>
              ))}
            </div>
          ) : null}

          {/* 循环头章节：按项跳转 */}
          {currentChapter?.iterations?.length ? (
            <div className='flex max-w-full flex-wrap items-center gap-1' aria-label='按项跳转'>
              {currentChapter.iterations.map((segment) => (
                <button
                  key={segment.index}
                  type='button'
                  title={`第 ${segment.index + 1} 项`}
                  onClick={() => handleSeekTo(segment.fromMs, 'chapter')}
                  className={`min-w-6 rounded-sm px-1 py-0.5 text-small tabular-nums ${
                    segment.status === 'FAILED'
                      ? 'bg-status-error-background text-status-error-foreground'
                      : currentMs >= segment.fromMs && currentMs < segment.toMs
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  {segment.index + 1}
                </button>
              ))}
            </div>
          ) : null}

          {/* 上一步 / 下一步 */}
          <Button
            type='button'
            size='sm'
            variant='ghost'
            disabled={chapterModel.chapters.length === 0}
            onClick={handlePrevChapter}
            className='h-7 px-2 text-small'
          >
            <ChevronLeft className='size-3' />
            上一步
          </Button>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            disabled={chapterModel.chapters.length === 0}
            onClick={handleNextChapter}
            className='h-7 px-2 text-small'
          >
            下一步
            <ChevronRight className='size-3' />
          </Button>
        </div>
      </div>
    </div>
  )
}
