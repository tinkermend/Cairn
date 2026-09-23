import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import {
  BUSINESS_SOURCE_CURSOR_EXPIRED,
  type ApproveCandidateBody,
  type BusinessRecordDto,
  type BusinessRecordsListQuery,
  type BusinessRecordsResponse,
  type BusinessSourceMappingConfig,
  type CreateBusinessSourceCandidateBody,
  type PreviewBusinessSourceBody,
  type PreviewBusinessSourceResponse,
  type PreviewRow,
  type RevokeSourceBody,
  type TargetBusinessSourceDto,
  type TargetBusinessSourceSnapshotDto,
  type ValidationSummary,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { assertTargetPermission, lockConsoleAuthorization } from '../console/target-authorization.js'
import { newId } from '../id.js'
import { atomic, schemaFor } from '../native.js'
import { badRequest, conflict, notFound } from '../runs/errors.js'

const SENSITIVE_COLUMN_PATTERN = /password|secret|token|otp|\bpin\b|密码|口令|验证码|私钥|bank_account|credit_card/i

export function encodeBusinessRecordCursor(snapshotId: string, rowIndex: number, id: string): string {
  return Buffer.from(`${snapshotId}|${rowIndex}|${id}`, 'utf8').toString('base64url')
}

export function decodeBusinessRecordCursor(cursor: string): { snapshotId: string; rowIndex: number; id: string } {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parts = raw.split('|')
    if (parts.length !== 3) throw new Error('bad cursor')
    const [snapshotId, rowIndexStr, id] = parts
    const rowIndex = Number(rowIndexStr)
    if (!snapshotId || Number.isNaN(rowIndex) || !id) throw new Error('bad cursor')
    return { snapshotId, rowIndex, id }
  } catch {
    throw badRequest('INVALID_CURSOR', '业务数据游标无效')
  }
}

