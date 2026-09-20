import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import jpeg from 'jpeg-js'
import {
  markEvidenceMissing,
  reserveObjectEvidence,
} from '@cairn/db'
import {
  BROWSER_FRAME_MAX_EDGE,
  BROWSER_FRAME_MAX_FPS,
  BROWSER_FRAME_QUALITY,
  OBJECT_MISSING_REASONS,
  retainUntilFor,
  resolveEvidencePolicy,
  writeEvidenceArtifactKey,
  type RunSnapshot,
} from '@cairn/shared'
import type { ObjectService } from '../objects/object.service.js'
import { capturedFrameKey, type CapturedFrame } from './captured-frame.js'
import { pageRefFor } from './page-identity.js'
import { screenshotMaskLocators } from './runtime.js'
import { startScreencast } from './screencast.js'
import type { SessionManagerContext } from './session-live.js'
import {
  VIDEO_FIRST_FRAME_WAIT_MS,
  VIDEO_HEARTBEAT_INTERVAL_MS,
  capturedSpanMs,
  presentationMs,
  type TimedJpegFrame,
} from './video-timeline.js'

export type RunVideoRecorder = {
  runId: string
  leaseId: string
  sessionId: string
  pageId: string
  captureEpoch: number
  dir: string
  frameIndex: number
  jpegBytes: number
  jpegBudget: number
  lastWriteAt: number
  lastAcceptedMonoMs: number
  lastKey?: string
  lastTMs: number
  originSourceMs?: number
  startedMonoMs: number
  startedAt: Date
  unsubscribe?: () => void
  poll?: ReturnType<typeof setInterval>
  heartbeat?: ReturnType<typeof setInterval>
  passwordMask: 'applied' | 'failed'
  truncated: boolean
  accepting: boolean
  sealed: boolean
  writeChain: Promise<void>
  retargetChain: Promise<void>
  frames: TimedJpegFrame[]
  framesDropped: {
    rateLimited: number
    budget: number
    maskFailed: number
  }
  finalFrame: 'captured' | 'failed' | 'page_closed'
  sealedAt?: Date
  sealedMonoMs?: number
  localSeq: number
  sensitiveSelectors: string[]
}

export type SealedRunVideo = {
  recorder: RunVideoRecorder
  leaseId: string
}

const FRAME_INTERVAL_MS = Math.max(500, Math.floor(1000 / BROWSER_FRAME_MAX_FPS))

export function enqueueRecorderWrite(
  recorder: Pick<RunVideoRecorder, 'writeChain'>,
  work: () => Promise<void>,
): Promise<void> {
  const next = (recorder.writeChain ?? Promise.resolve()).then(work, work)
  recorder.writeChain = next.catch(() => undefined)
  return next
}

export async function flushRecorderWrites(
  recorder: Pick<RunVideoRecorder, 'writeChain'>,
): Promise<void> {
  await (recorder.writeChain ?? Promise.resolve()).catch(() => undefined)
}

function recordersOf(manager: SessionManagerContext): Map<string, RunVideoRecorder> {
  return manager.videoRecorders
}

async function persistTimeline(recorder: RunVideoRecorder): Promise<void> {
  await writeFile(
    join(recorder.dir, 'timeline.json'),
    JSON.stringify({
      frames: recorder.frames,
      sealedTMs: recorder.sealedMonoMs != null ? capturedSpanMs(recorder.startedMonoMs, recorder.sealedMonoMs) : undefined,
    }),
  )
}

async function maskPasswordBoxes(
  jpegBytes: Buffer,
  boxes: { x: number; y: number; width: number; height: number }[],
  frameWidth: number,
  frameHeight: number,
): Promise<Buffer> {
  if (boxes.length === 0) return jpegBytes
  const decoded = jpeg.decode(jpegBytes, { useTArray: true })
  const scaleX = decoded.width / Math.max(1, frameWidth)
  const scaleY = decoded.height / Math.max(1, frameHeight)
  const data = decoded.data
  for (const box of boxes) {
    const left = Math.max(0, Math.floor(box.x * scaleX))
    const top = Math.max(0, Math.floor(box.y * scaleY))
    const right = Math.min(decoded.width, Math.ceil((box.x + box.width) * scaleX))
    const bottom = Math.min(decoded.height, Math.ceil((box.y + box.height) * scaleY))
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * decoded.width + x) * 4
        data[offset] = 0
        data[offset + 1] = 0
        data[offset + 2] = 0
      }
    }
  }
  return Buffer.from(jpeg.encode({ data, width: decoded.width, height: decoded.height }, BROWSER_FRAME_QUALITY).data)
}

