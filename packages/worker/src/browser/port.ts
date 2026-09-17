import { unlink } from 'node:fs/promises'
import type {
  BrowserCommand,
  BrowserCommandEvidence,
  BrowserCommandResult,
  EvidenceObjectPointer,
  RunGrant,
  RunSnapshot,
  SessionGrant,
} from '@cairn/shared'
import { OBJECT_MISSING_REASONS, shouldCaptureEvidence } from '@cairn/shared'
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
      const { screenshotBytes, tracePath, ...result } = raw
      const failed = !result.ok
      const shotMode = evidence?.screenshot ?? 'on_failure'
      const traceMode = evidence?.trace ?? 'off'

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

export async function attachObjectEvidence(input: {
  type: 'screenshot' | 'trace'
  bytes: Buffer | Uint8Array | undefined
  contentType: string
  objects: ObjectService | undefined
  evidence: BrowserCommandEvidence | undefined
  retainUntil?: string
  emptyReason: string
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
