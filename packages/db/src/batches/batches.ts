import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import {
  buildResultWorkbook,
  evaluateGenerator,
  type BatchDetail,
  type BatchExportResponse,
  type BatchFailureDomain,
  type BatchItemDto,
  type BatchItemStatus,
  type BatchPacing,
  type BatchStatus,
  type CreateBatchBody,
  type DataBinding,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { assertTargetPermission, lockConsoleAuthorization, scopedTargetFilter } from '../console/target-authorization.js'
import { newId } from '../id.js'
import { atomic, schemaFor } from '../native.js'
import { badRequest, notFound } from '../runs/errors.js'
import { writeRunWithSnapshot } from '../runs/runs.js'

async function assertBatchScenarioPermission(
  db: Db,
  scenarioId: string,
  actorId: string,
  permission: string,
) {
  const { scenarios } = schemaFor(db)
  const [scenario] = await db
    .select({ targetId: scenarios.targetId })
    .from(scenarios)
    .where(eq(scenarios.id, scenarioId))
    .limit(1)
  if (!scenario) throw notFound('BATCH_NOT_FOUND', '批量任务不存在')
  await assertTargetPermission(db, actorId, scenario.targetId, permission)
}

export async function createBatch(
  db: Db,
  input: CreateBatchBody,
  actorId: string,
): Promise<BatchDetail> {
  return atomic(db, async (tx) => {
    const { scenarios, scenarioVersions, datasets, datasetRows, batches, batchItems } =
      schemaFor(tx)

    const [scenario] = await tx
      .select()
      .from(scenarios)
      .where(and(eq(scenarios.id, input.scenarioId), isNull(scenarios.deletedAt)))
      .limit(1)
    if (!scenario) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')

    await lockConsoleAuthorization(tx, actorId)
    await assertTargetPermission(tx, actorId, scenario.targetId, 'batch:write')

    const [version] = await tx
      .select()
      .from(scenarioVersions)
      .where(eq(scenarioVersions.id, input.scenarioVersionId))
      .limit(1)
    if (!version || version.scenarioId !== scenario.id) {
      throw notFound('SCENARIO_VERSION_NOT_FOUND', '场景版本不存在')
    }

    const [dataset] = await tx
      .select()
      .from(datasets)
      .where(and(eq(datasets.id, input.datasetId), isNull(datasets.deletedAt)))
      .limit(1)
    if (!dataset || dataset.targetId !== scenario.targetId) {
      throw notFound('DATASET_NOT_FOUND', '数据集不存在')
    }

    let selectedIndices = input.selectedRowIndices
    if (!selectedIndices || selectedIndices.length === 0) {
      const dRows = await tx
        .select({ rowIndex: datasetRows.rowIndex })
        .from(datasetRows)
        .where(eq(datasetRows.datasetId, input.datasetId))
        .orderBy(asc(datasetRows.rowIndex))
      selectedIndices = dRows.map((r) => r.rowIndex)
    }

    const totalItems = selectedIndices.length
    const batchId = newId()
    const now = new Date()
    const pacingConfig: BatchPacing = input.pacing ?? { minDelayMs: 1500, maxDelayMs: 3500 }

    const [createdBatch] = await tx
      .insert(batches)
      .values({
        id: batchId,
        name: input.name,
        scenarioId: input.scenarioId,
        scenarioVersionId: input.scenarioVersionId,
        datasetId: input.datasetId,
        targetAccountId: input.targetAccountId ?? null,
        status: 'QUEUED',
        failurePolicy: input.failurePolicy ?? 'stop_on_threshold',
        failureThreshold: input.failureThreshold ?? 5,
        dataBindings: input.binding ?? {},
        pacingConfig,
        totalItems,
        successItems: 0,
        failedItems: 0,
        reviewItems: 0,
        createdByAccountId: actorId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    const itemChunkSize = 200
    for (let i = 0; i < totalItems; i += itemChunkSize) {
      const chunk = selectedIndices.slice(i, i + itemChunkSize)
      await tx.insert(batchItems).values(
        chunk.map((rowIndex) => ({
          id: newId(),
          batchId,
          datasetRowIndex: rowIndex,
          itemStatus: 'PENDING' as const,
        })),
      )
    }

    return {
      id: createdBatch!.id,
      name: createdBatch!.name,
      scenarioId: createdBatch!.scenarioId,
      scenarioVersionId: createdBatch!.scenarioVersionId,
      datasetId: createdBatch!.datasetId,
      targetAccountId: createdBatch!.targetAccountId,
      status: createdBatch!.status,
      failurePolicy: createdBatch!.failurePolicy,
      failureThreshold: createdBatch!.failureThreshold,
      pacingConfig: createdBatch!.pacingConfig,
      totalItems: createdBatch!.totalItems,
      successItems: createdBatch!.successItems,
      failedItems: createdBatch!.failedItems,
      reviewItems: createdBatch!.reviewItems,
      pausedReason: createdBatch!.pausedReason,
      createdByAccountId: createdBatch!.createdByAccountId!,
      createdAt: createdBatch!.createdAt.toISOString(),
      updatedAt: createdBatch!.updatedAt.toISOString(),
    }
  })
}

export async function advanceBatch(
  db: Db,
  batchId: string,
  concurrencyLimit = 5,
): Promise<{ dispatchedRunIds: string[]; completed: boolean; paused: boolean }> {
  return atomic(db, async (tx) => {
    const { batches, batchItems, datasets, datasetRows } = schemaFor(tx)

    const [batch] = await tx
      .select()
      .from(batches)
      .where(eq(batches.id, batchId))
      .for('update')
      .limit(1)

    if (!batch) throw notFound('BATCH_NOT_FOUND', '批量任务不存在')

    if (batch.status === 'PAUSED') {
      return { dispatchedRunIds: [], completed: false, paused: true }
    }
    if (batch.status === 'COMPLETED' || batch.status === 'CANCELLED' || batch.status === 'FAILED') {
      return { dispatchedRunIds: [], completed: true, paused: false }
    }

    const activeItems = await tx
      .select({ id: batchItems.id })
      .from(batchItems)
      .where(and(eq(batchItems.batchId, batchId), eq(batchItems.itemStatus, 'RUNNING')))

    const availableSlots = Math.max(0, concurrencyLimit - activeItems.length)
    if (availableSlots <= 0) {
      return { dispatchedRunIds: [], completed: false, paused: false }
    }

    const pendingItems = await tx
      .select()
      .from(batchItems)
      .where(and(eq(batchItems.batchId, batchId), eq(batchItems.itemStatus, 'PENDING')))
      .orderBy(asc(batchItems.datasetRowIndex))
      .limit(availableSlots)

    if (pendingItems.length === 0) {
      if (activeItems.length === 0) {
        await tx
          .update(batches)
          .set({ status: 'COMPLETED', updatedAt: new Date() })
          .where(eq(batches.id, batchId))
        return { dispatchedRunIds: [], completed: true, paused: false }
      }
      return { dispatchedRunIds: [], completed: false, paused: false }
    }

    const dispatchedRunIds: string[] = []
    const now = new Date()

    for (const item of pendingItems) {
      let itemInput: Record<string, any> = {}
      if (batch.datasetId) {
        const [dRow] = await tx
          .select()
          .from(datasetRows)
          .where(
            and(
              eq(datasetRows.datasetId, batch.datasetId),
              eq(datasetRows.rowIndex, item.datasetRowIndex),
            ),
          )
          .limit(1)
        const rowData = (dRow?.rowData ?? {}) as Record<string, any>
        const bindings = (batch.dataBindings ?? {}) as DataBinding
        for (const [key, b] of Object.entries(bindings)) {
          if (b.source === 'column') {
            itemInput[key] = rowData[b.columnName]
          } else if (b.source === 'fixed') {
            itemInput[key] = b.value
          } else if (b.source === 'generator') {
            itemInput[key] = evaluateGenerator(b.spec)
          }
        }
      }

      const { runId } = await writeRunWithSnapshot(tx as unknown as Db, {
        scenarioId: batch.scenarioId,
        scenarioVersionId: batch.scenarioVersionId,
        targetAccountId: batch.targetAccountId ?? undefined,
        executionOrigin: 'batch_item',
        input: itemInput,
        actor: {
          kind: 'console',
          id: batch.createdByAccountId ?? 'system',
        },
      })

      await tx
        .update(batchItems)
        .set({
          runId,
          itemStatus: 'RUNNING',
          startedAt: now,
        })
        .where(eq(batchItems.id, item.id))

      dispatchedRunIds.push(runId)
    }

    if (batch.status === 'QUEUED' && dispatchedRunIds.length > 0) {
      await tx
        .update(batches)
        .set({ status: 'RUNNING', updatedAt: now })
        .where(eq(batches.id, batchId))
    }

    return { dispatchedRunIds, completed: false, paused: false }
  })
}

export async function onRunSettledForBatch(
  db: Db,
  runId: string,
  verdict: {
    status: 'passed' | 'failed' | 'review' | 'cancelled'
    outcomeVerdict?: string
    failureDomain?: BatchFailureDomain
    errorMessage?: string
  },
): Promise<{ batchId: string; batchStatus: BatchStatus } | null> {
  return atomic(db, async (tx) => {
    const { batches, batchItems } = schemaFor(tx)

    const [item] = await tx
      .select()
      .from(batchItems)
      .where(eq(batchItems.runId, runId))
      .limit(1)

    if (!item) return null

    const [batch] = await tx
      .select()
      .from(batches)
      .where(eq(batches.id, item.batchId))
      .for('update')
      .limit(1)

    if (!batch) return null

    let newItemStatus: BatchItemStatus = 'SUCCEEDED'
    if (verdict.status === 'failed') newItemStatus = 'FAILED'
    else if (verdict.status === 'review') newItemStatus = 'NEEDS_REVIEW'
    else if (verdict.status === 'cancelled') newItemStatus = 'CANCELLED'

    const now = new Date()
    await tx
      .update(batchItems)
      .set({
        itemStatus: newItemStatus,
        outcomeVerdict: verdict.outcomeVerdict ?? null,
        failureDomain: verdict.failureDomain ?? null,
        errorMessage: verdict.errorMessage ?? null,
        finishedAt: now,
      })
      .where(eq(batchItems.id, item.id))

    const successDelta = newItemStatus === 'SUCCEEDED' ? 1 : 0
    const failedDelta = newItemStatus === 'FAILED' ? 1 : 0
    const reviewDelta = newItemStatus === 'NEEDS_REVIEW' ? 1 : 0

    const updatedSuccess = batch.successItems + successDelta
    const updatedFailed = batch.failedItems + failedDelta
    const updatedReview = batch.reviewItems + reviewDelta

    let newBatchStatus = batch.status
    let pausedReason = batch.pausedReason

    // 检查熔断器 (DC-11, DC-12)
    if (
      verdict.failureDomain === 'TARGET' &&
      (batch.failurePolicy === 'stop_on_threshold' || batch.failurePolicy === 'stop_on_first')
    ) {
      if (batch.failurePolicy === 'stop_on_first') {
        newBatchStatus = 'PAUSED'
        pausedReason = 'CIRCUIT_BREAKER_TRIGGERED: 目标系统首次发生异常，触发熔断保护'
      } else {
        const recentFinished = await tx
          .select({
            failureDomain: batchItems.failureDomain,
            itemStatus: batchItems.itemStatus,
          })
          .from(batchItems)
          .where(
            and(
              eq(batchItems.batchId, batch.id),
              inArray(batchItems.itemStatus, ['SUCCEEDED', 'FAILED', 'NEEDS_REVIEW']),
            ),
          )
          .orderBy(desc(batchItems.finishedAt))
          .limit(batch.failureThreshold)

        let consecutiveTargetErrors = 0
        for (const r of recentFinished) {
          if (r.failureDomain === 'TARGET') {
            consecutiveTargetErrors++
          } else {
            break
          }
        }

        if (consecutiveTargetErrors >= batch.failureThreshold) {
          newBatchStatus = 'PAUSED'
          pausedReason = `CIRCUIT_BREAKER_TRIGGERED: 目标系统连续发生 ${consecutiveTargetErrors} 次异常，触发自动熔断保护`
        }
      }
    }

    if (
      newBatchStatus === 'RUNNING' &&
      updatedSuccess + updatedFailed + updatedReview >= batch.totalItems
    ) {
      newBatchStatus = 'COMPLETED'
    }

    await tx
      .update(batches)
      .set({
        successItems: updatedSuccess,
        failedItems: updatedFailed,
        reviewItems: updatedReview,
        status: newBatchStatus,
        pausedReason,
        updatedAt: now,
      })
      .where(eq(batches.id, batch.id))

    return {
      batchId: batch.id,
      batchStatus: newBatchStatus,
    }
  })
}

export async function pauseBatch(
  db: Db,
  batchId: string,
  reason?: string,
  actorId?: string,
): Promise<BatchDetail> {
  return atomic(db, async (tx) => {
    const { batches, scenarios } = schemaFor(tx)
    const [batch] = await tx
      .select()
      .from(batches)
      .where(eq(batches.id, batchId))
      .for('update')
      .limit(1)
    if (!batch) throw notFound('BATCH_NOT_FOUND', '批量任务不存在')

    if (actorId) {
      const [scenario] = await tx
        .select()
        .from(scenarios)
        .where(eq(scenarios.id, batch.scenarioId))
        .limit(1)
      if (scenario) {
        await lockConsoleAuthorization(tx, actorId)
        await assertTargetPermission(tx, actorId, scenario.targetId, 'batch:execute')
      }
    }

    const [updated] = await tx
      .update(batches)
      .set({
        status: 'PAUSED',
        pausedReason: reason ?? '人工暂停',
        updatedAt: new Date(),
      })
      .where(eq(batches.id, batchId))
      .returning()

    return {
      id: updated!.id,
      name: updated!.name,
      scenarioId: updated!.scenarioId,
      scenarioVersionId: updated!.scenarioVersionId,
      datasetId: updated!.datasetId,
      targetAccountId: updated!.targetAccountId,
      status: updated!.status,
      failurePolicy: updated!.failurePolicy,
      failureThreshold: updated!.failureThreshold,
      pacingConfig: updated!.pacingConfig,
      totalItems: updated!.totalItems,
      successItems: updated!.successItems,
      failedItems: updated!.failedItems,
      reviewItems: updated!.reviewItems,
      pausedReason: updated!.pausedReason,
      createdByAccountId: updated!.createdByAccountId!,
      createdAt: updated!.createdAt.toISOString(),
      updatedAt: updated!.updatedAt.toISOString(),
    }
  })
}

export async function resumeBatch(db: Db, batchId: string, actorId?: string): Promise<BatchDetail> {
  return atomic(db, async (tx) => {
    const { batches, scenarios } = schemaFor(tx)
    const [batch] = await tx
      .select()
      .from(batches)
      .where(eq(batches.id, batchId))
      .for('update')
      .limit(1)
    if (!batch) throw notFound('BATCH_NOT_FOUND', '批量任务不存在')

    if (actorId) {
      const [scenario] = await tx
        .select()
        .from(scenarios)
        .where(eq(scenarios.id, batch.scenarioId))
        .limit(1)
      if (scenario) {
        await lockConsoleAuthorization(tx, actorId)
        await assertTargetPermission(tx, actorId, scenario.targetId, 'batch:execute')
      }
    }

    const [updated] = await tx
      .update(batches)
      .set({
        status: 'RUNNING',
        pausedReason: null,
        updatedAt: new Date(),
      })
      .where(eq(batches.id, batchId))
      .returning()

    return {
      id: updated!.id,
      name: updated!.name,
      scenarioId: updated!.scenarioId,
      scenarioVersionId: updated!.scenarioVersionId,
      datasetId: updated!.datasetId,
      targetAccountId: updated!.targetAccountId,
      status: updated!.status,
      failurePolicy: updated!.failurePolicy,
      failureThreshold: updated!.failureThreshold,
      pacingConfig: updated!.pacingConfig,
      totalItems: updated!.totalItems,
      successItems: updated!.successItems,
      failedItems: updated!.failedItems,
      reviewItems: updated!.reviewItems,
      pausedReason: updated!.pausedReason,
      createdByAccountId: updated!.createdByAccountId!,
      createdAt: updated!.createdAt.toISOString(),
      updatedAt: updated!.updatedAt.toISOString(),
    }
  })
}

export async function cancelBatch(
  db: Db,
  batchId: string,
  reason?: string,
  actorId?: string,
): Promise<BatchDetail> {
  return atomic(db, async (tx) => {
    const { batches, batchItems, scenarios } = schemaFor(tx)
    const [batch] = await tx
      .select()
      .from(batches)
      .where(eq(batches.id, batchId))
      .for('update')
      .limit(1)
    if (!batch) throw notFound('BATCH_NOT_FOUND', '批量任务不存在')

    if (actorId) {
      const [scenario] = await tx
        .select()
        .from(scenarios)
        .where(eq(scenarios.id, batch.scenarioId))
        .limit(1)
      if (scenario) {
        await lockConsoleAuthorization(tx, actorId)
        await assertTargetPermission(tx, actorId, scenario.targetId, 'batch:execute')
      }
    }

    const now = new Date()
    await tx
      .update(batchItems)
      .set({
        itemStatus: 'CANCELLED',
        finishedAt: now,
      })
      .where(and(eq(batchItems.batchId, batchId), eq(batchItems.itemStatus, 'PENDING')))

    const [updated] = await tx
      .update(batches)
      .set({
        status: 'CANCELLED',
        pausedReason: reason ?? '人工取消',
        updatedAt: now,
      })
      .where(eq(batches.id, batchId))
      .returning()

    return {
      id: updated!.id,
      name: updated!.name,
      scenarioId: updated!.scenarioId,
      scenarioVersionId: updated!.scenarioVersionId,
      datasetId: updated!.datasetId,
      targetAccountId: updated!.targetAccountId,
      status: updated!.status,
      failurePolicy: updated!.failurePolicy,
      failureThreshold: updated!.failureThreshold,
      pacingConfig: updated!.pacingConfig,
      totalItems: updated!.totalItems,
      successItems: updated!.successItems,
      failedItems: updated!.failedItems,
      reviewItems: updated!.reviewItems,
      pausedReason: updated!.pausedReason,
      createdByAccountId: updated!.createdByAccountId!,
      createdAt: updated!.createdAt.toISOString(),
      updatedAt: updated!.updatedAt.toISOString(),
    }
  })
}

export async function retryFailedBatch(
  db: Db,
  batchId: string,
  actorId: string,
): Promise<BatchDetail> {
  return atomic(db, async (tx) => {
    const { batches, batchItems, scenarios } = schemaFor(tx)
    const [parentBatch] = await tx
      .select()
      .from(batches)
      .where(eq(batches.id, batchId))
      .limit(1)
    if (!parentBatch) throw notFound('BATCH_NOT_FOUND', '批量任务不存在')

    const [scenario] = await tx
      .select()
      .from(scenarios)
      .where(eq(scenarios.id, parentBatch.scenarioId))
      .limit(1)
    if (scenario) {
      await lockConsoleAuthorization(tx, actorId)
      await assertTargetPermission(tx, actorId, scenario.targetId, 'batch:write')
    }

    const failedItems = await tx
      .select()
      .from(batchItems)
      .where(and(eq(batchItems.batchId, batchId), eq(batchItems.itemStatus, 'FAILED')))
      .orderBy(asc(batchItems.datasetRowIndex))

    if (failedItems.length === 0) {
      throw badRequest('NO_FAILED_ITEMS', '该批次无失败项目，无需重试')
    }

    const newBatchId = newId()
    const now = new Date()

    const [newBatch] = await tx
      .insert(batches)
      .values({
        id: newBatchId,
        name: `[重试] ${parentBatch.name}`,
        scenarioId: parentBatch.scenarioId,
        scenarioVersionId: parentBatch.scenarioVersionId,
        datasetId: parentBatch.datasetId,
        targetAccountId: parentBatch.targetAccountId,
        status: 'QUEUED',
        failurePolicy: parentBatch.failurePolicy,
        failureThreshold: parentBatch.failureThreshold,
        dataBindings: parentBatch.dataBindings,
        pacingConfig: parentBatch.pacingConfig,
        totalItems: failedItems.length,
        successItems: 0,
        failedItems: 0,
        reviewItems: 0,
        createdByAccountId: actorId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    for (let i = 0; i < failedItems.length; i++) {
      const item = failedItems[i]!
      await tx.insert(batchItems).values({
        id: newId(),
        batchId: newBatchId,
        datasetRowIndex: item.datasetRowIndex,
        itemStatus: 'PENDING',
      })
    }

    return {
      id: newBatch!.id,
      name: newBatch!.name,
      scenarioId: newBatch!.scenarioId,
      scenarioVersionId: newBatch!.scenarioVersionId,
      datasetId: newBatch!.datasetId,
      targetAccountId: newBatch!.targetAccountId,
      status: newBatch!.status,
      failurePolicy: newBatch!.failurePolicy,
      failureThreshold: newBatch!.failureThreshold,
      pacingConfig: newBatch!.pacingConfig,
      totalItems: newBatch!.totalItems,
      successItems: newBatch!.successItems,
      failedItems: newBatch!.failedItems,
      reviewItems: newBatch!.reviewItems,
      pausedReason: newBatch!.pausedReason,
      createdByAccountId: newBatch!.createdByAccountId!,
      createdAt: newBatch!.createdAt.toISOString(),
      updatedAt: newBatch!.updatedAt.toISOString(),
    }
  })
}

export async function getBatch(db: Db, batchId: string, actorId?: string): Promise<BatchDetail | null> {
  const { batches } = schemaFor(db)
  const [b] = await db.select().from(batches).where(eq(batches.id, batchId)).limit(1)
  if (!b) return null
  if (actorId) await assertBatchScenarioPermission(db, b.scenarioId, actorId, 'batch:read')
  return {
    id: b.id,
    name: b.name,
    scenarioId: b.scenarioId,
    scenarioVersionId: b.scenarioVersionId,
    datasetId: b.datasetId,
    targetAccountId: b.targetAccountId,
    status: b.status,
    failurePolicy: b.failurePolicy,
    failureThreshold: b.failureThreshold,
    pacingConfig: b.pacingConfig,
    totalItems: b.totalItems,
    successItems: b.successItems,
    failedItems: b.failedItems,
    reviewItems: b.reviewItems,
    pausedReason: b.pausedReason,
    createdByAccountId: b.createdByAccountId ?? 'system',
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  }
}

export async function listBatches(
  db: Db,
  query: { scenarioId?: string; datasetId?: string; limit?: number; cursor?: string },
  actorId?: string,
): Promise<{ items: BatchDetail[]; nextCursor?: string }> {
  const { batches, scenarios } = schemaFor(db)
  const limit = Math.min(query.limit ?? 20, 100)
  const filters = [
    await scopedTargetFilter(db, actorId, scenarios.targetId, 'batch:read'),
    query.scenarioId ? eq(batches.scenarioId, query.scenarioId) : undefined,
    query.datasetId ? eq(batches.datasetId, query.datasetId) : undefined,
  ].filter((item): item is SQL => item !== undefined)

  const rows = await db
    .select({ batch: batches })
    .from(batches)
    .innerJoin(scenarios, eq(scenarios.id, batches.scenarioId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(batches.createdAt), desc(batches.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const items = (hasMore ? rows.slice(0, limit) : rows).map((row) => {
    const b = row.batch
    return {
      id: b.id,
      name: b.name,
      scenarioId: b.scenarioId,
      scenarioVersionId: b.scenarioVersionId,
      datasetId: b.datasetId,
      targetAccountId: b.targetAccountId,
      status: b.status,
      failurePolicy: b.failurePolicy,
      failureThreshold: b.failureThreshold,
      pacingConfig: b.pacingConfig,
      totalItems: b.totalItems,
      successItems: b.successItems,
      failedItems: b.failedItems,
      reviewItems: b.reviewItems,
      pausedReason: b.pausedReason,
      createdByAccountId: b.createdByAccountId ?? 'system',
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    }
  })

  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
  }
}

export async function getBatchItems(
  db: Db,
  batchId: string,
  options?: { limit?: number; offset?: number; status?: BatchItemStatus },
  actorId?: string,
): Promise<{ items: BatchItemDto[]; total: number }> {
  if (actorId) {
    const batch = await getBatch(db, batchId, actorId)
    if (!batch) throw notFound('BATCH_NOT_FOUND', '批量任务不存在')
  }
  const { batchItems } = schemaFor(db)
  const limit = Math.min(options?.limit ?? 50, 100)
  const offset = options?.offset ?? 0

  const conditions = [eq(batchItems.batchId, batchId)]
  if (options?.status) {
    conditions.push(eq(batchItems.itemStatus, options.status))
  }

  const [totalRes] = await db
    .select({ total: sql<number>`count(*)` })
    .from(batchItems)
    .where(and(...conditions))

  const rows = await db
    .select()
    .from(batchItems)
    .where(and(...conditions))
    .orderBy(asc(batchItems.datasetRowIndex))
    .limit(limit)
    .offset(offset)

  return {
    items: rows.map((r) => ({
      id: r.id,
      batchId: r.batchId,
      datasetRowIndex: r.datasetRowIndex,
      runId: r.runId,
      itemStatus: r.itemStatus,
      outcomeVerdict: r.outcomeVerdict,
      failureDomain: r.failureDomain,
      errorMessage: r.errorMessage,
      startedAt: r.startedAt?.toISOString(),
      finishedAt: r.finishedAt?.toISOString(),
    })),
    total: Number(totalRes?.total ?? 0),
  }
}

export async function exportBatchResults(
  db: Db,
  batchId: string,
  actorId?: string,
): Promise<BatchExportResponse> {
  const { batches, batchItems, datasetRows, datasets } = schemaFor(db)

  const [batch] = await db.select().from(batches).where(eq(batches.id, batchId)).limit(1)
  if (!batch) throw notFound('BATCH_NOT_FOUND', '批量任务不存在')
  if (actorId) await assertBatchScenarioPermission(db, batch.scenarioId, actorId, 'batch:read')

  let originalColumns: string[] = []
  const originalRows: Record<string, string | number | boolean | null>[] = []

  if (batch.datasetId) {
    const [dataset] = await db
      .select()
      .from(datasets)
      .where(eq(datasets.id, batch.datasetId))
      .limit(1)
    if (dataset) {
      originalColumns = (dataset.columnsMeta as { name: string }[]).map((c) => c.name)
    }
    const dRows = await db
      .select()
      .from(datasetRows)
      .where(eq(datasetRows.datasetId, batch.datasetId))
      .orderBy(asc(datasetRows.rowIndex))
    for (const r of dRows) {
      originalRows.push(r.rowData as any)
    }
  }

  const items = await db
    .select()
    .from(batchItems)
    .where(eq(batchItems.batchId, batchId))
    .orderBy(asc(batchItems.datasetRowIndex))

  const exportColumns = [
    ...originalColumns,
    '_cairn_status',
    '_cairn_error',
    '_cairn_verdict',
    '_cairn_run_id',
    '_cairn_duration_ms',
  ]

  const exportRows: (string | number | boolean | null | undefined)[][] = []
  const successRows: (string | number | boolean | null | undefined)[][] = []
  const failedRows: (string | number | boolean | null | undefined)[][] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const rowData = originalRows[item.datasetRowIndex] ?? {}
    const rowValues = originalColumns.map((c) => rowData[c] ?? '')
    const durationMs =
      item.finishedAt && item.startedAt
        ? Math.max(0, item.finishedAt.getTime() - item.startedAt.getTime())
        : ''
    rowValues.push(
      item.itemStatus,
      item.errorMessage ?? '',
      item.outcomeVerdict ?? '',
      item.runId ?? '',
      durationMs,
    )
    exportRows.push(rowValues)
    if (item.itemStatus === 'SUCCEEDED') {
      successRows.push(rowValues)
    } else if (item.itemStatus === 'FAILED') {
      failedRows.push(rowValues)
    }
  }

  const sheets = [
    {
      name: '执行结果',
      columns: exportColumns,
      rows: exportRows,
    },
  ]
  if (successRows.length > 0) {
    sheets.push({
      name: '成功明细',
      columns: exportColumns,
      rows: successRows,
    })
  }
  if (failedRows.length > 0) {
    sheets.push({
      name: '失败明细',
      columns: exportColumns,
      rows: failedRows,
    })
  }

  const buffer = buildResultWorkbook(sheets)

  return {
    filename: `${batch.name}_执行结果.xlsx`,
    base64: Buffer.from(buffer).toString('base64'),
    rowCount: items.length,
  }
}