export async function passwordBoxes(
  page: {
    locator?: (selector: string) => {
      evaluateAll: (
        fn: (els: { getBoundingClientRect: () => { x: number; y: number; width: number; height: number } }[]) => unknown,
      ) => Promise<unknown>
    }
  },
  selectors: readonly string[] = ['input[type=password]'],
): Promise<{ x: number; y: number; width: number; height: number }[] | null> {
  if (typeof page.locator !== 'function') return []
  try {
    const collected: { x: number; y: number; width: number; height: number }[] = []
    for (const selector of selectors) {
      const boxes = await page.locator(selector).evaluateAll((els) =>
        els.map((el) => {
          const rect = el.getBoundingClientRect()
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }),
      )
      if (Array.isArray(boxes)) collected.push(...(boxes as { x: number; y: number; width: number; height: number }[]))
    }
    return collected
  } catch {
    return null
  }
}

function visibleBoxes(boxes: { width: number; height: number }[]): boolean {
  return boxes.some((box) => box.width > 1 && box.height > 1)
}

export async function writeCapturedFrame(
  recorder: RunVideoRecorder,
  frame: CapturedFrame,
  boxes: { x: number; y: number; width: number; height: number }[] | null,
): Promise<void> {
  if (recorder.sealed) return
  if (frame.origin === 'observer_refresh') return
  const key = capturedFrameKey(frame)
  if (key === recorder.lastKey) return
  if (
    frame.origin === 'cdp' &&
    recorder.frameIndex > 0 &&
    frame.receivedMonoMs - recorder.lastAcceptedMonoMs < FRAME_INTERVAL_MS
  ) {
    recorder.framesDropped.rateLimited += 1
    return
  }
  if (recorder.jpegBytes + frame.jpeg.byteLength > recorder.jpegBudget) {
    recorder.truncated = true
    recorder.framesDropped.budget += 1
    return
  }
  let body = frame.jpeg
  if (boxes === null) {
    recorder.passwordMask = 'failed'
  } else if (boxes.length > 0) {
    try {
      body = await maskPasswordBoxes(frame.jpeg, boxes, frame.width, frame.height)
    } catch {
      recorder.passwordMask = 'failed'
      recorder.framesDropped.maskFailed += 1
      return
    }
  }
  const tMs = presentationMs(recorder, frame)
  const path = join(recorder.dir, `frame_${String(recorder.frameIndex).padStart(5, '0')}.jpg`)
  await writeFile(path, body)
  recorder.frames.push({
    file: `frame_${String(recorder.frameIndex).padStart(5, '0')}.jpg`,
    tMs,
    origin: frame.origin,
  })
  recorder.frameIndex += 1
  recorder.jpegBytes += body.byteLength
  recorder.lastWriteAt = Date.now()
  recorder.lastAcceptedMonoMs = frame.receivedMonoMs
  recorder.lastKey = key
  await persistTimeline(recorder).catch(() => undefined)
}

export async function acceptCapturedFrame(
  recorder: RunVideoRecorder,
  frame: CapturedFrame,
  boxes: { x: number; y: number; width: number; height: number }[] | null,
): Promise<void> {
  if (recorder.sealed) return
  await writeCapturedFrame(recorder, frame, boxes)
}

function videoUsesPage(manager: SessionManagerContext, pageId: string): boolean {
  return [...recordersOf(manager).values()].some((item) => item.pageId === pageId && item.accepting)
}

export async function releaseScreencastIfIdle(
  this: SessionManagerContext,
  live: import('./session-live.js').LiveHandle,
  pageId: string,
): Promise<void> {
  if ((live.screencastObservers.get(pageId) ?? 0) > 0) return
  if (videoUsesPage(this, pageId)) return
  const cast = live.screencasts.get(pageId)
  live.screencasts.delete(pageId)
  await cast?.stop().catch(() => undefined)
}

