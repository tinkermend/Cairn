export const VIDEO_HEARTBEAT_INTERVAL_MS = 2000
export const VIDEO_FIRST_FRAME_WAIT_MS = 2000
export const VIDEO_MIN_FRAME_DURATION_MS = 1

export type TimedJpegFrame = {
  file: string
  tMs: number
  origin?: string
}

export type VideoTimeline = {
  frames: TimedJpegFrame[]
  sealedTMs: number
}

export function presentationMs(
  clock: { startedMonoMs: number; originSourceMs?: number; lastTMs: number },
  frame: { sourceTimestampMs?: number; receivedMonoMs: number },
): number {
  const fallback = Math.max(0, frame.receivedMonoMs - clock.startedMonoMs)
  let t = fallback
  if (frame.sourceTimestampMs != null && Number.isFinite(frame.sourceTimestampMs)) {
    if (clock.originSourceMs == null) {
      clock.originSourceMs = frame.sourceTimestampMs
      t = 0
    } else {
      t = frame.sourceTimestampMs - clock.originSourceMs
    }
  }
  if (!Number.isFinite(t) || t < 0) t = fallback
  t = Math.max(t, clock.lastTMs)
  t = Math.round(t)
  clock.lastTMs = t
  return t
}

export function capturedSpanMs(startedMonoMs: number, sealedMonoMs: number): number {
  return Math.max(0, Math.round(sealedMonoMs - startedMonoMs))
}

export type VideoSegmentWindow = {
  frames: TimedJpegFrame[]
  fromMs: number
  toMs: number
}

export function partitionVideoSegments(
  frames: TimedJpegFrame[],
  sealedTMs: number,
  segmentMs = 8_000,
): VideoSegmentWindow[] {
  if (frames.length === 0) return []
  const windows: VideoSegmentWindow[] = []
  let start = 0
  for (let i = 1; i <= frames.length; i += 1) {
    const last = i === frames.length
    const endT = last ? sealedTMs : frames[i]!.tMs
    const span = endT - frames[start]!.tMs
    if (last || span >= segmentMs) {
      windows.push({
        frames: frames.slice(start, i),
        fromMs: Math.round(frames[start]!.tMs),
        toMs: Math.round(Math.max(endT, frames[start]!.tMs + 1)),
      })
      start = i
    }
  }
  return windows
}

export function frameDurationsMs(frames: TimedJpegFrame[], sealedTMs: number): number[] {
  if (frames.length === 0) return []
  return frames.map((frame, index) => {
    const next = index + 1 < frames.length ? frames[index + 1]!.tMs : sealedTMs
    return Math.max(VIDEO_MIN_FRAME_DURATION_MS, Math.round(next - frame.tMs))
  })
}

export function buildConcatFile(frames: TimedJpegFrame[], sealedTMs: number): string {
  const durations = frameDurationsMs(frames, sealedTMs)
  const lines = ['ffconcat version 1.0']
  for (const [index, frame] of frames.entries()) {
    lines.push(`file ${frame.file}`)
    lines.push(`duration ${(durations[index]! / 1000).toFixed(3)}`)
  }
  const last = frames[frames.length - 1]
  if (last) lines.push(`file ${last.file}`)
  return `${lines.join('\n')}\n`
}

export function resampleToFrameGrid(
  frames: TimedJpegFrame[],
  sealedTMs: number,
  fps: number,
): TimedJpegFrame[] {
  if (frames.length === 0) return []
  const rate = fps > 0 ? fps : 2
  const span = Math.max(0, sealedTMs)
  const count = Math.max(1, Math.round((span * rate) / 1000))
  const picked: TimedJpegFrame[] = []
  let cursor = 0
  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : Math.round((i * span) / count)
    while (cursor + 1 < frames.length && frames[cursor + 1]!.tMs <= t) cursor += 1
    picked.push(frames[cursor]!)
  }
  return picked
}
