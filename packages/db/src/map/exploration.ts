import { and, desc, eq, inArray } from 'drizzle-orm'
import {
  canonicalJson,
  exploreDiscoverySchema,
  exploreEntryRequestProfileSchema,
  exploreReviewSchema,
  exploreSourceStateRecipeSchema,
  exploreStateSchema,
  exploreTraversalSchema,
  targetStateRuleSchema,
  type CandidateReviewBody,
  type ExploreDiscovery,
  type ExploreEntryRequestProfile,
  type ExploreReview,
  type ExploreSourceStateRecipe,
  type ExploreState,
  type ExploreTraversal,
  type ReviewUnknownBody,
  type StateRecipeCreateBody,
  type StateRecipeReviewBody,
  type TargetStateRule,
  type ExecutionActor,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { recordAudit } from '../audit/record.js'
import { newId } from '../id.js'
import { atomic, clockNow, insertRows, locked, schemaFor } from '../native.js'
import {
  conflict,
  mapCommandIdempotencyConflict,
  mapForbidden,
  mapNotFound,
  mapRevisionConflict,
} from './errors.js'
import { requireLiveTarget } from './view.js'

// ==========================================
// 1. Target State Rules & Entry Profiles
// ==========================================

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

export async function getExploreEntryRequestProfile(
  db: Db,
  targetId: string,
  mapSafeEntryId: string,
): Promise<ExploreEntryRequestProfile | null> {
  await requireLiveTarget(db, targetId)
  const { exploreEntryRequestProfiles } = schemaFor(db)
  const [row] = await db
    .select()
    .from(exploreEntryRequestProfiles)
    .where(and(eq(exploreEntryRequestProfiles.targetId, targetId), eq(exploreEntryRequestProfiles.mapSafeEntryId, mapSafeEntryId)))
    .limit(1)
  if (!row) return null
  return exploreEntryRequestProfileSchema.parse(row.profileJson)
}

export async function upsertExploreEntryRequestProfile(
  db: Db,
  targetId: string,
  mapSafeEntryId: string,
  profile: ExploreEntryRequestProfile,
  actor: ExecutionActor,
): Promise<ExploreEntryRequestProfile> {
  const parsed = exploreEntryRequestProfileSchema.parse(profile)
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { exploreEntryRequestProfiles } = schemaFor(tx)
    const [current] = await locked(
      tx,
      tx
        .select()
        .from(exploreEntryRequestProfiles)
        .where(and(eq(exploreEntryRequestProfiles.targetId, targetId), eq(exploreEntryRequestProfiles.mapSafeEntryId, mapSafeEntryId))),
    )
    const now = await clockNow(tx)
    const nextRevision = (current?.revision ?? 0) + 1
    const updated = { ...parsed, revision: nextRevision }
    if (current) {
      await tx
        .update(exploreEntryRequestProfiles)
        .set({
          revision: nextRevision,
          entryUrl: parsed.entryUrl,
          profileJson: updated,
          updatedAt: now,
        } as never)
        .where(eq(exploreEntryRequestProfiles.id, current.id))
    } else {
      await tx.insert(exploreEntryRequestProfiles).values({
        id: newId(),
        targetId,
        mapSafeEntryId,
        revision: nextRevision,
        entryUrl: parsed.entryUrl,
        profileJson: updated,
        createdBy: actor.id,
        createdAt: now,
      })
    }
    await recordAudit(tx, actor, 'map.entry_profile.update', 'target', targetId, `更新安全入口请求信封修订 ${nextRevision}`)
    return updated
  })
}

// ==========================================
// 2. State Recipes
// ==========================================

export async function listExploreStateRecipes(db: Db, targetId: string): Promise<ExploreSourceStateRecipe[]> {
  await requireLiveTarget(db, targetId)
  const { exploreStateRecipes } = schemaFor(db)
  const rows = await db
    .select()
    .from(exploreStateRecipes)
    .where(eq(exploreStateRecipes.targetId, targetId))
    .orderBy(desc(exploreStateRecipes.createdAt))
  return rows.map((row) =>
    exploreSourceStateRecipeSchema.parse({
      recipeId: row.id,
      targetId: row.targetId,
      targetAccountId: row.targetAccountId,
      safeEntryId: row.mapSafeEntryId,
      safeEntryVersion: row.safeEntryVersion,
      recipeName: row.recipeName,
      revision: row.revision,
      stateRuleVersion: row.stateRuleVersion,
      status: row.status,
      steps: row.stepsJson,
      safetyBasis: row.safetyBasisJson,
      usageLimit: row.usageLimit,
      usageRemaining: row.usageRemaining,
      timeoutSeconds: row.timeoutSeconds,
      isManualSeed: row.isManualSeed === 1,
      commandKey: row.commandKey,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      ...(row.reviewedBy ? { reviewedBy: row.reviewedBy } : {}),
      ...(row.reviewedAt ? { reviewedAt: row.reviewedAt.toISOString() } : {}),
    }),
  )
}