function nextLocalFrame(
  recorder: RunVideoRecorder,
  origin: 'attach' | 'heartbeat' | 'final' | 'keyframe',
  jpegBytes: Buffer,
  width: number,
  height: number,
): CapturedFrame {
  recorder.localSeq += 1
  return {
    pageId: recorder.pageId,
    captureEpoch: recorder.captureEpoch,
    sourceSeq: recorder.localSeq,
    origin,
    receivedMonoMs: performance.now(),
    jpeg: jpegBytes,
    width,
    height,
  }
}

async function capturePageJpeg(page: {
  isClosed?: () => boolean
  screenshot?: (opts: { type: 'jpeg'; quality: number }) => Promise<Buffer>
  viewportSize?: () => { width: number; height: number } | null
}): Promise<{ jpeg: Buffer; width: number; height: number } | undefined> {
  if (page.isClosed?.() || typeof page.screenshot !== 'function') return undefined
  const shot = await page.screenshot({ type: 'jpeg', quality: BROWSER_FRAME_QUALITY })
  const viewport = page.viewportSize?.() ?? { width: BROWSER_FRAME_MAX_EDGE, height: 720 }
  return { jpeg: shot, width: viewport.width, height: viewport.height }
}

function startHeartbeat(
  recorder: RunVideoRecorder,
  page: {
    isClosed?: () => boolean
    screenshot?: (opts: { type: 'jpeg'; quality: number }) => Promise<Buffer>
    viewportSize?: () => { width: number; height: number } | null
    locator?: (selector: string) => {
      evaluateAll: (
        fn: (els: { getBoundingClientRect: () => { x: number; y: number; width: number; height: number } }[]) => unknown,
      ) => Promise<unknown>
    }
  },
): void {
  if (recorder.heartbeat) return
  recorder.heartbeat = setInterval(() => {
    void enqueueRecorderWrite(recorder, async () => {
      if (!recorder.accepting || page.isClosed?.()) return
      try {
        const shot = await capturePageJpeg(page)
        if (!shot) return
        const boxes = await passwordBoxes(page)
        await writeCapturedFrame(recorder, nextLocalFrame(recorder, 'heartbeat', shot.jpeg, shot.width, shot.height), boxes)
      } catch {
        return
      }
    })
  }, VIDEO_HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat(recorder: RunVideoRecorder): void {
  if (recorder.heartbeat) {
    clearInterval(recorder.heartbeat)
    recorder.heartbeat = undefined
  }
}

async function attachRecorder(
  this: SessionManagerContext,
  recorder: RunVideoRecorder,
  live: import('./session-live.js').LiveHandle,
  pageId: string,
): Promise<void> {
  const entry = live.pages.get(pageId)
  if (!entry || entry.page.isClosed()) return
  const pageRef = pageRefFor(live.sessionId, live.generation, entry)
  let cast = live.screencasts.get(pageId)
  if (!cast) {
    cast = await startScreencast(entry.page, pageRef)
    live.screencasts.set(pageId, cast)
  }
  recorder.pageId = pageId
  recorder.captureEpoch = cast.captureEpoch ?? recorder.captureEpoch
  const onCaptured = (frame: CapturedFrame) => {
    if (!recorder.accepting) return
    void enqueueRecorderWrite(recorder, async () => {
      if (recorder.sealed) return
      const password = await passwordBoxes(entry.page)
      const extra = recorder.sensitiveSelectors.length
        ? await passwordBoxes(entry.page, recorder.sensitiveSelectors)
        : []
      if (extra && visibleBoxes(extra) && typeof entry.page.screenshot === 'function') {
        const jpegBytes = await entry.page.screenshot({
          type: 'jpeg',
          quality: BROWSER_FRAME_QUALITY,
          mask: screenshotMaskLocators(entry.page, recorder.sensitiveSelectors),
        })
        const viewport = entry.page.viewportSize?.() ?? { width: BROWSER_FRAME_MAX_EDGE, height: 720 }
        await writeCapturedFrame(
          recorder,
          nextLocalFrame(recorder, 'keyframe', jpegBytes, viewport.width, viewport.height),
          [],
        )
        return
      }
      await acceptCapturedFrame(recorder, frame, password)
    })
  }
  if (typeof cast.subscribeCaptured === 'function') {
    recorder.unsubscribe = cast.subscribeCaptured(onCaptured)
  }
  startHeartbeat(recorder, entry.page)
  const attach = (async () => {
    const shot = await capturePageJpeg(entry.page)
    if (!shot) return
    const boxes = await passwordBoxes(entry.page)
    await writeCapturedFrame(recorder, nextLocalFrame(recorder, 'attach', shot.jpeg, shot.width, shot.height), boxes)
  })()
  const finished = await Promise.race([
    attach.then(() => 'ok' as const).catch(() => 'failed' as const),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), VIDEO_FIRST_FRAME_WAIT_MS)
    }),
  ])
  if (finished !== 'ok') {
    void attach.catch(() => undefined)
  }
}

