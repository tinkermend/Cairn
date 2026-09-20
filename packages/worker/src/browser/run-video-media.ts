import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  claimRunVideoMediaJobs,
  enqueueRunVideoMediaJob,
  finishRunVideoMediaJob,
  markEvidenceMissing,
  reserveObjectEvidence,
  type RunVideoMediaClaim,
} from '@cairn/db'
import {
  OBJECT_MISSING_REASONS,
  computeRunVideoCoverage,
  writeRunVideoManifest,
  writeRunVideoPayload,
  writeEvidenceArtifactKey,
  BROWSER_FRAME_MAX_FPS,
  type RunVideoManifest,
} from '@cairn/shared'
import type { ObjectService } from '../objects/object.service.js'
import type { SessionManagerContext } from './session-live.js'
import { capturedSpanMs, partitionVideoSegments, type TimedJpegFrame } from './video-timeline.js'
import { encodeJpegDirectoryToWebm } from './video-encoder.js'
import type { RunVideoRecorder, SealedRunVideo } from './run-video.js'

export function manifestFromFrames(
  runId: string,
  frames: TimedJpegFrame[],
  sealedTMs: number,
): RunVideoManifest {
  const segments = partitionVideoSegments(frames, sealedTMs).map((window, seq) => ({
    seq,
    fromMs: window.fromMs,
    toMs: window.toMs,
    frameCount: window.frames.length,
    persistWatermark: window.frames.length,
    status: 'local' as const,
    file: `segment_${String(seq).padStart(3, '0')}.webm`,
  }))
  return writeRunVideoManifest({
    contractVersion: 1,
    runId,
    sealed: true,
    sealedTMs,
    framesWritten: frames.length,
    persistWatermark: frames.length,
    segments,
  })
}

async function persistManifest(dir: string, manifest: RunVideoManifest): Promise<void> {
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
}

function ownerOf(ctx: SessionManagerContext): { workerId: string; instanceId: string } | null {
  const workerId = ctx.options.workerId
  const instanceId = ctx.workerInstanceId
  if (!workerId || !instanceId) return null
  return { workerId, instanceId }
}

async function markCaptureFailed(ctx: SessionManagerContext, runId: string, reason: string): Promise<void> {
  const reserved = await reserveObjectEvidence(ctx.dbHandle, {
    runId,
    type: 'video',
    artifactKey: writeEvidenceArtifactKey({ type: 'video' }),
    retainUntil: new Date(Date.now() + 14 * 86_400_000),
  })
  if (reserved.status === 'pending') {
    await markEvidenceMissing(ctx.dbHandle, { id: reserved.id, reason })
  }
}

export async function encodeAndPutRunVideo(
  ctx: SessionManagerContext,
  recorder: RunVideoRecorder,
): Promise<void> {
  const objects = ctx.objects as ObjectService | undefined
  if (!objects) {
    await markCaptureFailed(ctx, recorder.runId, OBJECT_MISSING_REASONS.captureFailed)
    return
  }
  const sealedTMs = capturedSpanMs(recorder.startedMonoMs, recorder.sealedMonoMs ?? recorder.startedMonoMs)
  const encoded = await encodeJpegDirectoryToWebm({
    dir: recorder.dir,
    fps: BROWSER_FRAME_MAX_FPS,
    maxBytes: objects.videoMaxBytes(),
    timeline: { frames: recorder.frames, sealedTMs },
  })
  const payload = writeRunVideoPayload({
    truncated: recorder.truncated || encoded.truncated,
    ...(recorder.truncated || encoded.truncated ? { truncateReason: 'max_bytes' } : {}),
    passwordMask: recorder.passwordMask,
    timing: {
      contractVersion: 1,
      captureStartedAt: recorder.startedAt.toISOString(),
      sealedAt: (recorder.sealedAt ?? new Date()).toISOString(),
      capturedSpanMs: sealedTMs,
      decodedDurationMs: encoded.decodedDurationMs,
      decodedFrames: encoded.decodedFrames,
      framesWritten: recorder.frames.length,
      framesDropped: recorder.framesDropped,
      finalFrame: recorder.finalFrame,
    },
    coverage: computeRunVideoCoverage({
      frames: recorder.frames,
      capturedSpanMs: sealedTMs,
      decodedDurationMs: encoded.decodedDurationMs,
      truncated: recorder.truncated || encoded.truncated,
      finalFrame: recorder.finalFrame,
    }),
  })
  await objects.putObjectEvidence({
    runId: recorder.runId,
    type: 'video',
    artifactKey: writeEvidenceArtifactKey({ type: 'video' }),
    body: encoded.bytes,
    contentType: 'video/webm',
    payload,
  })
}

