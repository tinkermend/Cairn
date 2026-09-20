export type CapturedFrameOrigin = 'cdp' | 'attach' | 'heartbeat' | 'final' | 'observer_refresh' | 'keyframe'

export type CapturedFrame = {
  pageId: string
  captureEpoch: number
  sourceSeq: number
  origin: CapturedFrameOrigin
  sourceTimestampMs?: number
  receivedMonoMs: number
  jpeg: Buffer
  width: number
  height: number
}

export function capturedFrameKey(frame: Pick<CapturedFrame, 'pageId' | 'captureEpoch' | 'origin' | 'sourceSeq'>): string {
  return `${frame.pageId}:${frame.captureEpoch}:${frame.origin}:${frame.sourceSeq}`
}