async function detachRecorder(recorder: RunVideoRecorder): Promise<void> {
  recorder.unsubscribe?.()
  recorder.unsubscribe = undefined
  stopHeartbeat(recorder)
  if (recorder.poll) {
    clearInterval(recorder.poll)
    recorder.poll = undefined
  }
  await flushRecorderWrites(recorder)
}

export async function startVideoForLease(
  this: SessionManagerContext,
  leaseId: string,
  sessionId: string,
  run: RunSnapshot,
): Promise<void> {
  const objects = this.objects as ObjectService | undefined
  if (!objects) return
  const policy = resolveEvidencePolicy(run.evidencePolicy)
  if (policy.video !== 'always') return
  const existing = recordersOf(this).get(leaseId)
  if (existing) return
  const live = this.lives.get(sessionId)
  if (!live) return
  const maxBytes = objects.videoMaxBytes()
  const retainUntil = retainUntilFor('video', policy)
  await reserveObjectEvidence(this.dbHandle, {
    runId: run.runId,
    type: 'video',
    artifactKey: writeEvidenceArtifactKey({ type: 'video' }),
    retainUntil,
  })
  const recorder: RunVideoRecorder = {
    runId: run.runId,
    leaseId,
    sessionId,
    pageId: '',
    captureEpoch: 0,
    dir: join(tmpdir(), `cairn-video-${run.runId}`),
    frameIndex: 0,
    jpegBytes: 0,
    jpegBudget: maxBytes * 3,
    lastWriteAt: 0,
    lastAcceptedMonoMs: Number.NEGATIVE_INFINITY,
    lastTMs: 0,
    startedMonoMs: performance.now(),
    startedAt: new Date(),
    passwordMask: 'applied',
    truncated: false,
    accepting: true,
    sealed: false,
    writeChain: Promise.resolve(),
    retargetChain: Promise.resolve(),
    frames: [],
    framesDropped: { rateLimited: 0, budget: 0, maskFailed: 0 },
    finalFrame: 'page_closed',
    localSeq: 0,
    sensitiveSelectors: run.targetAuth?.sensitiveSelectors ?? [],
  }
  await mkdir(recorder.dir, { recursive: true })
  recordersOf(this).set(leaseId, recorder)
  const pageId =
    live.currentPageIdByLease.get(leaseId) ??
    live.currentPageIdByRun.get(run.runId) ??
    [...live.pages.values()].find((page) => page.runId === run.runId)?.pageId
  if (pageId) {
    try {
      await attachRecorder.call(this, recorder, live, pageId)
    } catch {
      // 采集接入失败不阻断领取；起始缺口由缺 attach 帧体现，覆盖计算属 B 期。
    }
  }
}

export function rebindVideoForLease(
  this: SessionManagerContext,
  fromLeaseId: string,
  toLeaseId: string,
): void {
  if (fromLeaseId === toLeaseId) return
  const recorder = recordersOf(this).get(fromLeaseId)
  if (!recorder || !recorder.accepting) return
  recordersOf(this).delete(fromLeaseId)
  recorder.leaseId = toLeaseId
  recordersOf(this).set(toLeaseId, recorder)
}