export async function getBusinessSource(
  db: Db,
  targetId: string,
  entityType = 'manufacturer',
  actorId?: string,
): Promise<TargetBusinessSourceDto | null> {
  if (actorId) {
    await assertTargetPermission(db, actorId, targetId, 'target:read')
    await assertTargetPermission(db, actorId, targetId, 'dataset:read')
  }
  const { targetBusinessSources } = schemaFor(db)
  const [row] = await db
    .select()
    .from(targetBusinessSources)
    .where(and(eq(targetBusinessSources.targetId, targetId), eq(targetBusinessSources.entityType, entityType)))
    .limit(1)

  if (!row) return null

  return {
    id: row.id,
    targetId: row.targetId,
    entityType: row.entityType,
    sourceKind: 'dataset_snapshot',
    currentSnapshotId: row.currentSnapshotId,
    bindingRevision: row.bindingRevision,
    status: row.status as TargetBusinessSourceDto['status'],
    ownerAccountId: row.ownerAccountId,
    approverAccountId: row.approverAccountId,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    declaredSourceAsOf: row.declaredSourceAsOf?.toISOString() ?? null,
    declaredByAccountId: row.declaredByAccountId,
    declarationBasis: row.declarationBasis,
    validUntil: row.validUntil?.toISOString() ?? null,
    completenessBasis: row.completenessBasis,
    completenessStatus: row.completenessStatus as TargetBusinessSourceDto['completenessStatus'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function previewBusinessSource(
  db: Db,
  targetId: string,
  input: PreviewBusinessSourceBody,
  actorId?: string,
): Promise<PreviewBusinessSourceResponse> {
  if (actorId) {
    await assertTargetPermission(db, actorId, targetId, 'target:read')
    await assertTargetPermission(db, actorId, targetId, 'dataset:read')
  }
  const { datasets, datasetRows } = schemaFor(db)
  const [dataset] = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.id, input.datasetId), isNull(datasets.deletedAt)))
    .limit(1)

  if (!dataset) throw notFound('DATASET_NOT_FOUND', '数据集不存在或已被删除')
  if (dataset.targetId !== targetId) {
    throw conflict('DATASET_TARGET_MISMATCH', '所选数据集不属于当前目标系统，严禁跨目标系统配对')
  }

  const { mappingConfig } = input
  const sensitiveCheckSet = new Set(
    (mappingConfig.sensitiveFields ?? []).map((f) => f.toLowerCase().trim()),
  )

  // Verify whitelist does not violate sensitive exclusions
  for (const col of mappingConfig.fieldWhitelist) {
    const trimmed = col.trim().toLowerCase()
    if (sensitiveCheckSet.has(trimmed) || SENSITIVE_COLUMN_PATTERN.test(trimmed)) {
      throw badRequest('SENSITIVE_FIELD_VIOLATION', `白名单中包含了敏感阻断列 "${col}"`)
    }
  }

  const sampleRows = await db
    .select()
    .from(datasetRows)
    .where(eq(datasetRows.datasetId, input.datasetId))
    .orderBy(asc(datasetRows.rowIndex))
    .limit(10)

  const previewRows: PreviewRow[] = []
  const seenKeys = new Set<string>()
  const duplicateKeys: string[] = []
  let validCount = 0
  let rejectedCount = 0

  for (const r of sampleRows) {
    const rawData = (r.rowData ?? {}) as Record<string, unknown>
    const rawKey = rawData[mappingConfig.keyColumn]
    const recordKey = rawKey != null ? String(rawKey).trim() : null
    const rawName = rawData[mappingConfig.displayNameColumn]
    const displayName = rawName != null ? String(rawName).trim() : null
    const recordStatus = mappingConfig.statusColumn ? String(rawData[mappingConfig.statusColumn] ?? '').trim() : undefined

    const payload: Record<string, unknown> = {}
    for (const col of mappingConfig.fieldWhitelist) {
      payload[col] = rawData[col]
    }

    let isValid = true
    let rejectReason: string | undefined

    if (!recordKey) {
      isValid = false
      rejectReason = `主键列 "${mappingConfig.keyColumn}" 在此行为空`
    } else if (seenKeys.has(recordKey)) {
      isValid = false
      rejectReason = `主键 "${recordKey}" 在样本中出现重复`
      if (!duplicateKeys.includes(recordKey)) duplicateKeys.push(recordKey)
    } else {
      seenKeys.add(recordKey)
    }

    if (!displayName && isValid) {
      isValid = false
      rejectReason = `显示名称列 "${mappingConfig.displayNameColumn}" 在此行为空`
    }

    if (isValid) {
      validCount++
    } else {
      rejectedCount++
    }

    previewRows.push({
      rowIndex: r.rowIndex,
      recordKey,
      displayName,
      recordStatus,
      payload,
      isValid,
      rejectReason,
    })
  }

  return {
    previewRows,
    validationDigest: {
      sampleCount: sampleRows.length,
      sampleValidCount: validCount,
      sampleRejectedCount: rejectedCount,
      potentialDuplicateKeys: duplicateKeys.slice(0, 5),
    },
  }
}

export async function createBusinessSourceCandidate(
  db: Db,
  targetId: string,
  input: CreateBusinessSourceCandidateBody,
  actorId: string,
): Promise<{ sourceBindingId: string; candidateId: string; bindingRevision: number }> {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    await assertTargetPermission(tx, actorId, targetId, 'target:write')
    await assertTargetPermission(tx, actorId, targetId, 'dataset:write')

    const { datasets, targetBusinessSources, targetBusinessSourceSnapshots } = schemaFor(tx)
    const [dataset] = await tx
      .select()
      .from(datasets)
      .where(and(eq(datasets.id, input.datasetId), isNull(datasets.deletedAt)))
      .limit(1)

    if (!dataset) throw notFound('DATASET_NOT_FOUND', '数据集不存在或已被删除')
    if (dataset.targetId !== targetId) {
      throw conflict('DATASET_TARGET_MISMATCH', '所选数据集不属于当前目标系统，严禁跨目标系统配对')
    }

    const now = new Date()

    // Find or create binding
    let [source] = await tx
      .select()
      .from(targetBusinessSources)
      .where(and(eq(targetBusinessSources.targetId, targetId), eq(targetBusinessSources.entityType, input.entityType)))
      .limit(1)

    if (!source) {
      const newSourceId = newId()
      const [created] = await tx
        .insert(targetBusinessSources)
        .values({
          id: newSourceId,
          targetId,
          entityType: input.entityType,
          sourceKind: 'dataset_snapshot',
          currentSnapshotId: null,
          bindingRevision: 1,
          status: 'draft',
          ownerAccountId: actorId,
          declaredSourceAsOf: input.declaredSourceAsOf ? new Date(input.declaredSourceAsOf) : null,
          declarationBasis: input.declarationBasis ?? null,
          validUntil: input.validUntil ? new Date(input.validUntil) : null,
          completenessBasis: input.completenessBasis,
          completenessStatus: 'unknown',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      source = created!
    }

    // Insert candidate snapshot
    const candidateId = newId()
    await tx.insert(targetBusinessSourceSnapshots).values({
      id: candidateId,
      sourceBindingId: source.id,
      targetId,
      entityType: input.entityType,
      datasetId: input.datasetId,
      buildStatus: 'building',
      rulesVersion: 1,
      mappingConfig: input.mappingConfig,
      validationSummary: null,
      sourceObservedAt: input.sourceObservedAt ? new Date(input.sourceObservedAt) : null,
      fencingToken: 0,
      createdAt: now,
      updatedAt: now,
    })

    return {
      sourceBindingId: source.id,
      candidateId,
      bindingRevision: source.bindingRevision,
    }
  })
}

