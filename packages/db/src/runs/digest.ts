import { createHash } from 'node:crypto'
import {
  canonicalJson,
  idempotencyDigestPayload,
  snapshotDigestPayload,
  type ExecutionPolicy,
  type JsonValue,
  type RunSnapshot,
  type EvidencePolicy,
  type MapCapturePolicy,
  type MapCapturePolicyOverride,
  type FrozenMapConsumption,
  type MapConsumptionOverride,
  type SessionPolicy,
  type SessionPolicyOverride,
} from '@cairn/shared'

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function computeSnapshotDigest(snapshot: RunSnapshot): string {
  return sha256Hex(snapshotDigestPayload(snapshot))
}

export function computeIdempotencyDigest(input: {
  scenarioVersionId: string
  input: Record<string, JsonValue>
  targetAccountId?: string | null
  policy?: ExecutionPolicy
  sessionPolicy?: SessionPolicy | SessionPolicyOverride | null
  evidencePolicy?: EvidencePolicy | null
  mapCapturePolicy?: MapCapturePolicy | MapCapturePolicyOverride | null
  mapConsumption?: FrozenMapConsumption | MapConsumptionOverride | null
}): string {
  return sha256Hex(idempotencyDigestPayload(input))
}
