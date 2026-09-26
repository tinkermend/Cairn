import { eq } from 'drizzle-orm'
import { targetStateRuleSchema, type ExecutionActor, type ExploreState, type TargetStateRule } from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import { requireLiveTarget } from './view.js'

// 地图状态事实：目标状态规则与三级状态键观测。

export async function getTargetStateRule(db: Db, targetId: string): Promise<TargetStateRule | null> {
  await requireLiveTarget(db, targetId)
  const { targetStateRules } = schemaFor(db)
  const [row] = await db.select().from(targetStateRules).where(eq(targetStateRules.targetId, targetId)).limit(1)
  if (!row) return null
  return targetStateRuleSchema.parse(row.rulesJson)
}

export async function upsertTargetStateRule(
  db: Db,
  targetId: string,
  rule: TargetStateRule,
  actor: ExecutionActor,
): Promise<TargetStateRule> {
  const parsed = targetStateRuleSchema.parse(rule)
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { targetStateRules } = schemaFor(tx)
    const [current] = await locked(tx, tx.select().from(targetStateRules).where(eq(targetStateRules.targetId, targetId)))
    const now = await clockNow(tx)
    const nextRevision = (current?.revision ?? 0) + 1
    if (current) {
      await tx
        .update(targetStateRules)
        .set({
          ruleVersion: parsed.ruleVersion,
          rulesJson: parsed,
          revision: nextRevision,
          updatedBy: actor.id,
          updatedAt: now,
        })
        .where(eq(targetStateRules.targetId, targetId))
    } else {
      await tx.insert(targetStateRules).values({
        targetId,
        ruleVersion: parsed.ruleVersion,
        rulesJson: parsed,
        revision: nextRevision,
        updatedBy: actor.id,
        updatedAt: now,
      })
    }
    await recordAudit(tx, actor, 'map.state_rule.update', 'target', targetId, `更新状态规则 v${parsed.ruleVersion}`)
    return parsed
  })
}

export async function recordExploreState(
  tx: Db,
  input: Omit<ExploreState, 'id' | 'createdAt'>,
): Promise<string> {
  const { exploreStates } = schemaFor(tx)
  const id = (input as any).id ?? newId()
  const now = await clockNow(tx)
  await insertRows(tx, exploreStates, {
    id,
    targetId: input.targetId,
    targetAccountId: input.targetAccountId,
    jobId: input.jobId ?? null,
    runId: input.runId ?? null,
    pageKey: input.pageKey,
    viewStateKey: input.viewStateKey,
    presentationStateKey: input.presentationStateKey,
    stateRuleVersion: input.stateRuleVersion ?? 1,
    readiness: input.readiness ?? 'ready',
    snapshotJson: input.snapshotData,
    evidenceRef: input.evidenceRef ?? null,
    createdAt: now,
  })
  return id
}