export async function getBusinessSourceCandidate(
  db: Db,
  targetId: string,
  candidateId: string,
  actorId?: string,
): Promise<TargetBusinessSourceSnapshotDto | null> {
  if (actorId) {
    await assertTargetPermission(db, actorId, targetId, 'target:read')
    await assertTargetPermission(db, actorId, targetId, 'dataset:read')
  }
  const { targetBusinessSourceSnapshots, datasets } = schemaFor(db)
  const [snapshot] = await db
    .select({
      snapshot: targetBusinessSourceSnapshots,
      datasetName: datasets.name,
    })
    .from(targetBusinessSourceSnapshots)
    .leftJoin(datasets, eq(targetBusinessSourceSnapshots.datasetId, datasets.id))
    .where(and(eq(targetBusinessSourceSnapshots.id, candidateId), eq(targetBusinessSourceSnapshots.targetId, targetId)))
    .limit(1)

  if (!snapshot) return null

  const row = snapshot.snapshot
  return {
    id: row.id,
    sourceBindingId: row.sourceBindingId,
    targetId: row.targetId,
    entityType: row.entityType,
    datasetId: row.datasetId,
    datasetName: snapshot.datasetName ?? undefined,
    buildStatus: row.buildStatus as TargetBusinessSourceSnapshotDto['buildStatus'],
    rulesVersion: row.rulesVersion,
    mappingConfig: row.mappingConfig,
    validationSummary: row.validationSummary,
    sourceObservedAt: row.sourceObservedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function approveBusinessSourceCandidate(
  db: Db,
  targetId: string,
  candidateId: string,
  input: ApproveCandidateBody,
  actorId: string,
): Promise<{ bindingRevision: number; currentSnapshotId: string }> {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    await assertTargetPermission(tx, actorId, targetId, 'target:write')
    await assertTargetPermission(tx, actorId, targetId, 'dataset:write')

    const { targetBusinessSources, targetBusinessSourceSnapshots, datasets } = schemaFor(tx)

    const [snapshot] = await tx
      .select()
      .from(targetBusinessSourceSnapshots)
      .where(and(eq(targetBusinessSourceSnapshots.id, candidateId), eq(targetBusinessSourceSnapshots.targetId, targetId)))
      .limit(1)

    if (!snapshot) throw notFound('CANDIDATE_NOT_FOUND', '待审批候选快照不存在')
    if (snapshot.buildStatus !== 'ready') {
      throw conflict('CANDIDATE_NOT_READY', `候选快照状态为 "${snapshot.buildStatus}"，仅 "ready" 状态的候选可获批准`)
    }

    const [source] = await tx
      .select()
      .from(targetBusinessSources)
      .where(eq(targetBusinessSources.id, snapshot.sourceBindingId))
      .limit(1)

    if (!source) throw notFound('SOURCE_BINDING_NOT_FOUND', '数据源绑定关系不存在')

    // CAS check on bindingRevision
    if (source.bindingRevision !== input.expectedRevision) {
      throw conflict(
        'SOURCE_REVISION_MISMATCH',
        `数据源修订版本不一致（当前：${source.bindingRevision}，预期：${input.expectedRevision}），已被其他操作更新`,
      )
    }

    // Verify dataset is still alive
    const [dataset] = await tx
      .select()
      .from(datasets)
      .where(and(eq(datasets.id, snapshot.datasetId), isNull(datasets.deletedAt)))
      .limit(1)

    if (!dataset) throw conflict('DATASET_DELETED', '源数据集已被删除，无法批准发布')

    const newRevision = source.bindingRevision + 1
    const now = new Date()

    await tx
      .update(targetBusinessSources)
      .set({
        currentSnapshotId: candidateId,
        bindingRevision: newRevision,
        status: 'active',
        approverAccountId: actorId,
        approvedAt: now,
        declarationBasis: input.approvalBasis,
        completenessStatus: 'complete',
        updatedAt: now,
      })
      .where(eq(targetBusinessSources.id, source.id))

    return {
      bindingRevision: newRevision,
      currentSnapshotId: candidateId,
    }
  })
}

