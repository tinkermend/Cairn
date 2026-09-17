import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import jpeg from 'jpeg-js'
import {
  markEvidenceMissing,
  reserveObjectEvidence,
} from '@cairn/db'
import {
  BROWSER_FRAME_MAX_FPS,
  BROWSER_FRAME_QUALITY,
  OBJECT_MISSING_REASONS,
  retainUntilFor,
  resolveEvidencePolicy,
  type ManagedBrowserFrame,
  type RunSnapshot,
} from '@cairn/shared'
import type { ObjectService } from '../objects/object.service.js'
import { pageRefFor } from './page-identity.js'
import { startScreencast } from './screencast.js'
import type { SessionManagerContext } from './session-live.js'
import { encodeJpegDirectoryToWebm, isPlayableWebm } from './video-encoder.js'

export type RunVideoRecorder = {
  runId: string
  leaseId: string
  sessionId: string
  pageId: string
  dir: string
  frameIndex: number
  jpegBytes: number
  jpegBudget: number
  lastWriteAt: number
  lastFrameId?: string
  unsubscribe?: () => void
  poll?: ReturnType<typeof setInterval>
  passwordMask: 'applied' | 'failed'
  truncated: boolean
  stopped: boolean
  writeChain: Promise<void>
}

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

const FRAME_INTERVAL_MS = Math.max(500, Math.floor(1000 / BROWSER_FRAME_MAX_FPS))

function recordersOf(manager: SessionManagerContext): Map<string, RunVideoRecorder> {
  return manager.videoRecorders
}

