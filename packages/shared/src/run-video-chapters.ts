import type { EvidenceMetadata } from './evidence.js'
import { faceScreenshot } from './evidence-slots.js'
import type { StepRunStatus } from './run.js'
import type { RunDetailDto } from './run-api.js'
import type { RunVideoPayload, VideoCoverageGapReason } from './run-video.js'

export type RunVideoGapKind = 'still' | 'blank'
export type RunVideoAlignment = 'exact' | 'approximate'

export type RunVideoChapter = {
  stepRunId: string
  stepId: string
  ordinal: number
  name: string
  type: string
  status: StepRunStatus
  fromMs: number
  toMs: number
  durationMs: number
  clipped: boolean
  attemptCount: number
  faceAttemptId?: string
  faceEvidenceId?: string
  moduleName?: string
}

export type RunVideoPin = {
  attemptId: string
  stepRunId: string
  attemptNo: number
  atMs: number
}

export type RunVideoGap = {
  fromMs: number
  toMs: number
  reason: VideoCoverageGapReason
  kind: RunVideoGapKind
}

export type RunVideoChapterModel = {
  clock: {
    originMs: number
    spanMs: number
    mediaMs: number
    alignment: RunVideoAlignment
  } | null
  chapters: RunVideoChapter[]
  pins: RunVideoPin[]
  gaps: RunVideoGap[]
  offAxisStepRunIds: string[]
}

export type BuildRunVideoChaptersInput = {
  run: RunDetailDto
  payload?: RunVideoPayload | null
  evidenceItems?: EvidenceMetadata[]
}

function mergeGaps(gaps: RunVideoGap[]): RunVideoGap[] {
  if (gaps.length <= 1) return gaps
  const sorted = [...gaps].sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs)
  const merged: RunVideoGap[] = [sorted[0]!]
  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i]!
    const prev = merged[merged.length - 1]!
    if (current.fromMs <= prev.toMs) {
      prev.toMs = Math.max(prev.toMs, current.toMs)
    } else {
      merged.push({ ...current })
    }
  }
  return merged
}

export function buildRunVideoChapters(input: BuildRunVideoChaptersInput): RunVideoChapterModel {
  const { run, payload, evidenceItems } = input
  const timing = payload?.timing
  if (
    !timing ||
    !timing.captureStartedAt ||
    !Number.isFinite(timing.capturedSpanMs) ||
    timing.capturedSpanMs <= 0
  ) {
    return {
      clock: null,
      chapters: [],
      pins: [],
      gaps: [],
      offAxisStepRunIds: [],
    }
  }

  const originMs = Date.parse(timing.captureStartedAt)
  if (Number.isNaN(originMs)) {
    return {
      clock: null,
      chapters: [],
      pins: [],
      gaps: [],
      offAxisStepRunIds: [],
    }
  }

  const spanMs = timing.capturedSpanMs
  const mediaMs = timing.decodedDurationMs
  const alignment: RunVideoAlignment = timing.timingMode === 'concat' ? 'exact' : 'approximate'

  // 缺口分类与裁剪合并
  const rawGaps = payload?.coverage?.gaps ?? []
  const stillGaps: RunVideoGap[] = []
  const blankGaps: RunVideoGap[] = []

  for (const gap of rawGaps) {
    const from = Math.max(0, gap.fromMs)
    const to = Math.min(spanMs, gap.toMs)
    if (to <= from) continue
    const kind: RunVideoGapKind =
      gap.reason === 'rate_limit' || gap.reason === 'paused' ? 'still' : 'blank'
    if (kind === 'still') {
      stillGaps.push({ fromMs: from, toMs: to, reason: gap.reason, kind })
    } else {
      blankGaps.push({ fromMs: from, toMs: to, reason: gap.reason, kind })
    }
  }

  const mergedGaps = [
    ...mergeGaps(stillGaps),
    ...mergeGaps(blankGaps),
  ].sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs)

  // 动作模块名映射
  const stepIdToModuleName = new Map<string, string>()
  for (const entry of run.snapshot?.moduleManifest?.entries ?? []) {
    for (const expId of entry.expandedStepIds) {
      stepIdToModuleName.set(expId, entry.name)
    }
  }

  const chapters: RunVideoChapter[] = []
  const pins: RunVideoPin[] = []
  const offAxisStepRunIds: string[] = []

  // 按 ordinal 稳定排序
  const sortedStepRuns = [...run.stepRuns].sort((a, b) => a.ordinal - b.ordinal)

  for (const stepRun of sortedStepRuns) {
    // 失败钉收集（每个已结束且 status === 'FAILED' 的 Attempt，钉在 finishedAt）
    for (const attempt of stepRun.attempts) {
      if (attempt.status === 'FAILED' && attempt.finishedAt) {
        const atMs = Date.parse(attempt.finishedAt) - originMs
        if (atMs >= 0 && atMs <= spanMs) {
          pins.push({
            attemptId: attempt.id,
            stepRunId: stepRun.id,
            attemptNo: attempt.attemptNo,
            atMs,
          })
        }
      }
    }

    // 未开始、SKIPPED 或无 Attempt 的 StepRun 不上轴
    if (!stepRun.startedAt || stepRun.status === 'SKIPPED' || stepRun.attempts.length === 0) {
      continue
    }

    const startedUtc = Date.parse(stepRun.startedAt)
    const fromMs = startedUtc - originMs
    const finishedUtc = stepRun.finishedAt ? Date.parse(stepRun.finishedAt) : null
    const toMs = finishedUtc != null ? finishedUtc - originMs : Math.max(fromMs, spanMs)

    // 墙钟耗时（finishedAt - startedAt，若无则 0）
    const durationMs = finishedUtc != null ? Math.max(0, finishedUtc - startedUtc) : 0

    // 轴外判定：与 [0, spanMs] 无交集
    if (toMs <= 0 || fromMs >= spanMs) {
      offAxisStepRunIds.push(stepRun.id)
      continue
    }

    const clipped = fromMs < 0 || toMs > spanMs
    let clampedFrom = Math.max(0, fromMs)
    let clampedTo = Math.min(spanMs, toMs)

    // fromMs === toMs 逻辑上按 1ms，命中宽度至少 1ms
    if (clampedFrom === clampedTo) {
      if (clampedFrom < spanMs) {
        clampedTo = Math.min(spanMs, clampedFrom + 1)
      } else if (clampedTo > 0) {
        clampedFrom = Math.max(0, clampedTo - 1)
      }
    }

    // 取最后一次已结束的 Attempt 的主截图
    const finishedAttempts = stepRun.attempts
      .filter((a) => a.status !== 'RUNNING')
      .sort((a, b) => a.attemptNo - b.attemptNo)
    const lastFinished = finishedAttempts[finishedAttempts.length - 1]
    const faceItem = lastFinished && evidenceItems ? faceScreenshot(evidenceItems, lastFinished.id) : undefined

    chapters.push({
      stepRunId: stepRun.id,
      stepId: stepRun.stepId,
      ordinal: stepRun.ordinal,
      name: stepRun.name,
      type: stepRun.type,
      status: stepRun.status,
      fromMs: clampedFrom,
      toMs: clampedTo,
      durationMs,
      clipped,
      attemptCount: stepRun.attempts.length,
      faceAttemptId: lastFinished?.id,
      faceEvidenceId: faceItem?.id,
      moduleName: stepIdToModuleName.get(stepRun.stepId),
    })
  }

  pins.sort((a, b) => a.atMs - b.atMs)

  return {
    clock: {
      originMs,
      spanMs,
      mediaMs,
      alignment,
    },
    chapters,
    pins,
    gaps: mergedGaps,
    offAxisStepRunIds,
  }
}