export async function getExploreStateRecipe(
  db: Db,
  targetId: string,
  recipeId: string,
): Promise<ExploreSourceStateRecipe> {
  await requireLiveTarget(db, targetId)
  const { exploreStateRecipes } = schemaFor(db)
  const [row] = await db
    .select()
    .from(exploreStateRecipes)
    .where(and(eq(exploreStateRecipes.targetId, targetId), eq(exploreStateRecipes.id, recipeId)))
    .limit(1)
  if (!row) mapNotFound('状态到达配方不存在')
  return exploreSourceStateRecipeSchema.parse({
    recipeId: row.id,
    targetId: row.targetId,
    targetAccountId: row.targetAccountId,
    safeEntryId: row.mapSafeEntryId,
    safeEntryVersion: row.safeEntryVersion,
    recipeName: row.recipeName,
    revision: row.revision,
    stateRuleVersion: row.stateRuleVersion,
    status: row.status,
    steps: row.stepsJson,
    safetyBasis: row.safetyBasisJson,
    usageLimit: row.usageLimit,
    usageRemaining: row.usageRemaining,
    timeoutSeconds: row.timeoutSeconds,
    isManualSeed: row.isManualSeed === 1,
    commandKey: row.commandKey,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    ...(row.reviewedBy ? { reviewedBy: row.reviewedBy } : {}),
    ...(row.reviewedAt ? { reviewedAt: row.reviewedAt.toISOString() } : {}),
  })
}

export async function createExploreStateRecipe(
  db: Db,
  targetId: string,
  body: StateRecipeCreateBody,
  actor: ExecutionActor,
): Promise<ExploreSourceStateRecipe> {
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { exploreStateRecipes, mapSafeEntries } = schemaFor(tx)
    const [existingCmd] = await tx
      .select()
      .from(exploreStateRecipes)
      .where(and(eq(exploreStateRecipes.targetId, targetId), eq(exploreStateRecipes.commandKey, body.idempotencyKey)))
      .limit(1)
    if (existingCmd) {
      return getExploreStateRecipe(tx, targetId, existingCmd.id)
    }

    const [safeEntry] = await tx
      .select()
      .from(mapSafeEntries)
      .where(and(eq(mapSafeEntries.targetId, targetId), eq(mapSafeEntries.id, body.safeEntryId)))
      .limit(1)
    if (!safeEntry || safeEntry.archivedAt) {
      mapNotFound('安全进入路径不存在或已归档')
    }

    const now = await clockNow(tx)
    const recipeId = newId()
    const safetyBasis = {
      kind: body.safetyBasisKind,
      summary: body.safetySummary,
      confirmedBy: actor.id,
      confirmedAt: now.toISOString(),
    }

    await insertRows(tx, exploreStateRecipes, {
      id: recipeId,
      targetId,
      targetAccountId: body.targetAccountId,
      mapSafeEntryId: body.safeEntryId,
      safeEntryVersion: safeEntry.entryVersion,
      recipeName: body.recipeName,
      revision: 1,
      stateRuleVersion: 1,
      status: 'pending_review',
      stepsJson: body.steps,
      safetyBasisJson: safetyBasis,
      usageLimit: 5,
      usageRemaining: 5,
      timeoutSeconds: body.timeoutSeconds,
      isManualSeed: body.isManualSeed ? 1 : 0,
      commandKey: body.idempotencyKey,
      createdBy: actor.id,
      createdAt: now,
    })

    await recordAudit(tx, actor, 'map.state_recipe.create', 'target', targetId, `创建状态到达配方：${body.recipeName}`)
    return getExploreStateRecipe(tx, targetId, recipeId)
  })
}