function jpegFromFrame(image: string): Buffer | undefined {
  const comma = image.indexOf(',')
  if (comma < 0) return undefined
  try {
    return Buffer.from(image.slice(comma + 1), 'base64')
  } catch {
    return undefined
  }
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

async function passwordBoxes(
  page: {
    locator?: (selector: string) => {
      evaluateAll: (
        fn: (els: { getBoundingClientRect: () => { x: number; y: number; width: number; height: number } }[]) => unknown,
      ) => Promise<unknown>
    }
  },
): Promise<{ x: number; y: number; width: number; height: number }[] | null> {
  if (typeof page.locator !== 'function') return []
  try {
    const boxes = await page.locator('input[type=password]').evaluateAll((els) =>
      els.map((el) => {
        const rect = el.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }),
    )
    return Array.isArray(boxes) ? (boxes as { x: number; y: number; width: number; height: number }[]) : []
  } catch {
    return null
  }
}

async function writeFrame(
  recorder: RunVideoRecorder,
  jpegBytes: Buffer,
  boxes: { x: number; y: number; width: number; height: number }[] | null,
  frameWidth: number,
  frameHeight: number,
): Promise<void> {
  if (recorder.stopped) return
  if (recorder.jpegBytes + jpegBytes.byteLength > recorder.jpegBudget) {
    recorder.truncated = true
    return
  }
  let body = jpegBytes
  if (boxes === null) {
    recorder.passwordMask = 'failed'
  } else if (boxes.length > 0) {
    try {
      body = await maskPasswordBoxes(jpegBytes, boxes, frameWidth, frameHeight)
    } catch {
      recorder.passwordMask = 'failed'
    }
  }
  const path = join(recorder.dir, `frame_${String(recorder.frameIndex).padStart(5, '0')}.jpg`)
  await writeFile(path, body)
  recorder.frameIndex += 1
  recorder.jpegBytes += body.byteLength
  recorder.lastWriteAt = Date.now()
}

async function acceptFrame(
  recorder: RunVideoRecorder,
  frame: ManagedBrowserFrame,
  boxes: { x: number; y: number; width: number; height: number }[] | null,
): Promise<void> {
  if (recorder.stopped || frame.frameId === recorder.lastFrameId) return
  if (Date.now() - recorder.lastWriteAt < FRAME_INTERVAL_MS && recorder.frameIndex > 0) return
  const jpegBytes = jpegFromFrame(frame.image)
  if (!jpegBytes || jpegBytes.byteLength === 0) return
  recorder.lastFrameId = frame.frameId
  await writeFrame(recorder, jpegBytes, boxes, frame.width, frame.height)
}

function videoUsesPage(manager: SessionManagerContext, pageId: string): boolean {
  return [...recordersOf(manager).values()].some((item) => item.pageId === pageId && !item.stopped)
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

async function attachRecorder(
  this: SessionManagerContext,
  recorder: RunVideoRecorder,
  live: import('./session-live.js').LiveHandle,
  pageId: string,
): Promise<void> {
  const entry = live.pages.get(pageId)
  if (!entry || entry.page.isClosed()) return
  const pageRef = pageRefFor(live.sessionId, 1, entry)
  let cast = live.screencasts.get(pageId)
  if (!cast) {
    cast = await startScreencast(entry.page, pageRef)
    live.screencasts.set(pageId, cast)
  }
  recorder.pageId = pageId
  try {
    const shot = await entry.page.screenshot({ type: 'jpeg', quality: BROWSER_FRAME_QUALITY })
    const boxes = await passwordBoxes(entry.page)
    const viewport = entry.page.viewportSize?.() ?? { width: shot.byteLength, height: 720 }
    await writeFrame(recorder, shot, boxes, viewport.width, viewport.height)
  } catch {
    recorder.passwordMask = 'failed'
  }
  const onFrame = (frame: ManagedBrowserFrame) => {
    void enqueueRecorderWrite(recorder, async () => {
      if (recorder.stopped) return
      const boxes = await passwordBoxes(entry.page)
      await acceptFrame(recorder, frame, boxes)
    })
  }
  if (typeof cast.subscribe === 'function') {
    recorder.unsubscribe = cast.subscribe(onFrame)
  } else {
    recorder.poll = setInterval(() => {
      if (cast?.latest) onFrame(cast.latest)
    }, FRAME_INTERVAL_MS)
  }
  if (cast.latest) onFrame(cast.latest)
}

async function detachRecorder(recorder: RunVideoRecorder): Promise<void> {
  recorder.unsubscribe?.()
  recorder.unsubscribe = undefined
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
  if (existing && !existing.stopped) return
  const live = this.lives.get(sessionId)
  if (!live) return
  const maxBytes = objects.videoMaxBytes()
  const retainUntil = retainUntilFor('video', policy)
  await reserveObjectEvidence(this.dbHandle, {
    runId: run.runId,
    type: 'video',
    retainUntil,
  })
  const recorder: RunVideoRecorder = {
    runId: run.runId,
    leaseId,
    sessionId,
    pageId: '',
    dir: join(tmpdir(), `cairn-video-${run.runId}`),
    frameIndex: 0,
    jpegBytes: 0,
    jpegBudget: maxBytes * 3,
    lastWriteAt: 0,
    passwordMask: 'applied',
    truncated: false,
    stopped: false,
    writeChain: Promise.resolve(),
  }
  await mkdir(recorder.dir, { recursive: true })
  recordersOf(this).set(leaseId, recorder)
  const pageId =
    live.currentPageIdByLease.get(leaseId) ??
    live.currentPageIdByRun.get(run.runId) ??
    [...live.pages.values()].find((page) => page.runId === run.runId)?.pageId
  if (pageId) await attachRecorder.call(this, recorder, live, pageId)
}

export function rebindVideoForLease(
  this: SessionManagerContext,
  fromLeaseId: string,
  toLeaseId: string,
): void {
  if (fromLeaseId === toLeaseId) return
  const recorder = recordersOf(this).get(fromLeaseId)
  if (!recorder || recorder.stopped) return
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
  if (!recorder || recorder.stopped) return
  const next =
    live.currentPageIdByLease.get(leaseId) ?? live.currentPageIdByRun.get(recorder.runId)
  if (!next || next === recorder.pageId) return
  const previous = recorder.pageId
  await detachRecorder(recorder)
  await attachRecorder.call(this, recorder, live, next)
  if (previous) await releaseScreencastIfIdle.call(this, live, previous)
}

export async function stopVideoForLease(this: SessionManagerContext, leaseId: string): Promise<void> {
  const recorder = recordersOf(this).get(leaseId)
  if (!recorder || recorder.stopped) {
    recordersOf(this).delete(leaseId)
    return
  }
  recorder.stopped = true
  const objects = this.objects as ObjectService | undefined
  const live = this.lives.get(recorder.sessionId)
  const pageId = recorder.pageId
  await detachRecorder(recorder)
  if (live && pageId) await releaseScreencastIfIdle.call(this, live, pageId)
  try {
    if (!objects) {
      const reserved = await reserveObjectEvidence(this.dbHandle, {
        runId: recorder.runId,
        type: 'video',
        retainUntil: new Date(Date.now() + 14 * 86_400_000),
      })
      if (reserved.status === 'pending') {
        await markEvidenceMissing(this.dbHandle, {
          id: reserved.id,
          reason: OBJECT_MISSING_REASONS.captureFailed,
        })
      }
      return
    }
    const names = (await readdir(recorder.dir).catch(() => [])).filter((name) => name.endsWith('.jpg')).sort()
    if (names.length === 0) {
      const reserved = await reserveObjectEvidence(this.dbHandle, {
        runId: recorder.runId,
        type: 'video',
        retainUntil: new Date(Date.now() + 14 * 86_400_000),
      })
      if (reserved.status === 'pending') {
        await markEvidenceMissing(this.dbHandle, {
          id: reserved.id,
          reason: OBJECT_MISSING_REASONS.captureFailed,
        })
      }
      return
    }
    try {
      const encoded = await encodeJpegDirectoryToWebm({
        dir: recorder.dir,
        fps: BROWSER_FRAME_MAX_FPS,
        maxBytes: objects.videoMaxBytes(),
      })
      if (!isPlayableWebm(encoded.bytes)) {
        throw new Error('编码结果不可播')
      }
      await objects.putObjectEvidence({
        runId: recorder.runId,
        type: 'video',
        body: encoded.bytes,
        contentType: 'video/webm',
        payload: {
          truncated: recorder.truncated || encoded.truncated,
          ...(recorder.truncated || encoded.truncated ? { truncateReason: 'max_bytes' } : {}),
          passwordMask: recorder.passwordMask,
        },
      })
    } catch (error) {
      const reserved = await reserveObjectEvidence(this.dbHandle, {
        runId: recorder.runId,
        type: 'video',
        retainUntil: new Date(Date.now() + 14 * 86_400_000),
      })
      if (reserved.status === 'pending') {
        const tooLarge =
          error && typeof error === 'object' && 'code' in error && error.code === 'OBJECT_TOO_LARGE'
        await markEvidenceMissing(this.dbHandle, {
          id: reserved.id,
          reason: tooLarge ? OBJECT_MISSING_REASONS.videoTooLarge : OBJECT_MISSING_REASONS.captureFailed,
        })
      }
    }
  } finally {
    recordersOf(this).delete(leaseId)
    await rm(recorder.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