export async function revokeBusinessSource(
  db: Db,
  targetId: string,
  entityType: string,
  input: RevokeSourceBody,
  actorId: string,
): Promise<{ bindingRevision: number }> {
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    await assertTargetPermission(tx, actorId, targetId, 'target:write')
    await assertTargetPermission(tx, actorId, targetId, 'dataset:write')

    const { targetBusinessSources } = schemaFor(tx)
    const [source] = await tx
      .select()
      .from(targetBusinessSources)
      .where(and(eq(targetBusinessSources.targetId, targetId), eq(targetBusinessSources.entityType, entityType)))
      .limit(1)

    if (!source) throw notFound('SOURCE_NOT_FOUND', '业务数据源绑定不存在')

    if (source.bindingRevision !== input.expectedRevision) {
      throw conflict(
        'SOURCE_REVISION_MISMATCH',
        `数据源修订版本不一致（当前：${source.bindingRevision}，预期：${input.expectedRevision}）`,
      )
    }

    const newRevision = source.bindingRevision + 1
    const now = new Date()

    await tx
      .update(targetBusinessSources)
      .set({
        status: 'revoked',
        currentSnapshotId: null,
        bindingRevision: newRevision,
        declarationBasis: input.revocationReason,
        updatedAt: now,
      })
      .where(eq(targetBusinessSources.id, source.id))

    return { bindingRevision: newRevision }
  })
}

