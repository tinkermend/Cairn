import { and, asc, count, desc, eq, isNull } from 'drizzle-orm'
import type {
  AutoMapResult,
  CreateDatasetBody,
  DataBinding,
  DatasetColumn,
  DatasetDetail,
  DatasetRowDto,
  DatasetRowValidStatus,
  DatasetSourceType,
  JsonValue,
  PreflightIssue,
  PreflightResult,
  ScenarioInputDecl,
} from '@cairn/shared'
import type { Db } from '../client.js'
import { assertTargetPermission, lockConsoleAuthorization, scopedTargetFilter } from '../console/target-authorization.js'
import { newId } from '../id.js'
import { atomic, schemaFor } from '../native.js'
import { badRequest, notFound } from '../runs/errors.js'

export function autoMapDataset(
  columns: DatasetColumn[],
  scenarioInputs: ScenarioInputDecl[],
): AutoMapResult {
  const binding: DataBinding = {}
  const colByName = new Map<string, DatasetColumn>()
  for (const c of columns) {
    colByName.set(c.name.toLowerCase().trim(), c)
    colByName.set(c.key.toLowerCase().trim(), c)
  }

  for (const input of scenarioInputs) {
    const keyMatch = colByName.get(input.key.toLowerCase().trim())
    const labelMatch = input.label ? colByName.get(input.label.toLowerCase().trim()) : undefined
    const match = keyMatch ?? labelMatch
    if (match) {
      binding[input.key] = { source: 'column', columnName: match.name }
    } else if (input.defaultGenerator) {
      binding[input.key] = { source: 'generator', spec: input.defaultGenerator }
    }
  }

  return { binding }
}

export function preflightDataset(
  rows: Record<string, JsonValue>[],
  binding: DataBinding,
  scenarioInputs: ScenarioInputDecl[],
): PreflightResult {
  const issues: PreflightIssue[] = []
  let validCount = 0
  let warningCount = 0
  let errorCount = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    let rowHasError = false
    let rowHasWarning = false

    for (const input of scenarioInputs) {
      const b = binding[input.key]
      let val: JsonValue | undefined

      if (!b) {
        if (input.defaultGenerator) {
          continue
        } else if (input.required) {
          issues.push({
            rowIndex: i,
            fieldKey: input.key,
            severity: 'error',
            message: `必填参数 "${input.label || input.key}" 未绑定数据源`,
          })
          rowHasError = true
        }
        continue
      }

      if (b.source === 'fixed') {
        val = b.value
      } else if (b.source === 'column') {
        val = row[b.columnName]
      } else if (b.source === 'generator') {
        continue
      }

      const isEmpty = val === undefined || val === null || val === ''
      if (input.required && isEmpty) {
        issues.push({
          rowIndex: i,
          fieldKey: input.key,
          severity: 'error',
          message: `必填参数 "${input.label || input.key}" 在当前行数据为空`,
        })
        rowHasError = true
        continue
      }

      if (!isEmpty && input.type) {
        if (input.type === 'number') {
          const num = Number(val)
          if (isNaN(num)) {
            issues.push({
              rowIndex: i,
              fieldKey: input.key,
              severity: 'error',
              message: `参数 "${input.label || input.key}" 要求数值类型，但实际值为 "${val}"`,
            })
            rowHasError = true
          }
        } else if (input.type === 'boolean') {
          if (
            typeof val !== 'boolean' &&
            val !== 'true' &&
            val !== 'false' &&
            val !== 1 &&
            val !== 0
          ) {
            issues.push({
              rowIndex: i,
              fieldKey: input.key,
              severity: 'error',
              message: `参数 "${input.label || input.key}" 要求布尔类型，但实际值为 "${val}"`,
            })
            rowHasError = true
          }
        }
      }
    }

    if (rowHasError) {
      errorCount++
    } else if (rowHasWarning) {
      warningCount++
    } else {
      validCount++
    }
  }

  return {
    totalRows: rows.length,
    validCount,
    warningCount,
    errorCount,
    issues,
  }
}

