import type { EvidencePolicy } from './evidence-policy.js'
import type { ExecutionPolicy } from './step.js'
import type { RunSnapshot } from './run.js'
import type { SessionPolicy, SessionPolicyOverride } from './session.js'
import type { JsonValue } from './wire.js'

/** 参与 snapshot.digest 的字段。不含 runId / createdAt / digest。 */
export function snapshotDigestPayload(snapshot: RunSnapshot): Record<string, unknown> {
  return {
    ...(snapshot.deadlineAt ? { deadlineAt: snapshot.deadlineAt } : {}),
    schemaVersion: snapshot.schemaVersion,
    targetId: snapshot.targetId,
    targetAccountId: snapshot.targetAccountId,
    secretRef: snapshot.secretRef,
    scenarioId: snapshot.scenarioId,
    scenarioVersionId: snapshot.scenarioVersionId,
    steps: snapshot.steps,
    input: snapshot.input,
    policy: snapshot.policy,
    sessionPolicy: snapshot.sessionPolicy,
    evidencePolicy: snapshot.evidencePolicy,
    executorVersions: snapshot.executorVersions,
    allowedOrigins: snapshot.allowedOrigins,
    loginOrigin: snapshot.loginOrigin,
    loginPath: snapshot.loginPath,
    aiExecution: snapshot.aiExecution,
    ...(snapshot.platformConfigRevision != null
      ? { platformConfigRevision: snapshot.platformConfigRevision }
      : {}),
    ...(snapshot.targetAuth ? { targetAuth: snapshot.targetAuth } : {}),
  }
}

export function idempotencyDigestPayload(input: {
  scenarioVersionId: string
  input: Record<string, JsonValue>
  targetAccountId?: string | null
  policy?: ExecutionPolicy
  sessionPolicy?: SessionPolicy | SessionPolicyOverride | null
  evidencePolicy?: EvidencePolicy | null
}): Record<string, unknown> {
  return {
    scenarioVersionId: input.scenarioVersionId,
    input: input.input,
    targetAccountId: input.targetAccountId ?? null,
    policy: input.policy,
    sessionPolicy: input.sessionPolicy ?? null,
    evidencePolicy: input.evidencePolicy ?? null,
  }
}
