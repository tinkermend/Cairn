import { createHash } from 'node:crypto'
import {
  canonicalJson,
  idempotencyDigestPayload,
  snapshotDigestPayload,
  type ExecutionPolicy,
  type JsonValue,
  type RunSnapshot,
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
}): string {
  return sha256Hex(idempotencyDigestPayload(input))
}
