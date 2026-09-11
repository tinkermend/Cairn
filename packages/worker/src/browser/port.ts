import type {
  BrowserCommand,
  BrowserCommandEvidence,
  BrowserCommandResult,
  RunGrant,
  RunSnapshot,
  SessionGrant,
} from '@cairn/shared'
import { OBJECT_MISSING_REASONS } from '@cairn/shared'
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
    async execute(
      grant: SessionGrant,
      command: BrowserCommand,
      signal?: AbortSignal,
      evidence?: BrowserCommandEvidence,
    ) {
      const raw = await manager.execute(grant, command, signal)
      const { screenshotBytes, ...result } = raw
      if (result.ok) return result
      return attachScreenshot(result, screenshotBytes, objects, evidence)
    },
  }
}

async function attachScreenshot(
  result: Extract<BrowserCommandResult, { ok: false }>,
  screenshotBytes: Buffer | undefined,
  objects: ObjectService | undefined,
  evidence: BrowserCommandEvidence | undefined,
): Promise<BrowserCommandResult> {
  if (!screenshotBytes) {
    return { ...result, screenshot: { missingReason: 'capture_failed' } }
  }
  if (!objects || !evidence) {
    return { ...result, screenshot: { missingReason: OBJECT_MISSING_REASONS.storeUnavailable } }
  }
  try {
    const saved = await objects.putObjectEvidence({
      runId: evidence.runId,
      stepRunId: evidence.stepRunId,
      attemptId: evidence.attemptId,
      type: 'screenshot',
      body: screenshotBytes,
      contentType: 'image/png',
    })
    return {
      ...result,
      screenshot: {
        objectKey: saved.objectKey,
        contentType: saved.contentType,
        byteSize: saved.byteSize,
        digest: saved.digest,
      },
    }
  } catch {
    return { ...result, screenshot: { missingReason: OBJECT_MISSING_REASONS.storeUnavailable } }
  }
}
