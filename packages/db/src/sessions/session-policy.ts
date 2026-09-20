import {
  FACTORY_PLATFORM_CONFIG,
  platformConfigDocumentSchema,
  resolveSessionPolicyLayers,
  sessionPolicyFromPlatform,
  targetSessionPolicyOverrideSchema,
  type SessionPolicy,
  type SessionPolicyOverride,
  type TargetSessionPolicyOverride,
} from '@cairn/shared'
import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { schemaFor } from '../native.js'
import { getPlatformConfig } from '../platform-config/store.js'

export function parseTargetSessionPolicyOverride(
  value: unknown,
): TargetSessionPolicyOverride | null {
  if (value == null) return null
  return targetSessionPolicyOverrideSchema.parse(value)
}

export async function loadResolvedSessionPolicyForTarget(
  db: Db,
  targetId: string,
): Promise<SessionPolicy> {
  return loadResolvedSessionPolicyLayers(db, { targetId })
}

export async function loadResolvedSessionPolicyLayers(
  db: Db,
  input: { targetId: string; runOverride?: SessionPolicyOverride | null },
): Promise<SessionPolicy> {
  const current = await getPlatformConfig(db)
  const document = current
    ? platformConfigDocumentSchema.parse(current.document)
    : FACTORY_PLATFORM_CONFIG
  const { targets } = schemaFor(db)
  const [target] = await db
    .select({ sessionPolicy: targets.sessionPolicy })
    .from(targets)
    .where(eq(targets.id, input.targetId))
    .limit(1)
  return resolveSessionPolicyLayers({
    platformDefault: sessionPolicyFromPlatform(document.session),
    targetOverride: parseTargetSessionPolicyOverride(target?.sessionPolicy),
    runOverride: input.runOverride ?? null,
  })
}

export function sessionLifecycleFieldsFromPolicy(policy: SessionPolicy) {
  return {
    reusePolicy: policy.reuse,
    idleTtlSeconds: policy.idleTtlSeconds,
    maxLifetimeSeconds: policy.maxLifetimeSeconds,
    reclaimMode: policy.reclaim,
    keepAliveSeconds: policy.keepAliveSeconds,
    authProbeIntervalSeconds: policy.authProbeIntervalSeconds,
    evictionPriority: policy.evictionPriority,
  }
}

export function effectiveSessionPolicyForTarget(
  documentSession: Parameters<typeof resolveSessionPolicyLayers>[0]['platformDefault'],
  targetOverride: TargetSessionPolicyOverride | null,
): SessionPolicy {
  return resolveSessionPolicyLayers({
    platformDefault: documentSession,
    targetOverride,
    runOverride: null,
  })
}