export async function reviewExploreStateRecipe(
  db: Db,
  targetId: string,
  recipeId: string,
  body: StateRecipeReviewBody,
  actor: ExecutionActor,
): Promise<ExploreSourceStateRecipe> {
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { exploreStateRecipes } = schemaFor(tx)
    const [recipe] = await locked(
      tx,
      tx
        .select()
        .from(exploreStateRecipes)
        .where(and(eq(exploreStateRecipes.targetId, targetId), eq(exploreStateRecipes.id, recipeId))),
    )
    if (!recipe) mapNotFound('状态到达配方不存在')
    if (recipe.revision !== body.expectedRevision) mapRevisionConflict('配方修订已变更')

    const now = await clockNow(tx)
    const nextRevision = recipe.revision + 1
    const newStatus = body.decision === 'approved' ? 'approved' : 'rejected'

    await tx
      .update(exploreStateRecipes)
      .set({
        revision: nextRevision,
        status: newStatus,
        usageLimit: body.usageLimit,
        usageRemaining: body.usageLimit,
        reviewedBy: actor.id,
        reviewedAt: now,
      })
      .where(eq(exploreStateRecipes.id, recipeId))

    await recordAudit(
      tx,
      actor,
      'map.state_recipe.review',
      'target',
      targetId,
      `审核状态到达配方【${recipe.recipeName}】：${body.decision}（${body.reason}）`,
    )
    return getExploreStateRecipe(tx, targetId, recipeId)
  })
}

export async function acquireRecipeUsage(tx: Db, recipeId: string): Promise<boolean> {
  const { exploreStateRecipes } = schemaFor(tx)
  const [recipe] = await locked(
    tx,
    tx.select().from(exploreStateRecipes).where(eq(exploreStateRecipes.id, recipeId)),
  )
  if (!recipe || recipe.status !== 'approved' || recipe.usageRemaining <= 0) {
    return false
  }
  await tx
    .update(exploreStateRecipes)
    .set({ usageRemaining: recipe.usageRemaining - 1 })
    .where(eq(exploreStateRecipes.id, recipeId))
  return true
}

// ==========================================
// 3. Discoveries / Candidates
// ==========================================

export async function listExploreCandidates(
  db: Db,
  targetId: string,
  jobId: string,
  query?: { status?: string; limit?: number },
): Promise<{ items: ExploreDiscovery[]; totalGaps: number }> {
  await requireLiveTarget(db, targetId)
  const { exploreDiscoveries } = schemaFor(db)
  const limit = Math.min(Math.max(query?.limit ?? 50, 1), 100)
  const rows = await db
    .select()
    .from(exploreDiscoveries)
    .where(
      and(
        eq(exploreDiscoveries.targetId, targetId),
        eq(exploreDiscoveries.jobId, jobId),
        query?.status ? eq(exploreDiscoveries.status, query.status as never) : undefined,
      ),
    )
    .orderBy(desc(exploreDiscoveries.createdAt))
    .limit(limit)

  const items = rows.map((row) =>
    exploreDiscoverySchema.parse({
      id: row.id,
      targetId: row.targetId,
      jobId: row.jobId,
      runId: row.runId,
      stepRunId: row.stepRunId ?? undefined,
      attemptId: row.attemptId ?? undefined,
      sourceStateId: row.sourceExploreStateId ?? undefined,
      sourcePresentationStateKey: row.sourcePresentationStateKey,
      controlFingerprint: row.controlFingerprint,
      accessibleName: row.accessibleName,
      role: row.role,
      ancestorPath: row.ancestorPathJson,
      frameSelector: row.frameSelector,
      candidateCategory: row.candidateCategory,
      targetUrl: row.targetUrl ?? undefined,
      targetDigest: row.targetDigest ?? undefined,
      targetHint: row.targetHint,
      locatorDescriptor: row.locatorDescriptorJson ?? undefined,
      collectorVersion: row.collectorVersion,
      evidenceStatus: row.evidenceStatus,
      rejectionReason: row.rejectionReason ?? undefined,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    }),
  )
  const totalGaps = items.filter((item) => item.evidenceStatus !== 'complete' || item.rejectionReason).length
  return { items, totalGaps }
}

