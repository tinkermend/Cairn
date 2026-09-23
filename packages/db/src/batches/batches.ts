import { and, asc, desc, eq, exists, gt, inArray, isNull, not, sql, type SQL } from 'drizzle-orm'
import {
  buildResultWorkbook,
  evaluateGenerator,
  FACTORY_PLATFORM_CONFIG,
  FIXTURE_STEPS_DISABLED_CODE,
  FIXTURE_STEPS_DISABLED_MESSAGE,
  isFinishedRunStatus,
  isFixtureStepType,
  unresolvedRunInputMessage,
  unresolvedRunInputs,
  type BatchDetail,
  type BatchExportResponse,
  type BatchFailureDomain,
  type BatchItemDto,
  type BatchItemStatus,
  type BatchPacing,
  type BatchStatus,
  type CreateBatchBody,
  type DataBinding,
  type ScenarioInputDecl,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { cursorFilter, decodeIndexCursor, encodeCursor } from '../cursor.js'
import { assertAccountAllowsBusiness } from '../console/account-usage.js'
import { assertTargetPermission, lockConsoleAuthorization, scopedTargetFilter } from '../console/target-authorization.js'
import { newId } from '../id.js'
import { lockRunRow } from '../leases/leases.js'
import { atomic, schemaFor, updateRows } from '../native.js'
import { appendRunEvents } from '../observe/events.js'
import { getPlatformConfig } from '../platform-config/store.js'
import { badRequest, conflict, DomainError, notFound } from '../runs/errors.js'
import { lockRunAccountScope } from '../runs/lock-scope.js'
import { settleRunCancellationTx } from '../runs/recover.js'
import { requestRunCancel, resolveRunTargetAccountId, writeRunWithSnapshot } from '../runs/runs.js'

const STRANDED_BATCH_SCAN_LIMIT = 10

export type BatchDispatchResult =
  | { ok: true; dispatchedRunIds: string[]; completed: boolean; paused: boolean }
  | { ok: false; deterministic: boolean; error: unknown }

export function isDeterministicDispatchError(error: unknown): error is DomainError {
  return (
    error instanceof DomainError &&
    (error.kind === 'bad_request' || error.kind === 'conflict' || error.kind === 'not_found')
  )
}

function materializeBatchInput(
  rowData: Record<string, unknown>,
  bindings: DataBinding,
  inputs: readonly ScenarioInputDecl[] | undefined,
): Record<string, unknown> {
  const itemInput: Record<string, unknown> = {}
  for (const [key, binding] of Object.entries(bindings)) {
    if (binding.source === 'column') itemInput[key] = rowData[binding.columnName]
    else if (binding.source === 'fixed') itemInput[key] = binding.value
    else itemInput[key] = evaluateGenerator(binding.spec)
  }
  for (const decl of inputs ?? []) {
    const value = itemInput[decl.key]
    if ((value === undefined || value === null || value === '') && decl.defaultGenerator) {
      itemInput[decl.key] = evaluateGenerator(decl.defaultGenerator)
    }
  }
  return itemInput
}

/** 与 writeRunWithSnapshot 的开跑条件对齐。行解析只在创建和重试时做，避免每一窗都重放生成器。 */
async function assertBatchCanStart(
  db: Db,
  input: {
    scenarioId: string
    scenarioVersionId: string
    targetAccountId?: string | null
    datasetId?: string | null
    rowIndices?: number[]
    bindings?: DataBinding
    checkRows: boolean
  },
): Promise<void> {
  const { scenarios, scenarioVersions, targets, targetAccounts, datasetRows } = schemaFor(db)
  const [scenario] = await db
    .select()
    .from(scenarios)
    .where(eq(scenarios.id, input.scenarioId))
    .limit(1)
  if (!scenario || scenario.deletedAt) throw notFound('SCENARIO_NOT_FOUND', '场景不存在')
  if (scenario.status === 'disabled') throw conflict('SCENARIO_DISABLED', '场景已停用，不能创建新运行')

  const [version] = await db
    .select()
    .from(scenarioVersions)
    .where(eq(scenarioVersions.id, input.scenarioVersionId))
    .limit(1)
  if (!version || version.scenarioId !== scenario.id) {
    throw notFound('SCENARIO_VERSION_NOT_FOUND', '场景版本不存在')
  }
  if (version.kind !== 'published') {
    throw badRequest('SCENARIO_VERSION_NOT_PUBLISHED', '正式运行只能使用已发布版本')
  }

  const [target] = await db.select().from(targets).where(eq(targets.id, scenario.targetId)).limit(1)
  if (!target || target.deletedAt) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')
  if (target.status === 'disabled') throw conflict('TARGET_DISABLED', '目标系统已停用，不能创建新运行')

  const accountId =
    input.targetAccountId ??
    (await resolveRunTargetAccountId(db, { targetId: scenario.targetId, requestedAccountId: undefined }))
  if (accountId) {
    const [account] = await db
      .select()
      .from(targetAccounts)
      .where(eq(targetAccounts.id, accountId))
      .limit(1)
    if (!account || account.deletedAt || account.targetId !== scenario.targetId) {
      throw badRequest('RUN_ACCOUNT_MISMATCH', '目标账号不属于该场景绑定的目标系统')
    }
    if (account.status === 'disabled') throw conflict('RUN_ACCOUNT_DISABLED', '目标账号已停用')
    assertAccountAllowsBusiness(account.usage)
  }

  const platform = await getPlatformConfig(db)
  const document = platform?.document ?? FACTORY_PLATFORM_CONFIG
  if (!document.fixtureStepsEnabled) {
    const fixture = version.definition.steps.find((step) => isFixtureStepType(step.type))
    if (fixture) {
      throw badRequest(FIXTURE_STEPS_DISABLED_CODE, FIXTURE_STEPS_DISABLED_MESSAGE, {
        stepId: fixture.id,
        stepType: fixture.type,
      })
    }
  }

  if (!input.checkRows || !input.datasetId) return
  const stored = await db
    .select({ rowIndex: datasetRows.rowIndex, rowData: datasetRows.rowData })
    .from(datasetRows)
    .where(eq(datasetRows.datasetId, input.datasetId))
  const byIndex = new Map(stored.map((row) => [row.rowIndex, (row.rowData ?? {}) as Record<string, unknown>]))
  for (const rowIndex of input.rowIndices ?? []) {
    const itemInput = materializeBatchInput(
      byIndex.get(rowIndex) ?? {},
      input.bindings ?? {},
      version.authoringDocument?.inputs,
    )
    const unresolved = unresolvedRunInputs(version.definition.steps, itemInput)
    const first = unresolved[0]
    if (first) {
      throw badRequest('SCENARIO_UNRESOLVED_REF', `第 ${rowIndex + 1} 行：${unresolvedRunInputMessage(first)}`, {
        missingKeys: unresolved.map((item) => item.key),
        rowIndex,
      })
    }
  }
}

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
    await assertBatchCanStart(tx, {
      scenarioId: input.scenarioId,
      scenarioVersionId: input.scenarioVersionId,
      targetAccountId: input.targetAccountId,
      datasetId: input.datasetId,
      rowIndices: selectedIndices,
      bindings: input.binding ?? {},
      checkRows: true,
    })
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

    await assertBatchCanStart(tx, {
      scenarioId: batch.scenarioId,
      scenarioVersionId: batch.scenarioVersionId,
      targetAccountId: batch.targetAccountId,
      checkRows: false,
    })

    const creatorId = batch.createdByAccountId
    if (!creatorId) {
      throw badRequest('BATCH_CREATOR_MISSING', '创建该批次的账号已不存在，无法继续派发')
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
          id: creatorId,
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

    const [lockedItem] = await tx
      .select()
      .from(batchItems)
      .where(eq(batchItems.id, item.id))
      .for('update')
      .limit(1)
    if (!lockedItem || lockedItem.itemStatus !== 'RUNNING') {
      return { batchId: batch.id, batchStatus: batch.status }
    }

    let newItemStatus: BatchItemStatus = 'SUCCEEDED'
    if (verdict.status === 'failed') newItemStatus = 'FAILED'
    else if (verdict.status === 'review') newItemStatus = 'NEEDS_REVIEW'
    else if (verdict.status === 'cancelled') newItemStatus = 'CANCELLED'

    const now = new Date()
    const moved = await updateRows(
      tx,
      batchItems,
      {
        itemStatus: newItemStatus,
        outcomeVerdict: verdict.outcomeVerdict ?? null,
        failureDomain: verdict.failureDomain ?? null,
        errorMessage: verdict.errorMessage ?? null,
        finishedAt: now,
      },
      and(eq(batchItems.id, lockedItem.id), eq(batchItems.itemStatus, 'RUNNING')),
      { id: batchItems.id },
    )
    if (moved.length === 0) {
      return { batchId: batch.id, batchStatus: batch.status }
    }

    // 终态批次只收口明细，不再改计数、熔断或批次状态。
    if (batch.status === 'CANCELLED' || batch.status === 'COMPLETED' || batch.status === 'FAILED') {
      return { batchId: batch.id, batchStatus: batch.status }
    }

    const successDelta = newItemStatus === 'SUCCEEDED' ? 1 : 0
    const failedDelta = newItemStatus === 'FAILED' ? 1 : 0
    const reviewDelta = newItemStatus === 'NEEDS_REVIEW' ? 1 : 0

    const updatedSuccess = batch.successItems + successDelta
    const updatedFailed = batch.failedItems + failedDelta
    const updatedReview = batch.reviewItems + reviewDelta

    let newBatchStatus: BatchStatus = batch.status
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
    if (batch.status !== 'QUEUED' && batch.status !== 'RUNNING') {
      throw conflict('BATCH_STATUS_CONFLICT', `批次当前状态为 ${batch.status}，不能暂停`)
    }

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
    const { batches, batchItems, scenarios } = schemaFor(tx)
    const [batch] = await tx
      .select()
      .from(batches)
      .where(eq(batches.id, batchId))
      .for('update')
      .limit(1)
    if (!batch) throw notFound('BATCH_NOT_FOUND', '批量任务不存在')
    if (batch.status !== 'PAUSED') {
      throw conflict('BATCH_STATUS_CONFLICT', `批次当前状态为 ${batch.status}，不能恢复`)
    }

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

    const [active] = await tx
      .select({ id: batchItems.id })
      .from(batchItems)
      .where(and(eq(batchItems.batchId, batchId), eq(batchItems.itemStatus, 'RUNNING')))
      .limit(1)
    const [updated] = await tx
      .update(batches)
      .set({
        status: active ? 'RUNNING' : 'QUEUED',
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

async function cancelDispatchedRun(tx: Db, runId: string, actorId: string | null, now: Date) {
  if (actorId) {
    await requestRunCancel(tx, runId, { kind: 'console', id: actorId })
    return
  }
  await lockRunAccountScope(tx, runId)
  const current = await lockRunRow(tx, runId)
  if (!current || isFinishedRunStatus(current.status) || current.status === 'NEEDS_REVIEW') return
  const { runs } = schemaFor(tx)
  const firstCancel = current.cancelRequestedAt == null
  await tx
    .update(runs)
    .set({
      cancelRequestedAt: current.cancelRequestedAt ?? now,
      updatedAt: now,
    })
    .where(eq(runs.id, runId))
  if (firstCancel) {
    await appendRunEvents(tx, runId, [{ type: 'run.cancel_requested', payload: { cancelRequested: true } }])
  }
  await settleRunCancellationTx(tx, runId, now)
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
    if (batch.status === 'COMPLETED' || batch.status === 'CANCELLED') {
      throw conflict('BATCH_STATUS_CONFLICT', `批次当前状态为 ${batch.status}，不能取消`)
    }

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

    const running = await tx
      .select({ runId: batchItems.runId })
      .from(batchItems)
      .where(and(eq(batchItems.batchId, batchId), eq(batchItems.itemStatus, 'RUNNING')))
      .orderBy(asc(batchItems.runId))

    const [updated] = await tx
      .update(batches)
      .set({
        status: 'CANCELLED',
        pausedReason: reason ?? '人工取消',
        updatedAt: now,
      })
      .where(eq(batches.id, batchId))
      .returning()

    const cancelActorId = actorId ?? batch.createdByAccountId
    for (const row of running) {
      if (!row.runId) continue
      await cancelDispatchedRun(tx, row.runId, cancelActorId, now)
    }

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

    await assertBatchCanStart(tx, {
      scenarioId: parentBatch.scenarioId,
      scenarioVersionId: parentBatch.scenarioVersionId,
      targetAccountId: parentBatch.targetAccountId,
      datasetId: parentBatch.datasetId,
      rowIndices: failedItems.map((item) => item.datasetRowIndex),
      bindings: (parentBatch.dataBindings ?? {}) as DataBinding,
      checkRows: true,
    })

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

export async function failStrandedBatch(db: Db, batchId: string, reason: string): Promise<boolean> {
  return atomic(db, async (tx) => {
    const { batches, batchItems } = schemaFor(tx)
    const [batch] = await tx
      .select({ id: batches.id, status: batches.status })
      .from(batches)
      .where(eq(batches.id, batchId))
      .for('update')
      .limit(1)
    if (!batch || (batch.status !== 'QUEUED' && batch.status !== 'RUNNING')) return false
    const [active] = await tx
      .select({ id: batchItems.id })
      .from(batchItems)
      .where(and(eq(batchItems.batchId, batchId), eq(batchItems.itemStatus, 'RUNNING')))
      .limit(1)
    if (active) return false
    await tx
      .update(batches)
      .set({ status: 'FAILED', pausedReason: reason, updatedAt: new Date() })
      .where(eq(batches.id, batchId))
    return true
  })
}

export async function dispatchBatch(
  db: Db,
  batchId: string,
  concurrencyLimit = 5,
): Promise<BatchDispatchResult> {
  try {
    const result = await advanceBatch(db, batchId, concurrencyLimit)
    return { ok: true, ...result }
  } catch (error) {
    const deterministic = isDeterministicDispatchError(error)
    if (deterministic) {
      const message = error instanceof Error ? error.message : '批次无法派发'
      await failStrandedBatch(db, batchId, `派发失败：${message}`)
    }
    return { ok: false, deterministic, error }
  }
}

export async function sweepStrandedBatches(
  db: Db,
  limit = STRANDED_BATCH_SCAN_LIMIT,
): Promise<{ scanned: number; dispatched: number; failed: number; deferred: number }> {
  const { batches, batchItems } = schemaFor(db)
  const pending = db
    .select({ id: batchItems.id })
    .from(batchItems)
    .where(and(eq(batchItems.batchId, batches.id), eq(batchItems.itemStatus, 'PENDING')))
  const running = db
    .select({ id: batchItems.id })
    .from(batchItems)
    .where(and(eq(batchItems.batchId, batches.id), eq(batchItems.itemStatus, 'RUNNING')))
  const rows = await db
    .select({ id: batches.id })
    .from(batches)
    .where(
      and(
        inArray(batches.status, ['QUEUED', 'RUNNING']),
        exists(pending),
        not(exists(running)),
      ),
    )
    .orderBy(asc(batches.updatedAt), asc(batches.id))
    .limit(Math.min(Math.max(limit, 1), 50))

  let dispatched = 0
  let failed = 0
  let deferred = 0
  for (const row of rows) {
    const outcome = await dispatchBatch(db, row.id)
    if (!outcome.ok) {
      if (outcome.deterministic) failed += 1
      else deferred += 1
      continue
    }
    if (outcome.dispatchedRunIds.length > 0 || outcome.completed) dispatched += 1
  }
  return { scanned: rows.length, dispatched, failed, deferred }
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
    createdByAccountId: b.createdByAccountId,
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
    cursorFilter(batches.createdAt, batches.id, query.cursor),
  ].filter((item): item is SQL => item !== undefined)

  const rows = await db
    .select({ batch: batches })
    .from(batches)
    .innerJoin(scenarios, eq(scenarios.id, batches.scenarioId))
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(batches.createdAt), desc(batches.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)?.batch
  const items = page.map((row) => {
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
      createdByAccountId: b.createdByAccountId,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    }
  })

  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : undefined,
  }
}

export async function getBatchItems(
  db: Db,
  batchId: string,
  options?: { limit?: number; cursor?: string; status?: BatchItemStatus },
  actorId?: string,
): Promise<{ items: BatchItemDto[]; total: number; nextCursor?: string }> {
  if (actorId) {
    const batch = await getBatch(db, batchId, actorId)
    if (!batch) throw notFound('BATCH_NOT_FOUND', '批量任务不存在')
  }
  const { batchItems } = schemaFor(db)
  const limit = Math.min(options?.limit ?? 50, 100)
  const conditions = [eq(batchItems.batchId, batchId)]
  if (options?.status) {
    conditions.push(eq(batchItems.itemStatus, options.status))
  }

  const [totalRes] = await db
    .select({ total: sql<number>`count(*)` })
    .from(batchItems)
    .where(and(...conditions))

  if (options?.cursor) {
    conditions.push(gt(batchItems.datasetRowIndex, decodeIndexCursor(options.cursor)))
  }

  const rows = await db
    .select()
    .from(batchItems)
    .where(and(...conditions))
    .orderBy(asc(batchItems.datasetRowIndex))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)

  return {
    items: page.map((r) => ({
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
    nextCursor: hasMore && last ? String(last.datasetRowIndex) : undefined,
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
