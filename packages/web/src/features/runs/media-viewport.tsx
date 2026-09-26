import { useState } from 'react'
import {
  isFinishedRunStatus,
  type EvidenceMetadata,
  type RunDetailDto,
} from '@cairn/shared'
import {
  ChevronDown,
  ChevronUp,
  Tv,
  Video,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BrowserView } from './browser-view'
import { RunVideoSection, shouldShowRunVideo } from './run-video'

type Props = {
  run: RunDetailDto
  evidenceItems: EvidenceMetadata[]
  currentStepRunId?: string | null
  onChapterChange?: (stepRunId: string | null) => void
  seekRequest?: {
    token: number
    ms: number
    source: 'chapter' | 'list' | 'deeplink' | 'pin'
  } | null
  onSelectStep?: (stepRunId: string, attemptId?: string) => void
  offAxisSelectedStep?: { ordinal: number; name: string } | null
  eventSeq?: number
  onRunChanged?: () => void
}

export function MediaViewport({
  run,
  evidenceItems,
  currentStepRunId,
  onChapterChange,
  seekRequest,
  onSelectStep,
  offAxisSelectedStep,
  eventSeq = 0,
  onRunChanged,
}: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const finished = isFinishedRunStatus(run.status)
  const showVideo = shouldShowRunVideo(run, evidenceItems)

  // 如果已结束且不需要展示录像，媒体视口不占位
  if (finished && !showVideo) {
    return null
  }

  return (
    <div
      aria-label='伴随媒体视口'
      className='rounded-lg border border-border-card bg-card shadow-card overflow-hidden shrink-0 transition-all'
    >
      {/* 媒体视口可折叠工具条 */}
      <div className='flex items-center justify-between border-b border-border-divider bg-surface-header px-3 py-1.5 text-label'>
        <div className='flex items-center gap-2'>
          {!finished ? (
            <>
              <Tv className='size-3.5 text-primary animate-pulse' />
              <span className='font-medium text-foreground'>受管浏览器实时推流</span>
              <span className='rounded bg-status-info-background px-1.5 py-0.2 text-3xs font-medium text-status-info-foreground'>
                实时执行中
              </span>
            </>
          ) : (
            <>
              <Video className='size-3.5 text-primary' />
              <span className='font-medium text-foreground'>执行录像与章节对齐</span>
            </>
          )}
        </div>

        <Button
          variant='ghost'
          size='sm'
          className='h-6 px-1.5 text-caption text-muted-foreground hover:text-foreground'
          onClick={() => setCollapsed((prev) => !prev)}
        >
          {collapsed ? (
            <>
              <ChevronDown className='mr-1 size-3' />
              展开画面
            </>
          ) : (
            <>
              <ChevronUp className='mr-1 size-3' />
              折叠画面
            </>
          )}
        </Button>
      </div>

      {/* 媒体内容区 */}
      {!collapsed ? (
        <div className='p-3 bg-card'>
          {!finished ? (
            <BrowserView
              runId={run.id}
              runStatus={run.status}
              eventSeq={eventSeq}
              onRunChanged={onRunChanged}
            />
          ) : (
            <RunVideoSection
              run={run}
              items={evidenceItems}
              currentStepRunId={currentStepRunId}
              onChapterChange={onChapterChange}
              seekRequest={seekRequest}
              offAxisSelectedStep={offAxisSelectedStep}
              onSelectStep={onSelectStep}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}