export async function retargetVideoForLease(
  this: SessionManagerContext,
  live: import('./session-live.js').LiveHandle,
  leaseId: string,
): Promise<void> {
  const recorder = recordersOf(this).get(leaseId)
  if (!recorder || !recorder.accepting || recorder.sealed) return
  const work = (async () => {
    if (!recorder.accepting || recorder.sealed) return
    const next =
      live.currentPageIdByLease.get(leaseId) ?? live.currentPageIdByRun.get(recorder.runId)
    if (!next || next === recorder.pageId) return
    const previous = recorder.pageId
    await detachRecorder(recorder)
    if (!recorder.accepting || recorder.sealed) return
    await attachRecorder.call(this, recorder, live, next)
    if (previous) await releaseScreencastIfIdle.call(this, live, previous)
  })()
  recorder.retargetChain = recorder.retargetChain.then(() => work, () => work)
  await work
}

async function writeFinalFrame(this: SessionManagerContext, recorder: RunVideoRecorder): Promise<void> {
  const live = this.lives.get(recorder.sessionId)
  const entry = live?.pages.get(recorder.pageId)
  if (!entry || entry.page.isClosed()) {
    recorder.finalFrame = 'page_closed'
    return
  }
  try {
    const shot = await capturePageJpeg(entry.page)
    if (!shot) {
      recorder.finalFrame = 'failed'
      return
    }
    const boxes = await passwordBoxes(entry.page)
    await writeCapturedFrame(recorder, nextLocalFrame(recorder, 'final', shot.jpeg, shot.width, shot.height), boxes)
    recorder.finalFrame = 'captured'
  } catch {
    recorder.finalFrame = 'failed'
  }
}

export async function sealVideoForLease(this: SessionManagerContext, leaseId: string): Promise<SealedRunVideo | null> {
  const recorder = recordersOf(this).get(leaseId)
  if (!recorder) return null
  if (recorder.sealed) return { recorder, leaseId }
  recorder.accepting = false
  await recorder.retargetChain.catch(() => undefined)
  const live = this.lives.get(recorder.sessionId)
  const pageId = recorder.pageId
  await detachRecorder(recorder)
  await writeFinalFrame.call(this, recorder)
  recorder.sealed = true
  recorder.sealedAt = new Date()
  recorder.sealedMonoMs = performance.now()
  await persistTimeline(recorder).catch(() => undefined)
  if (live && pageId) await releaseScreencastIfIdle.call(this, live, pageId)
  return { recorder, leaseId }
}

export async function finalizeSealedVideo(
  this: SessionManagerContext,
  sealed: SealedRunVideo | null,
): Promise<void> {
  if (!sealed) return
  const { recorder, leaseId } = sealed
  try {
    const names = (await readdir(recorder.dir).catch(() => [])).filter((name) => name.endsWith('.jpg')).sort()
    if (names.length === 0 || !this.objects) {
      const reserved = await reserveObjectEvidence(this.dbHandle, {
        runId: recorder.runId,
        type: 'video',
        artifactKey: writeEvidenceArtifactKey({ type: 'video' }),
        retainUntil: new Date(Date.now() + 14 * 86_400_000),
      })
      if (reserved.status === 'pending') {
        await markEvidenceMissing(this.dbHandle, {
          id: reserved.id,
          reason: OBJECT_MISSING_REASONS.captureFailed,
        })
      }
      await rm(recorder.dir, { recursive: true, force: true }).catch(() => undefined)
      return
    }
    try {
      const { dispatchSealedRunVideo } = await import('./run-video-media.js')
      await dispatchSealedRunVideo(this, sealed)
    } catch (error) {
      this.logger.warn(
        { runId: recorder.runId, leaseId, err: error instanceof Error ? error.message : String(error) },
        'run.video.finalize_failed',
      )
    }
  } finally {
    recordersOf(this).delete(leaseId)
  }
}

export async function discardSealedVideo(
  this: SessionManagerContext,
  sealed: SealedRunVideo | null,
): Promise<void> {
  if (!sealed) return
  recordersOf(this).delete(sealed.leaseId)
  await rm(sealed.recorder.dir, { recursive: true, force: true }).catch(() => undefined)
}

export async function stopVideoForLease(this: SessionManagerContext, leaseId: string): Promise<void> {
  const sealed = await sealVideoForLease.call(this, leaseId)
  await finalizeSealedVideo.call(this, sealed)
}
