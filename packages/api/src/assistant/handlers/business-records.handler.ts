import {
  type AssistantDiscoveryCandidate,
  type AssistantDiscoveryResult,
} from '@cairn/shared'
import { assertTargetPermission, listBusinessRecords, DomainError } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { requireVisibleTarget } from './common.js'

export async function handleTargetBusinessRecordsList(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantDiscoveryResult> {
  const { actor, slots, db, targets, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索目标系统业务记录...')

  const targetId = typeof slots.targetId === 'string' && slots.targetId ? slots.targetId : undefined
  if (!targetId) {
    throw new Error('targetId is required to list business records')
  }

  await requireVisibleTarget(actor, targetId, targets, db)
  await assertTargetPermission(db, actor.id, targetId, 'dataset:read')

  let targetName = targetId.slice(0, 8)
  try {
    const t = await targets.getTarget(targetId)
    targetName = t.name
  } catch {
    // fallback
  }

  const entityType = typeof slots.entityType === 'string' && slots.entityType ? slots.entityType : 'manufacturer'
  const filter = typeof slots.filter === 'string' ? slots.filter : undefined
  const cursor = typeof slots.cursor === 'string' ? slots.cursor : undefined
  const limit = typeof slots.limit === 'number' && slots.limit > 0 && slots.limit <= 50 ? slots.limit : 20

  let recordsResult
  try {
    recordsResult = await listBusinessRecords(
      db,
      targetId,
      {
        entityType,
        search: filter,
        cursor,
        limit,
      },
      actor.id,
    )
  } catch (error) {
    if (error instanceof DomainError && error.code === 'BUSINESS_SOURCE_NOT_FOUND') {
      return {
        kind: 'discovery',
        candidates: [],
        scope: {
          targetId,
          targetName,
          entityType,
          filter,
        },
        coverage: {
          totalVisible: 0,
          hasMore: false,
          observedAt: new Date().toISOString(),
        },
        message: `目标系统「${targetName}」暂未配置或启用「${entityType}」业务数据快照来源。如需使用，请前往【目标配置 - 数据集】导入业务快照，或通过录制流程采集。`,
      }
    }
    throw error
  }

  if (!recordsResult.snapshotId || recordsResult.coverage.status === 'unknown') {
    return {
      kind: 'discovery',
      candidates: [],
      scope: {
        targetId,
        targetName,
        entityType,
        filter,
      },
      coverage: {
        totalVisible: 0,
        hasMore: false,
        observedAt: new Date().toISOString(),
      },
      message: `目标系统「${targetName}」暂未配置或启用「${entityType}」业务数据快照来源。如需使用，请前往【目标配置 - 数据集】导入业务快照，或通过录制流程采集。`,
    }
  }

  const candidates: AssistantDiscoveryCandidate[] = recordsResult.items.map((record) => ({
    id: record.id,
    name: record.displayName,
    targetId,
    targetName,
    kind: record.entityType,
    status: (record.recordStatus as any) ?? 'active',
    updatedAt: record.createdAt,
  }))

  const message =
    candidates.length === 0
      ? `在目标系统「${targetName}」下未找到匹配的「${entityType}」业务记录。`
      : `在目标系统「${targetName}」下检索到 ${candidates.length} 条「${entityType}」业务记录（覆盖依据：${recordsResult.coverage.completenessBasis}）：`

  return {
    kind: 'discovery',
    candidates,
    scope: {
      targetId,
      targetName,
      entityType,
      filter,
    },
    coverage: {
      totalVisible: candidates.length,
      hasMore: Boolean(recordsResult.nextCursor),
      nextCursor: recordsResult.nextCursor,
      observedAt: recordsResult.coverage.observedAt || recordsResult.coverage.importedAt || new Date().toISOString(),
    },
    message,
  }
}

