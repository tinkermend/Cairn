import { unlink } from 'node:fs/promises'
import type {
  BrowserCommand,
  BrowserCommandEvidence,
  BrowserCommandResult,
  EvidenceObjectPointer,
  JsonValue,
  PageRef,
  RunGrant,
  RunSnapshot,
  SessionGrant,
  ScreenshotRole,
} from '@cairn/shared'
import {
  OBJECT_MISSING_REASONS,
  requiredScreenshotRole,
  shouldCaptureEvidence,
  writeEvidenceArtifactKey,
} from '@cairn/shared'
import type { ObjectService } from '../objects/object.service'
import type { BrowserPort } from '../engine/ports'
import { BrowserSessionManager, SessionLeaseError } from './session-manager'

export function createBrowserPort(manager: BrowserSessionManager, objects?: ObjectService): BrowserPort {
  return {
    async acquire(run: RunSnapshot, grant: RunGrant, signal?: AbortSignal) {
      return manager.acquire(run, grant, signal)
    },
    async release(grant: SessionGrant, reason: string) {
      try {
        await manager.release(grant.leaseId, reason)
      } catch (error) {
        if (error instanceof SessionLeaseError) throw error
        throw error
      }
    },
    async invalidate(grant: SessionGrant, reason: string) {
      await manager.invalidate(grant, reason)
    },
    async describeHold(runId: string) {
      return manager.describeHoldPage(runId)
    },
    async restoreAuthGate(runId, grant) {
      return manager.restoreAuthGateFromCheckpoint(runId, grant)
    },
    async recoverAuth(grant, input) {
      return manager.recoverAuth(grant, input)
    },
    async sampleMapConditions(grant, signal) {
      return manager.sampleMapConditions(grant, signal)
    },
    async probeErrorSurface(grant, signal) {
      return manager.probeErrorSurface(grant, signal)
    },
    async execute(
      grant: SessionGrant,
      command: BrowserCommand,
      signal?: AbortSignal,
      evidence?: BrowserCommandEvidence,
    ) {
      const raw = await manager.execute(grant, command, signal, evidence)
      const { screenshotBytes, extraShots, faceRole, pageRef, tracePath, ...result } = raw
      const failed = !result.ok
      const shotMode = evidence?.screenshot ?? 'on_failure'
      const traceMode = evidence?.trace ?? 'off'
      const capturedAt = new Date().toISOString()
      const viewport = evidence?.screenshotViewport ?? 'full_page'
      const role = faceRole ?? requiredScreenshotRole({ failed, commandType: command.type })

      if (shouldCaptureEvidence(shotMode, failed)) {
        for (const extra of extraShots ?? []) {
          await attachObjectEvidence({
            type: 'screenshot',
            bytes: extra.bytes,
            contentType: 'image/png',
            objects,
            evidence,
            retainUntil: evidence?.screenshotRetainUntil,
            emptyReason: OBJECT_MISSING_REASONS.captureFailed,
            artifactKey: evidence
              ? writeEvidenceArtifactKey({
                  type: 'screenshot',
                  attemptId: evidence.attemptId,
                  role: extra.role,
                })
              : undefined,
            payload: screenshotPayload(extra.role, viewport, capturedAt, pageRef),
          })
        }
      }

      let screenshot = result.screenshot
      if (shouldCaptureEvidence(shotMode, failed)) {
        screenshot = await attachObjectEvidence({
          type: 'screenshot',
          bytes: screenshotBytes,
          contentType: 'image/png',
          objects,
          evidence,
          retainUntil: evidence?.screenshotRetainUntil,
          emptyReason: OBJECT_MISSING_REASONS.captureFailed,
          artifactKey: evidence
            ? writeEvidenceArtifactKey({
                type: 'screenshot',
                attemptId: evidence.attemptId,
                role,
              })
            : undefined,
          payload: screenshotPayload(role, viewport, capturedAt, pageRef),
        })
      }

      let trace = result.trace
      if (tracePath) {
        if (shouldCaptureEvidence(traceMode, failed)) {
          const { readFile } = await import('node:fs/promises')
          const bytes = await readFile(tracePath).catch(() => undefined)
          trace = await attachObjectEvidence({
            type: 'trace',
            bytes,
            contentType: 'application/zip',
            objects,
            evidence,
            retainUntil: evidence?.traceRetainUntil,
            emptyReason: OBJECT_MISSING_REASONS.captureFailed,
          })
        }
        await unlink(tracePath).catch(() => undefined)
      }

      return { ...result, screenshot, trace }
    },
  }
}

function screenshotPayload(
  role: ScreenshotRole,
  viewport: 'viewport' | 'full_page',
  capturedAt: string,
  pageRef?: PageRef,
): JsonValue {
  return {
    role,
    viewport,
    capturedAt,
    ...(pageRef ? { pageRef } : {}),
  }
}

export async function attachObjectEvidence(input: {
  type: 'screenshot' | 'trace'
  bytes: Buffer | Uint8Array | undefined
  contentType: string
  objects: ObjectService | undefined
  evidence: BrowserCommandEvidence | undefined
  retainUntil?: string
  emptyReason: string
  artifactKey?: string
  payload?: JsonValue
}): Promise<EvidenceObjectPointer> {
  if (!input.bytes || input.bytes.byteLength === 0) {
    return { missingReason: input.emptyReason }
  }
  if (!input.objects || !input.evidence) {
    return { missingReason: OBJECT_MISSING_REASONS.storeUnavailable }
  }
  try {
    const saved = await input.objects.putObjectEvidence({
      runId: input.evidence.runId,
      stepRunId: input.evidence.stepRunId,
      attemptId: input.evidence.attemptId,
      type: input.type,
      artifactKey: input.artifactKey,
      payload: input.payload,
      body: input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes),
      contentType: input.contentType,
      retainUntil: input.retainUntil ? new Date(input.retainUntil) : undefined,
    })
    if (saved.status === 'missing') {
      return { missingReason: saved.missingReason ?? OBJECT_MISSING_REASONS.storeUnavailable }
    }
    return {
      objectKey: saved.objectKey,
      contentType: saved.contentType,
      byteSize: saved.byteSize,
      digest: saved.digest,
    }
  } catch (error) {
    const tooLarge =
      error && typeof error === 'object' && 'code' in error && error.code === 'OBJECT_TOO_LARGE'
    return {
      missingReason: tooLarge && input.type === 'trace'
        ? OBJECT_MISSING_REASONS.traceTooLarge
        : OBJECT_MISSING_REASONS.storeUnavailable,
    }
  }
}