export async function getExploreCandidate(
  db: Db,
  targetId: string,
  jobId: string,
  candidateId: string,
): Promise<ExploreDiscovery> {
  await requireLiveTarget(db, targetId)
  const { exploreDiscoveries } = schemaFor(db)
  const [row] = await db
    .select()
    .from(exploreDiscoveries)
    .where(
      and(
        eq(exploreDiscoveries.targetId, targetId),
        eq(exploreDiscoveries.jobId, jobId),
        eq(exploreDiscoveries.id, candidateId),
      ),
    )
    .limit(1)
  if (!row) mapNotFound('候选控件不存在')
  return exploreDiscoverySchema.parse({
    id: row.id,
    targetId: row.targetId,
    jobId: row.jobId,
    runId: row.runId,
    stepRunId: row.stepRunId ?? undefined,
    attemptId: row.attemptId ?? undefined,
    sourceStateId: row.sourceExploreStateId ?? undefined,
    sourcePresentationStateKey: row.sourcePresentationStateKey,
    controlFingerprint: row.controlFingerprint,
    accessibleName: row.accessibleName,
    role: row.role,
    ancestorPath: row.ancestorPathJson,
    frameSelector: row.frameSelector,
    candidateCategory: row.candidateCategory,
    targetUrl: row.targetUrl ?? undefined,
    targetDigest: row.targetDigest ?? undefined,
    targetHint: row.targetHint,
    locatorDescriptor: row.locatorDescriptorJson ?? undefined,
    collectorVersion: row.collectorVersion,
    evidenceStatus: row.evidenceStatus,
    rejectionReason: row.rejectionReason ?? undefined,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  })
}

export async function reviewExploreCandidate(
  db: Db,
  targetId: string,
  jobId: string,
  candidateId: string,
  body: CandidateReviewBody,
  actor: ExecutionActor,
): Promise<ExploreReview> {
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { exploreDiscoveries, exploreReviews } = schemaFor(tx)
    const [candidate] = await locked(
      tx,
      tx
        .select()
        .from(exploreDiscoveries)
        .where(
          and(
            eq(exploreDiscoveries.targetId, targetId),
            eq(exploreDiscoveries.jobId, jobId),
            eq(exploreDiscoveries.id, candidateId),
          ),
        ),
    )
    if (!candidate) mapNotFound('候选控件不存在')

    const [existingReceipt] = await tx
      .select()
      .from(exploreReviews)
      .where(and(eq(exploreReviews.targetId, targetId), eq(exploreReviews.idempotencyKey, body.idempotencyKey)))
      .limit(1)
    if (existingReceipt) {
      return exploreReviewSchema.parse({
        id: existingReceipt.id,
        targetId: existingReceipt.targetId,
        jobId: existingReceipt.jobId,
        discoveryId: existingReceipt.exploreDiscoveryId,
        reviewerId: existingReceipt.reviewerId,
        decision: existingReceipt.decision,
        expectedRevision: existingReceipt.expectedRevision,
        actionCategory: existingReceipt.actionCategory,
        securityBasis: existingReceipt.securityBasis,
        allowedRoutePattern: existingReceipt.allowedRoutePattern ?? undefined,
        requestEnvelope: existingReceipt.requestEnvelopeJson ?? [],
        exactTargetUrl: existingReceipt.exactTargetUrl ?? undefined,
        dispatchQuota: existingReceipt.dispatchQuota,
        quotaRemaining: existingReceipt.quotaRemaining,
        validUntil: existingReceipt.validUntil.toISOString(),
        idempotencyKey: existingReceipt.idempotencyKey,
        createdAt: existingReceipt.createdAt.toISOString(),
      })
    }

    const now = await clockNow(tx)
    const reviewId = newId()
    const validUntil = new Date(now.getTime() + body.validDurationHours * 3600 * 1000)

    await insertRows(tx, exploreReviews, {
      id: reviewId,
      targetId,
      jobId,
      exploreDiscoveryId: candidateId,
      reviewerId: actor.id,
      decision: body.decision,
      expectedRevision: body.expectedRevision,
      actionCategory: body.actionCategory,
      securityBasis: body.securityBasis,
      allowedRoutePattern: body.allowedRoutePattern ?? null,
      requestEnvelopeJson: body.requestEnvelope,
      exactTargetUrl: candidate.targetUrl ?? null,
      dispatchQuota: 1,
      quotaRemaining: body.decision === 'approved' ? 1 : 0,
      validUntil,
      idempotencyKey: body.idempotencyKey,
      createdAt: now,
    })

    const newStatus = body.decision === 'approved' ? 'approved' : 'rejected'
    await tx
      .update(exploreDiscoveries)
      .set({ status: newStatus })
      .where(eq(exploreDiscoveries.id, candidateId))

    await recordAudit(
      tx,
      actor,
      'map.candidate.review',
      'target',
      targetId,
      `审核候选【${candidate.accessibleName}】：${body.decision}（${body.securityBasis}）`,
    )

    return exploreReviewSchema.parse({
      id: reviewId,
      targetId,
      jobId,
      discoveryId: candidateId,
      reviewerId: actor.id,
      decision: body.decision,
      expectedRevision: body.expectedRevision,
      actionCategory: body.actionCategory,
      securityBasis: body.securityBasis,
      allowedRoutePattern: body.allowedRoutePattern,
      requestEnvelope: body.requestEnvelope,
      exactTargetUrl: candidate.targetUrl ?? undefined,
      dispatchQuota: 1,
      quotaRemaining: body.decision === 'approved' ? 1 : 0,
      validUntil: validUntil.toISOString(),
      idempotencyKey: body.idempotencyKey,
      createdAt: now.toISOString(),
    })
  })
}