export async function createDataset(
  db: Db,
  input: CreateDatasetBody,
  actorId: string,
): Promise<DatasetDetail> {
  if (!input.targetId) throw badRequest('DATASET_TARGET_REQUIRED', '数据集必须关联目标系统')
  return atomic(db, async (tx) => {
    await lockConsoleAuthorization(tx, actorId)
    await assertTargetPermission(tx, actorId, input.targetId, 'dataset:write')
    const { targets, datasets, datasetRows } = schemaFor(tx)
    const [target] = await tx
      .select({ id: targets.id })
      .from(targets)
      .where(and(eq(targets.id, input.targetId), isNull(targets.deletedAt)))
      .limit(1)
    if (!target) throw notFound('TARGET_NOT_FOUND', '目标系统不存在')

    const id = newId()
    const now = new Date()

    const [created] = await tx
      .insert(datasets)
      .values({
        id,
        name: input.name,
        targetId: input.targetId,
        sourceType: input.sourceType,
        sourceFilename: input.sourceFilename,
        selectedSheet: input.selectedSheet ?? null,
        rowCount: input.rows.length,
        columnsMeta: input.columns,
        createdByAccountId: actorId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    const chunkSize = 200
    for (let i = 0; i < input.rows.length; i += chunkSize) {
      const chunk = input.rows.slice(i, i + chunkSize)
      await tx.insert(datasetRows).values(
        chunk.map((row, idx) => ({
          id: newId(),
          datasetId: id,
          rowIndex: i + idx,
          rowData: row,
          validStatus: 'valid' as const,
          createdAt: now,
        })),
      )
    }

    return {
      id: created!.id,
      name: created!.name,
      targetId: created!.targetId,
      sourceType: created!.sourceType as DatasetSourceType,
      sourceFilename: created!.sourceFilename,
      selectedSheet: created!.selectedSheet,
      rowCount: created!.rowCount,
      columns: created!.columnsMeta,
      createdByAccountId: created!.createdByAccountId!,
      createdAt: created!.createdAt.toISOString(),
      updatedAt: created!.updatedAt.toISOString(),
    }
  })
}

export async function getDataset(db: Db, datasetId: string, actorId?: string): Promise<DatasetDetail | null> {
  const { datasets } = schemaFor(db)
  const [row] = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.id, datasetId), isNull(datasets.deletedAt)))
    .limit(1)
  if (!row) return null
  if (actorId) await assertTargetPermission(db, actorId, row.targetId, 'dataset:read')
  return {
    id: row.id,
    name: row.name,
    targetId: row.targetId,
    sourceType: row.sourceType as DatasetSourceType,
    sourceFilename: row.sourceFilename,
    selectedSheet: row.selectedSheet,
    rowCount: row.rowCount,
    columns: row.columnsMeta,
    createdByAccountId: row.createdByAccountId ?? 'system',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export async function listDatasets(
  db: Db,
  query: { targetId?: string; limit?: number; cursor?: string; search?: string },
  actorId?: string,
): Promise<{ items: DatasetDetail[]; nextCursor?: string }> {
  const { datasets } = schemaFor(db)
  const limit = Math.min(query.limit ?? 20, 100)
  const scope = await scopedTargetFilter(db, actorId, datasets.targetId, 'dataset:read')
  const conditions = [isNull(datasets.deletedAt)]
  if (scope) conditions.push(scope)
  if (query.targetId) {
    conditions.push(eq(datasets.targetId, query.targetId))
  }

  const rows = await db
    .select()
    .from(datasets)
    .where(and(...conditions))
    .orderBy(desc(datasets.createdAt), desc(datasets.id))
    .limit(limit + 1)

  const hasMore = rows.length > limit
  const items = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
    id: r.id,
    name: r.name,
    targetId: r.targetId,
    sourceType: r.sourceType as DatasetSourceType,
    sourceFilename: r.sourceFilename,
    selectedSheet: r.selectedSheet,
    rowCount: r.rowCount,
    columns: r.columnsMeta,
    createdByAccountId: r.createdByAccountId ?? 'system',
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))

  return {
    items,
    nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
  }
}

export async function getDatasetRows(
  db: Db,
  datasetId: string,
  options?: { limit?: number; offset?: number },
  actorId?: string,
): Promise<{ items: DatasetRowDto[]; total: number }> {
  if (actorId) {
    const dataset = await getDataset(db, datasetId, actorId)
    if (!dataset) throw notFound('DATASET_NOT_FOUND', '数据集不存在')
  }
  const { datasetRows } = schemaFor(db)
  const limit = Math.min(options?.limit ?? 50, 200)
  const offset = options?.offset ?? 0

  const [totalRes] = await db
    .select({ total: count() })
    .from(datasetRows)
    .where(eq(datasetRows.datasetId, datasetId))

  const rows = await db
    .select()
    .from(datasetRows)
    .where(eq(datasetRows.datasetId, datasetId))
    .orderBy(asc(datasetRows.rowIndex))
    .limit(limit)
    .offset(offset)

  return {
    items: rows.map((r) => ({
      id: r.id,
      datasetId: r.datasetId,
      rowIndex: r.rowIndex,
      rowData: r.rowData,
      validStatus: r.validStatus as DatasetRowValidStatus,
    })),
    total: Number(totalRes?.total ?? 0),
  }
}

export async function softDeleteDataset(
  db: Db,
  datasetId: string,
  actorId: string,
): Promise<void> {
  return atomic(db, async (tx) => {
    const { datasets } = schemaFor(tx)
    const [row] = await tx
      .select({ id: datasets.id, targetId: datasets.targetId })
      .from(datasets)
      .where(and(eq(datasets.id, datasetId), isNull(datasets.deletedAt)))
      .limit(1)
    if (!row) throw notFound('DATASET_NOT_FOUND', '数据集不存在')
    await lockConsoleAuthorization(tx, actorId)
    await assertTargetPermission(tx, actorId, row.targetId, 'dataset:delete')
    await tx
      .update(datasets)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(datasets.id, datasetId))
  })
}
