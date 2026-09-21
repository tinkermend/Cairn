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
import { atomic, clockNow, insertIgnoreRows, insertRows, locked, schemaFor } from '../native.js'
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
  let existing = row
  if (!existing) {
    const seeded = policyFromRules(seedTargetAccessRules(target.entryUrl, target.loginUrl), 1)
    // 首次创建策略时还没有行可锁，上面的 FOR UPDATE 拦不住并发：同一个新目标上
    // 两个几乎同时的 Run 会都判定「没有策略」。所以插入必须容忍冲突，
    // 输家回读赢家落库的那一行，以库里的事实为准，而不是沿用自己算出来的值。
    const inserted = await insertIgnoreRows(db, targetAccessPolicies, {
      targetId: input.targetId,
      policySchemaVersion: seeded.schemaVersion,
      policyVersion: seeded.policyVersion,
      rulesJson: seeded.rules,
      policyDigest: digestAccessPolicy(seeded),
      revision: 1,
      updatedBy: input.actorId,
      updatedAt: now,
    })
    if (inserted === 1) {
      return {
        frozen: frozenTargetAccessPolicySchema.parse({ revision: 1, digest: digestAccessPolicy(seeded), policy: seeded }),
        allowedOrigins: originsForAccessPurposes(seeded, input.mapJob ? ['business_surface'] : ['business_surface', 'authentication']),
      }
    }
    ;[existing] = await db.select().from(targetAccessPolicies).where(eq(targetAccessPolicies.targetId, input.targetId))
    // 冲突意味着行已存在；读不到只可能是它在两步之间被删，这是真错误，不能拿自己算的值顶替。
    if (!existing) throw new Error(`目标 ${input.targetId} 的访问策略在并发创建后读不到`)
  }
  const policy = policyFromRules(existing.rulesJson, existing.policyVersion)
  return {
    frozen: frozenTargetAccessPolicySchema.parse({
      revision: existing.revision,
      digest: existing.policyDigest,
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