export async function acquireReviewQuota(tx: Db, reviewId: string): Promise<boolean> {
  const { exploreReviews } = schemaFor(tx)
  const [review] = await locked(
    tx,
    tx.select().from(exploreReviews).where(eq(exploreReviews.id, reviewId)),
  )
  if (!review || review.decision !== 'approved' || review.quotaRemaining <= 0) {
    return false
  }
  const now = new Date()
  if (review.validUntil.getTime() < now.getTime()) {
    return false
  }
  await tx
    .update(exploreReviews)
    .set({ quotaRemaining: review.quotaRemaining - 1 })
    .where(eq(exploreReviews.id, reviewId))
  return true
}

export async function consumeExploreCandidateReview(
  db: Db,
  targetId: string,
  jobId: string,
  candidateId: string,
  expectedReviewRevision?: number,
): Promise<{
  review: ExploreReview
  parentJob: { targetAccountId: string; entryId: string; releaseId?: string }
  candidate: ExploreDiscovery
}> {
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { exploreDiscoveries, exploreReviews, mapJobs } = schemaFor(tx)
    const [candidate] = await locked(
      tx,
      tx
        .select()
        .from(exploreDiscoveries)
        .where(
          and(
            eq(exploreDiscoveries.targetId, targetId),
            eq(exploreDiscoveries.jobId, jobId),
            eq(exploreDiscoveries.id, candidateId),
          ),
        ),
    )
    if (!candidate) mapNotFound('候选控件不存在')

    const [review] = await locked(
      tx,
      tx
        .select()
        .from(exploreReviews)
        .where(
          and(
            eq(exploreReviews.targetId, targetId),
            eq(exploreReviews.jobId, jobId),
            eq(exploreReviews.exploreDiscoveryId, candidateId),
            eq(exploreReviews.decision, 'approved'),
          ),
        )
        .orderBy(desc(exploreReviews.createdAt))
        .limit(1),
    )
    if (!review) {
      throw conflict('MAP_CANDIDATE_NOT_REVIEWED', '候选动作尚未通过审核或已被拒绝')
    }
    if (expectedReviewRevision !== undefined && review.expectedRevision !== expectedReviewRevision) {
      mapRevisionConflict('候选动作审核修订版本不匹配')
    }
    const now = await clockNow(tx)
    if (review.validUntil.getTime() < now.getTime()) {
      throw conflict('MAP_REVIEW_EXPIRED', '候选动作审核已过期')
    }
    if (review.quotaRemaining <= 0) {
      throw conflict('MAP_REVIEW_QUOTA_EXHAUSTED', '候选动作执行配额已耗尽')
    }

    await tx
      .update(exploreReviews)
      .set({ quotaRemaining: review.quotaRemaining - 1 })
      .where(eq(exploreReviews.id, review.id))

    const [job] = await tx
      .select()
      .from(mapJobs)
      .where(and(eq(mapJobs.id, jobId), eq(mapJobs.targetId, targetId)))
      .limit(1)
    if (!job) {
      mapNotFound('来源探索作业不存在')
    }

    const parsedReview = exploreReviewSchema.parse({
      id: review.id,
      targetId: review.targetId,
      jobId: review.jobId,
      discoveryId: review.exploreDiscoveryId,
      reviewerId: review.reviewerId,
      decision: review.decision,
      expectedRevision: review.expectedRevision,
      actionCategory: review.actionCategory,
      securityBasis: review.securityBasis,
      allowedRoutePattern: review.allowedRoutePattern ?? undefined,
      requestEnvelope: review.requestEnvelopeJson ?? [],
      exactTargetUrl: review.exactTargetUrl ?? undefined,
      dispatchQuota: review.dispatchQuota,
      quotaRemaining: review.quotaRemaining - 1,
      validUntil: review.validUntil.toISOString(),
      idempotencyKey: review.idempotencyKey,
      createdAt: review.createdAt.toISOString(),
    })

    const parsedCandidate = exploreDiscoverySchema.parse({
      id: candidate.id,
      targetId: candidate.targetId,
      jobId: candidate.jobId,
      runId: candidate.runId,
      stepRunId: candidate.stepRunId ?? undefined,
      attemptId: candidate.attemptId ?? undefined,
      sourceStateId: candidate.sourceExploreStateId ?? undefined,
      sourcePresentationStateKey: candidate.sourcePresentationStateKey,
      controlFingerprint: candidate.controlFingerprint,
      accessibleName: candidate.accessibleName,
      role: candidate.role,
      ancestorPath: candidate.ancestorPathJson,
      frameSelector: candidate.frameSelector,
      candidateCategory: candidate.candidateCategory,
      targetUrl: candidate.targetUrl ?? undefined,
      targetDigest: candidate.targetDigest ?? undefined,
      targetHint: candidate.targetHint,
      locatorDescriptor: candidate.locatorDescriptorJson ?? undefined,
      collectorVersion: candidate.collectorVersion,
      evidenceStatus: candidate.evidenceStatus,
      rejectionReason: candidate.rejectionReason ?? undefined,
      status: candidate.status,
      createdAt: candidate.createdAt.toISOString(),
    })

    return {
      review: parsedReview,
      parentJob: {
        targetAccountId: job.targetAccountId,
        entryId: job.entryId,
        releaseId: job.releaseId ?? undefined,
      },
      candidate: parsedCandidate,
    }
  })
}