export async function listBusinessRecords(
  db: Db,
  targetId: string,
  query: BusinessRecordsListQuery,
  actorId?: string,
): Promise<BusinessRecordsResponse> {
  if (actorId) {
    await assertTargetPermission(db, actorId, targetId, 'target:read')
    await assertTargetPermission(db, actorId, targetId, 'dataset:read')
  }

  const { targetBusinessSources, targetBusinessSourceSnapshots, targetBusinessRecords, datasets } = schemaFor(db)
  const [source] = await db
    .select()
    .from(targetBusinessSources)
    .where(and(eq(targetBusinessSources.targetId, targetId), eq(targetBusinessSources.entityType, query.entityType)))
    .limit(1)

  // Validate cursor if provided
  let cursorCondition: any
  if (query.cursor) {
    const decoded = decodeBusinessRecordCursor(query.cursor)
    if (!source || source.status !== 'active' || !source.currentSnapshotId || decoded.snapshotId !== source.currentSnapshotId) {
      throw conflict(BUSINESS_SOURCE_CURSOR_EXPIRED, '业务数据源快照已切换或失效，请重置游标重新获取', {
        currentSnapshotId: source?.currentSnapshotId ?? null,
        bindingRevision: source?.bindingRevision ?? 0,
      })
    }
    cursorCondition = gt(targetBusinessRecords.datasetRowIndex, decoded.rowIndex)
  }

  if (!source || source.status !== 'active' || !source.currentSnapshotId) {
    return {
      items: [],
      snapshotId: '',
      bindingRevision: source?.bindingRevision ?? 0,
      coverage: {
        status: 'unknown',
        completenessBasis: '当前目标系统尚未配置或批准该业务实体的生效数据源快照',
        observedAt: null,
        importedAt: '',
      },
    }
  }

  const now = new Date()
  if (source.validUntil && source.validUntil < now) {
    if (query.cursor) {
      throw conflict(BUSINESS_SOURCE_CURSOR_EXPIRED, '业务数据源快照已过期失效，请重置游标重新获取', {
        currentSnapshotId: source.currentSnapshotId,
        bindingRevision: source.bindingRevision,
      })
    }
    return {
      items: [],
      snapshotId: source.currentSnapshotId,
      bindingRevision: source.bindingRevision,
      coverage: {
        status: 'partial',
        completenessBasis: `数据源快照已于 ${source.validUntil.toISOString()} 过期失效`,
        observedAt: null,
        importedAt: source.createdAt.toISOString(),
      },
    }
  }

  const activeSnapshotId = source.currentSnapshotId

  const [snapshot] = await db
    .select({
      snapshot: targetBusinessSourceSnapshots,
      datasetCreatedAt: datasets.createdAt,
    })
    .from(targetBusinessSourceSnapshots)
    .leftJoin(datasets, eq(targetBusinessSourceSnapshots.datasetId, datasets.id))
    .where(eq(targetBusinessSourceSnapshots.id, activeSnapshotId))
    .limit(1)

  const limit = Math.min(query.limit ?? 50, 200)
  const conditions = [
    eq(targetBusinessRecords.snapshotId, activeSnapshotId),
    eq(targetBusinessRecords.targetId, targetId),
    eq(targetBusinessRecords.entityType, query.entityType),
  ]

  if (cursorCondition) conditions.push(cursorCondition)
  if (query.search) {
    const pattern = `%${query.search.trim()}%`
    conditions.push(or(ilike(targetBusinessRecords.displayName, pattern), ilike(targetBusinessRecords.recordKey, pattern))!)
  }

  const rows = await db
    .select()
    .from(targetBusinessRecords)
    .where(and(...conditions))
    .orderBy(asc(targetBusinessRecords.datasetRowIndex))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const last = page.at(-1)

  const items: BusinessRecordDto[] = page.map((r) => ({
    id: r.id,
    snapshotId: r.snapshotId,
    targetId: r.targetId,
    entityType: r.entityType,
    recordKey: r.recordKey,
    displayName: r.displayName,
    recordStatus: r.recordStatus,
    originalDatasetId: r.originalDatasetId,
    datasetRowId: r.datasetRowId,
    datasetRowIndex: r.datasetRowIndex,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
  }))

  const nextCursor = hasMore && last ? encodeBusinessRecordCursor(activeSnapshotId, last.datasetRowIndex, last.id) : undefined

  return {
    items,
    nextCursor,
    snapshotId: activeSnapshotId,
    bindingRevision: source.bindingRevision,
    coverage: {
      status: 'complete',
      completenessBasis: source.completenessBasis,
      observedAt: snapshot?.snapshot.sourceObservedAt?.toISOString() ?? null,
      importedAt: snapshot?.datasetCreatedAt?.toISOString() ?? snapshot?.snapshot.createdAt.toISOString() ?? '',
    },
  }
}

// ======================== Worker background operations ========================

export async function claimBusinessSourceBuildJob(
  db: Db,
  workerId: string,
  leaseDurationMs = 30_000,
): Promise<TargetBusinessSourceSnapshotDto | null> {
  return atomic(db, async (tx) => {
    const { targetBusinessSourceSnapshots } = schemaFor(tx)
    const now = new Date()
    const leaseExpires = new Date(now.getTime() + leaseDurationMs)

    const [candidate] = await tx
      .select()
      .from(targetBusinessSourceSnapshots)
      .where(
        and(
          eq(targetBusinessSourceSnapshots.buildStatus, 'building'),
          or(
            isNull(targetBusinessSourceSnapshots.leaseExpiresAt),
            lt(targetBusinessSourceSnapshots.leaseExpiresAt, now),
          ),
        ),
      )
      .orderBy(asc(targetBusinessSourceSnapshots.createdAt))
      .limit(1)

    if (!candidate) return null

    const newFencingToken = candidate.fencingToken + 1
    await tx
      .update(targetBusinessSourceSnapshots)
      .set({
        ownerWorkerId: workerId,
        leaseExpiresAt: leaseExpires,
        fencingToken: newFencingToken,
        updatedAt: now,
      })
      .where(
        and(
          eq(targetBusinessSourceSnapshots.id, candidate.id),
          eq(targetBusinessSourceSnapshots.fencingToken, candidate.fencingToken),
        ),
      )

    return {
      id: candidate.id,
      sourceBindingId: candidate.sourceBindingId,
      targetId: candidate.targetId,
      entityType: candidate.entityType,
      datasetId: candidate.datasetId,
      buildStatus: 'building',
      rulesVersion: candidate.rulesVersion,
      mappingConfig: candidate.mappingConfig,
      validationSummary: candidate.validationSummary,
      sourceObservedAt: candidate.sourceObservedAt?.toISOString() ?? null,
      createdAt: candidate.createdAt.toISOString(),
      updatedAt: now.toISOString(),
    }
  })
}