export async function processRunVideoMediaClaim(
  ctx: SessionManagerContext,
  claim: RunVideoMediaClaim,
  recorder?: RunVideoRecorder,
): Promise<void> {
  if (!existsSync(claim.spoolDir)) {
    await finishRunVideoMediaJob(ctx.dbHandle, {
      jobId: claim.id,
      workerId: claim.workerId,
      instanceId: claim.instanceId,
      fencingToken: claim.fencingToken,
      outcome: 'retry',
      error: 'spool_missing',
    })
    return
  }
  if (!recorder) {
    await finishRunVideoMediaJob(ctx.dbHandle, {
      jobId: claim.id,
      workerId: claim.workerId,
      instanceId: claim.instanceId,
      fencingToken: claim.fencingToken,
      outcome: 'retry',
      error: 'recorder_missing',
    })
    return
  }
  try {
    await encodeAndPutRunVideo(ctx, recorder)
    const finished = await finishRunVideoMediaJob(ctx.dbHandle, {
      jobId: claim.id,
      workerId: claim.workerId,
      instanceId: claim.instanceId,
      fencingToken: claim.fencingToken,
      outcome: 'succeeded',
      manifest: claim.manifest,
    })
    if (finished.ok) {
      await rm(claim.spoolDir, { recursive: true, force: true }).catch(() => undefined)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await finishRunVideoMediaJob(ctx.dbHandle, {
      jobId: claim.id,
      workerId: claim.workerId,
      instanceId: claim.instanceId,
      fencingToken: claim.fencingToken,
      outcome: 'retry',
      error: message,
    })
    throw error
  }
}

export async function dispatchSealedRunVideo(
  ctx: SessionManagerContext,
  sealed: SealedRunVideo,
): Promise<void> {
  const { recorder, leaseId } = sealed
  const sealedTMs = capturedSpanMs(recorder.startedMonoMs, recorder.sealedMonoMs ?? recorder.startedMonoMs)
  const manifest = manifestFromFrames(recorder.runId, recorder.frames, sealedTMs)
  await persistManifest(recorder.dir, manifest)
  const job = await enqueueRunVideoMediaJob(ctx.dbHandle, {
    runId: recorder.runId,
    spoolDir: recorder.dir,
    manifest,
    sealedAt: recorder.sealedAt ?? new Date(),
  })
  const owner = ownerOf(ctx)
  const claimed = owner
    ? await claimRunVideoMediaJobs(ctx.dbHandle, {
        workerId: owner.workerId,
        instanceId: owner.instanceId,
        jobId: job.id,
        limit: 1,
      })
    : []
  if (claimed[0]) {
    await processRunVideoMediaClaim(ctx, claimed[0], recorder)
    return
  }
  await encodeAndPutRunVideo(ctx, recorder)
}


export async function processDueRunVideoMedia(ctx: SessionManagerContext): Promise<number> {
  const owner = ownerOf(ctx)
  if (!owner) return 0
  const claimed = await claimRunVideoMediaJobs(ctx.dbHandle, {
    workerId: owner.workerId,
    instanceId: owner.instanceId,
    limit: 2,
  })
  let done = 0
  for (const claim of claimed) {
    if (!existsSync(claim.spoolDir)) {
      await finishRunVideoMediaJob(ctx.dbHandle, {
        jobId: claim.id,
        workerId: claim.workerId,
        instanceId: claim.instanceId,
        fencingToken: claim.fencingToken,
        outcome: 'retry',
        error: 'spool_missing',
      })
      continue
    }
    try {
      const recorder: RunVideoRecorder = {
        runId: claim.runId,
        leaseId: claim.id,
        sessionId: '',
        pageId: '',
        captureEpoch: 0,
        dir: claim.spoolDir,
        frameIndex: 0,
        jpegBytes: 0,
        jpegBudget: 0,
        lastWriteAt: 0,
        lastAcceptedMonoMs: 0,
        lastTMs: 0,
        startedMonoMs: 0,
        startedAt: claim.sealedAt,
        sealedAt: claim.sealedAt,
        sealedMonoMs: claim.manifest.sealedTMs,
        passwordMask: 'applied',
        truncated: false,
        accepting: false,
        sealed: true,
        writeChain: Promise.resolve(),
        retargetChain: Promise.resolve(),
        frames: [],
        framesDropped: { rateLimited: 0, budget: 0, maskFailed: 0 },
        finalFrame: 'captured',
        localSeq: 0,
        sensitiveSelectors: [],
      }
      const timeline = await readFile(join(claim.spoolDir, 'timeline.json'), 'utf8')
      const parsed = JSON.parse(timeline) as { frames?: TimedJpegFrame[]; sealedTMs?: number }
      recorder.frames = Array.isArray(parsed.frames) ? parsed.frames : []
      if (Number.isFinite(parsed.sealedTMs)) recorder.sealedMonoMs = Number(parsed.sealedTMs)
      await processRunVideoMediaClaim(ctx, claim, recorder)
      done += 1
    } catch (error) {
      ctx.logger.warn(
        { runId: claim.runId, err: error instanceof Error ? error.message : String(error) },
        'run.video.media_job_failed',
      )
    }
  }
  return done
}
