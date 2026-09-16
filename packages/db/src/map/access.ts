import { and, eq } from 'drizzle-orm'
import {
  canonicalJson,
  frozenTargetAccessPolicySchema,
  originsForAccessPurposes,
  seedTargetAccessRules,
  targetAccessPolicyDtoSchema,
  targetAccessPolicySchema,
  targetAccessPolicyUpdateBodySchema,
  type ExecutionActor,
  type FrozenTargetAccessPolicy,
  type TargetAccessPolicy,
  type TargetAccessPolicyDto,
  type TargetAccessPolicyUpdateBody,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { sha256Hex } from '../runs/digest.js'
import { mapCommandIdempotencyConflict, mapRevisionConflict } from './errors.js'
import { requireLiveTarget } from './view.js'

function policyFromRules(rules: TargetAccessPolicy['rules'], policyVersion: number): TargetAccessPolicy {
  return targetAccessPolicySchema.parse({
    schemaVersion: 1,
    policyVersion,
    rules,
  })
}

export function digestAccessPolicy(policy: TargetAccessPolicy): string {
  return sha256Hex(canonicalJson(policy))
}

export async function getTargetAccessPolicy(db: Db, targetId: string): Promise<TargetAccessPolicyDto> {
  const target = await requireLiveTarget(db, targetId)
  const { targetAccessPolicies } = schemaFor(db)
  const [row] = await db.select().from(targetAccessPolicies).where(eq(targetAccessPolicies.targetId, targetId)).limit(1)
  if (!row) {
    return targetAccessPolicyDtoSchema.parse({
      targetId,
      revision: 0,
      policy: policyFromRules(seedTargetAccessRules(target.entryUrl, target.loginUrl), 1),
      seeded: true,
      resourceLoadsUnrestricted: true,
      updatedAt: new Date(0).toISOString(),
    })
  }
  return targetAccessPolicyDtoSchema.parse({
    targetId,
    revision: row.revision,
    policy: policyFromRules(row.rulesJson, row.policyVersion),
    seeded: false,
    resourceLoadsUnrestricted: true,
    updatedAt: row.updatedAt.toISOString(),
  })
}

export async function ensureFrozenAccessPolicyTx(
  db: Db,
  input: { targetId: string; actorId: string; mapJob?: boolean },
): Promise<{ frozen: FrozenTargetAccessPolicy; allowedOrigins: string[] }> {
  const target = await requireLiveTarget(db, input.targetId)
  const { targetAccessPolicies } = schemaFor(db)
  const [row] = await locked(db, db.select().from(targetAccessPolicies).where(eq(targetAccessPolicies.targetId, input.targetId)))
  const now = await clockNow(db)
  if (!row) {
    const policy = policyFromRules(seedTargetAccessRules(target.entryUrl, target.loginUrl), 1)
    const digest = digestAccessPolicy(policy)
    await db.insert(targetAccessPolicies).values({
      targetId: input.targetId,
      policySchemaVersion: policy.schemaVersion,
      policyVersion: policy.policyVersion,
      rulesJson: policy.rules,
      policyDigest: digest,
      revision: 1,
      updatedBy: input.actorId,
      updatedAt: now,
    })
    return {
      frozen: frozenTargetAccessPolicySchema.parse({ revision: 1, digest, policy }),
      allowedOrigins: originsForAccessPurposes(policy, input.mapJob ? ['business_surface'] : ['business_surface', 'authentication']),
    }
  }
  const policy = policyFromRules(row.rulesJson, row.policyVersion)
  return {
    frozen: frozenTargetAccessPolicySchema.parse({
      revision: row.revision,
      digest: row.policyDigest,
      policy,
    }),
    allowedOrigins: originsForAccessPurposes(policy, input.mapJob ? ['business_surface'] : ['business_surface', 'authentication']),
  }
}

export async function updateTargetAccessPolicy(
  db: Db,
  targetId: string,
  body: TargetAccessPolicyUpdateBody,
  actor: ExecutionActor,
): Promise<TargetAccessPolicyDto> {
  const parsed = targetAccessPolicyUpdateBodySchema.parse(body)
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { targetAccessPolicies, targetAccessPolicyCommands } = schemaFor(tx)
    const [receipt] = await tx
      .select()
      .from(targetAccessPolicyCommands)
      .where(and(eq(targetAccessPolicyCommands.targetId, targetId), eq(targetAccessPolicyCommands.commandKey, parsed.idempotencyKey)))
      .limit(1)
    const payload = { body: parsed }
    if (receipt) {
      if (canonicalJson(receipt.payload) !== canonicalJson(payload)) mapCommandIdempotencyConflict()
      return targetAccessPolicyDtoSchema.parse(receipt.result)
    }
    const [current] = await locked(tx, tx.select().from(targetAccessPolicies).where(eq(targetAccessPolicies.targetId, targetId)))
    const expected = current?.revision ?? 0
    if (expected !== parsed.expectedRevision) mapRevisionConflict('目标授权修订已变更')
    const now = await clockNow(tx)
    const nextRevision = expected + 1
    const policy = policyFromRules(parsed.rules, nextRevision)
    const digest = digestAccessPolicy(policy)
    const values = {
      policySchemaVersion: policy.schemaVersion,
      policyVersion: policy.policyVersion,
      rulesJson: policy.rules,
      policyDigest: digest,
      revision: nextRevision,
      updatedBy: actor.id,
      updatedAt: now,
    }
    if (current) {
      await tx.update(targetAccessPolicies).set(values).where(eq(targetAccessPolicies.targetId, targetId))
    } else {
      await tx.insert(targetAccessPolicies).values({ targetId, ...values })
    }
    const result = await getTargetAccessPolicy(tx, targetId)
    await insertRows(tx, targetAccessPolicyCommands, {
      id: newId(),
      targetId,
      commandKey: parsed.idempotencyKey,
      payload,
      result,
    })
    await recordAudit(tx, actor, 'target.access_policy.update', 'target', targetId, parsed.reason)
    return result
  })
}