export async function commitBusinessSourceBatch(
  db: Db,
  candidateId: string,
  records: Array<{
    targetId: string
    entityType: string
    recordKey: string
    displayName: string
    recordStatus?: string
    originalDatasetId: string
    datasetRowId: string
    datasetRowIndex: number
    payload: Record<string, unknown>
  }>,
): Promise<void> {
  if (records.length === 0) return
  const { targetBusinessRecords } = schemaFor(db)
  const now = new Date()

  await db.insert(targetBusinessRecords).values(
    records.map((r) => ({
      id: newId(),
      snapshotId: candidateId,
      targetId: r.targetId,
      entityType: r.entityType,
      recordKey: r.recordKey,
      displayName: r.displayName,
      recordStatus: r.recordStatus ?? null,
      originalDatasetId: r.originalDatasetId,
      datasetRowId: r.datasetRowId,
      datasetRowIndex: r.datasetRowIndex,
      payload: r.payload,
      createdAt: now,
    })),
  )
}

export async function finishBusinessSourceBuild(
  db: Db,
  candidateId: string,
  outcome: {
    status: 'ready' | 'rejected' | 'failed'
    summary: ValidationSummary
  },
): Promise<void> {
  return atomic(db, async (tx) => {
    const { targetBusinessSourceSnapshots, targetBusinessRecords } = schemaFor(tx)
    const now = new Date()

    // If rejected or failed, wipe any partial records written for this candidate
    if (outcome.status === 'rejected' || outcome.status === 'failed') {
      await tx
        .delete(targetBusinessRecords)
        .where(eq(targetBusinessRecords.snapshotId, candidateId))
    }

    await tx
      .update(targetBusinessSourceSnapshots)
      .set({
        buildStatus: outcome.status,
        validationSummary: outcome.summary,
        ownerWorkerId: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(targetBusinessSourceSnapshots.id, candidateId))
  })
}

export async function cleanupBusinessSourceSnapshots(db: Db): Promise<{ cleaned: number }> {
  return atomic(db, async (tx) => {
    const { targetBusinessSources, targetBusinessSourceSnapshots, targetBusinessRecords, datasets } = schemaFor(tx)
    const now = new Date()

    // Find orphaned or superseded snapshots:
    // 1. Where dataset is soft-deleted
    // 2. Where source is revoked and updatedAt is older than 30 days
    const staleSnapshots = await tx
      .select({ id: targetBusinessSourceSnapshots.id })
      .from(targetBusinessSourceSnapshots)
      .leftJoin(datasets, eq(targetBusinessSourceSnapshots.datasetId, datasets.id))
      .leftJoin(targetBusinessSources, eq(targetBusinessSourceSnapshots.sourceBindingId, targetBusinessSources.id))
      .where(
        or(
          sql`${datasets.deletedAt} IS NOT NULL`,
          and(
            eq(targetBusinessSources.status, 'revoked'),
            sql`${targetBusinessSources.updatedAt} < ${new Date(now.getTime() - 30 * 86400000)}`,
          ),
        ),
      )
      .limit(100)

    if (staleSnapshots.length === 0) return { cleaned: 0 }

    const ids = staleSnapshots.map((s) => s.id)
    await tx.delete(targetBusinessRecords).where(inArray(targetBusinessRecords.snapshotId, ids))
    await tx.delete(targetBusinessSourceSnapshots).where(inArray(targetBusinessSourceSnapshots.id, ids))

    return { cleaned: ids.length }
  })
}