// ==========================================
// 4. Traversals
// ==========================================

export async function listExploreTraversals(
  db: Db,
  targetId: string,
  jobId: string,
): Promise<ExploreTraversal[]> {
  await requireLiveTarget(db, targetId)
  const { exploreTraversals } = schemaFor(db)
  const rows = await db
    .select()
    .from(exploreTraversals)
    .where(and(eq(exploreTraversals.targetId, targetId), eq(exploreTraversals.jobId, jobId)))
    .orderBy(desc(exploreTraversals.createdAt))

  return rows.map((row) =>
    exploreTraversalSchema.parse({
      id: row.id,
      targetId: row.targetId,
      jobId: row.jobId,
      runId: row.runId,
      attemptId: row.attemptId ?? undefined,
      discoveryId: row.exploreDiscoveryId ?? undefined,
      reviewId: row.exploreReviewId ?? undefined,
      actionCategory: row.actionCategory,
      relationType: row.relationType,
      fromStateId: row.fromExploreStateId ?? undefined,
      fromPresentationStateKey: row.fromPresentationStateKey,
      toStateId: row.toExploreStateId ?? undefined,
      toPresentationStateKey: row.toPresentationStateKey ?? undefined,
      guardDecision: row.guardDecision,
      guardReason: row.guardReason,
      actionOutcome: row.actionOutcome,
      locationVerify: row.locationVerify,
      actionVerify: row.actionVerify,
      pageChangeVerify: row.pageChangeVerify,
      businessResult: 'unknown',
      promoted: false,
      evidenceStatus: row.evidenceStatus,
      errorMessage: row.errorMessage ?? undefined,
      createdAt: row.createdAt.toISOString(),
    }),
  )
}

// ==========================================
// 5. Review Unknown
// ==========================================

