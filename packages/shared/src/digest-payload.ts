import type { ExecutionPolicy } from './step.js'
import type { RunSnapshot } from './run.js'
import type { JsonValue } from './wire.js'

/** 参与 snapshot.digest 的字段。不含 runId / createdAt / digest。 */
export function snapshotDigestPayload(snapshot: RunSnapshot): Record<string, unknown> {
  return {
    schemaVersion: snapshot.schemaVersion,
    targetId: snapshot.targetId,
    targetAccountId: snapshot.targetAccountId,
    secretRef: snapshot.secretRef,
    scenarioId: snapshot.scenarioId,
    scenarioVersionId: snapshot.scenarioVersionId,
    steps: snapshot.steps,
    input: snapshot.input,
    policy: snapshot.policy,
    executorVersions: snapshot.executorVersions,
  }
}

export function idempotencyDigestPayload(input: {
  scenarioVersionId: string
  input: Record<string, JsonValue>
  targetAccountId?: string | null
  policy?: ExecutionPolicy
}): Record<string, unknown> {
  return {
    scenarioVersionId: input.scenarioVersionId,
    input: input.input,
    targetAccountId: input.targetAccountId ?? null,
    policy: input.policy,
  }
}