export function captureMsToMediaSeconds(
  captureMs: number,
  clock: { mediaMs: number },
): number {
  return Math.max(0, Math.min(clock.mediaMs, captureMs)) / 1000
}

export function mediaSecondsToCaptureMs(
  mediaSeconds: number,
  clock?: { mediaMs: number; alignment?: RunVideoAlignment },
): number {
  const ms = Math.round(Math.max(0, mediaSeconds) * 1000)
  if (clock && Number.isFinite(clock.mediaMs)) {
    return Math.min(clock.mediaMs, ms)
  }
  return ms
}

export function chapterAtPlayhead(
  chapters: RunVideoChapter[],
  currentMs: number,
  blankGaps?: RunVideoGap[],
): RunVideoChapter | null {
  // 1. 落在 blank 段内：没有画面，不高亮列表步骤
  if (blankGaps && blankGaps.some((g) => g.kind === 'blank' && currentMs >= g.fromMs && currentMs < g.toMs)) {
    return null
  }

  // 2. 落在某章 [fromMs, toMs) 内；多章重叠时取 fromMs 最大、其次 ordinal 最大的一章
  const matched = chapters.filter((c) => currentMs >= c.fromMs && currentMs < c.toMs)
  if (matched.length === 0) {
    // 边界：刚好落在最后一章的 toMs 上且等于片尾
    const atEnd = chapters.filter((c) => currentMs === c.toMs && c.toMs > c.fromMs)
    if (atEnd.length > 0) {
      return atEnd.sort((a, b) => b.fromMs - a.fromMs || b.ordinal - a.ordinal)[0]!
    }
    return null
  }
  return matched.sort((a, b) => b.fromMs - a.fromMs || b.ordinal - a.ordinal)[0]!
}

export function gapAtPlayhead(
  gaps: RunVideoGap[],
  currentMs: number,
): RunVideoGap | null {
  return (
    gaps.find((g) => currentMs >= g.fromMs && currentMs < g.toMs) ??
    gaps.find((g) => currentMs === g.toMs && g.toMs > g.fromMs) ??
    null
  )
}