export async function reviewUnknownExploreJob(
  db: Db,
  targetId: string,
  jobId: string,
  body: ReviewUnknownBody,
  actor: ExecutionActor,
): Promise<{ jobId: string; status: string }> {
  await requireLiveTarget(db, targetId)
  return atomic(db, async (tx) => {
    const { mapJobs, exploreTraversals } = schemaFor(tx)
    const [job] = await locked(
      tx,
      tx.select().from(mapJobs).where(and(eq(mapJobs.targetId, targetId), eq(mapJobs.id, jobId))),
    )
    if (!job) mapNotFound('地图作业不存在')
    if (job.jobStatus !== 'needs_review') {
      throw conflict('JOB_NOT_WAITING_REVIEW', '只有 needs_review 状态的作业可以进行未知人工核查')
    }

    const now = await clockNow(tx)
    const finalStatus = body.decision === 'cancelled' ? 'cancelled' : 'failed'

    await tx
      .update(mapJobs)
      .set({
        jobStatus: finalStatus,
        stopReason: finalStatus === 'cancelled' ? 'cancelled' : 'slice_failed',
        activeGuard: null,
        updatedAt: now,
      })
      .where(eq(mapJobs.id, jobId))

    await tx
      .update(exploreTraversals)
      .set({
        actionOutcome: 'failed',
        errorMessage: `人工核查判定：${body.decision}（${body.reason}）`,
      })
      .where(and(eq(exploreTraversals.jobId, jobId), eq(exploreTraversals.actionOutcome, 'unknown')))

    await recordAudit(
      tx,
      actor,
      'map.job.review_unknown',
      'target',
      targetId,
      `人工核查未知探索动作【${jobId}】：${body.decision}（${body.reason}）`,
    )

    return { jobId, status: finalStatus }
  })
}

// ==========================================
// 6. Runtime Execution Persistence
// ==========================================

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

export async function recordExploreDiscoveries(
  tx: Db,
  discoveries: Array<Omit<ExploreDiscovery, 'id' | 'createdAt'>>,
): Promise<string[]> {
  if (discoveries.length === 0) return []
  const { exploreDiscoveries } = schemaFor(tx)
  const ids: string[] = []
  const now = await clockNow(tx)
  for (const item of discoveries) {
    const id = (item as any).id ?? newId()
    ids.push(id)
    try {
      await insertRows(tx, exploreDiscoveries, {
        id,
        targetId: item.targetId,
        jobId: item.jobId,
        runId: item.runId,
        stepRunId: item.stepRunId ?? null,
        attemptId: item.attemptId ?? null,
        sourceExploreStateId: item.sourceStateId ?? null,
        sourcePresentationStateKey: item.sourcePresentationStateKey,
        controlFingerprint: item.controlFingerprint,
        accessibleName: item.accessibleName,
        role: item.role,
        ancestorPathJson: item.ancestorPath,
        frameSelector: item.frameSelector,
        candidateCategory: item.candidateCategory,
        targetUrl: item.targetUrl ?? null,
        targetDigest: item.targetDigest ?? null,
        targetHint: item.targetHint,
        locatorDescriptorJson: item.locatorDescriptor ?? null,
        collectorVersion: item.collectorVersion,
        evidenceStatus: item.evidenceStatus,
        rejectionReason: item.rejectionReason ?? null,
        status: item.status ?? 'discovered',
        createdAt: now,
      })
    } catch {
      // Idempotent by (job_id, control_fingerprint)
    }
  }
  return ids
}

export async function recordExploreTraversal(
  tx: Db,
  traversal: Omit<ExploreTraversal, 'id' | 'createdAt'>,
): Promise<string> {
  const { exploreTraversals } = schemaFor(tx)
  const id = (traversal as any).id ?? newId()
  const now = await clockNow(tx)
  await insertRows(tx, exploreTraversals, {
    id,
    targetId: traversal.targetId,
    jobId: traversal.jobId,
    runId: traversal.runId,
    attemptId: traversal.attemptId ?? null,
    exploreDiscoveryId: traversal.discoveryId ?? null,
    exploreReviewId: traversal.reviewId ?? null,
    actionCategory: traversal.actionCategory,
    relationType: traversal.relationType,
    fromExploreStateId: traversal.fromStateId ?? null,
    fromPresentationStateKey: traversal.fromPresentationStateKey,
    toExploreStateId: traversal.toStateId ?? null,
    toPresentationStateKey: traversal.toPresentationStateKey ?? null,
    guardDecision: traversal.guardDecision,
    guardReason: traversal.guardReason,
    actionOutcome: traversal.actionOutcome,
    locationVerify: traversal.locationVerify,
    actionVerify: traversal.actionVerify,
    pageChangeVerify: traversal.pageChangeVerify,
    businessResult: 'unknown',
    promoted: 0,
    evidenceStatus: traversal.evidenceStatus,
    errorMessage: traversal.errorMessage ?? null,
    createdAt: now,
  })
  return id
}
