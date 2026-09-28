import {
  type AssistantDiscoveryCandidate,
  type AssistantDiscoveryResult,
  cleanAssistantQuestion,
  inferBusinessRecordEntityType,
  normalizeAssistantPageContext,
} from '@cairn/shared'
import { assertTargetPermission, listBusinessRecords, DomainError } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry.js'
import { requireVisibleTarget } from './common.js'

function businessEntityLabel(entityType: string): string {
  if (entityType === 'manufacturer') return '厂家／制造商'
  if (entityType === 'supplier') return '供应商'
  return entityType
}

function namedTargetInBusinessQuestion(question: string): string | undefined {
  const cleaned = cleanAssistantQuestion(question)
  const match = /(?:列出|查询|查看|查找|检索|查一下|查下|找出|看下)\s*([^，。？?！!]{2,100}?)\s*的(?:所有|全部|现有)?(?:厂家|制造商|供应商)(?:名单|列表|记录)?/.exec(cleaned)
    ?? /^(?:请问|我想知道)?\s*([^，。？?！!]{2,100}?)\s*(?:里|下面|中)?有哪些(?:厂家|制造商|供应商)/.exec(cleaned)
  const name = match?.[1]?.trim()
  // "现在都有哪些厂家" asks for a list; "现在都" is not a target name.
  return name && !/^(?:这个|当前|该|本)/.test(name) &&
    !/^(?:现在|目前|此刻|今天|最近)(?:都|一共)?$/.test(name) ? name : undefined
}

export async function handleTargetBusinessRecordsList(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantDiscoveryResult> {
  const { actor, slots, db, targets, onProgress, question, body } = ctx
  await onProgress?.('loading_facts', '正在检索目标系统业务记录...')

  const pageTargetId = normalizeAssistantPageContext(body.pageContext)?.targetId
  const refersToCurrentTarget = /(?:这个|当前|该|本)(?:目标系统|目标|系统|平台)/.test(question)
  const slotTargetId = typeof slots.targetId === 'string' && slots.targetId ? slots.targetId : undefined
  const namedTarget = namedTargetInBusinessQuestion(question)
  let targetId: string | undefined
  if (namedTarget) {
    const matches: { id: string; name: string }[] = []
    let cursor: string | undefined
    do {
      const page = await targets.listTargets({ search: namedTarget, cursor, limit: 100 }, actor)
      matches.push(...page.items.filter((item) => item.name.toLocaleLowerCase() === namedTarget.toLocaleLowerCase()))
      cursor = page.nextCursor ?? undefined
    } while (cursor && matches.length < 2)
    if (matches.length !== 1) {
      delete slots.targetId
      delete slots.cursor
      delete slots.filter
      return {
        kind: 'discovery',
        candidates: [],
        scope: {},
        coverage: { totalVisible: 0, hasMore: false, observedAt: new Date().toISOString() },
        message: matches.length > 1
          ? '当前权限范围内有多个同名目标，请先打开要查询的目标详情页。'
          : '当前权限范围内没有匹配的目标，请核对名称或打开目标详情页。',
      }
    }
    targetId = matches[0]!.id
  } else {
    targetId = refersToCurrentTarget ? pageTargetId : (pageTargetId ?? slotTargetId)
  }
  if (!targetId) {
    delete slots.targetId
    delete slots.cursor
    delete slots.filter
    return {
      kind: 'discovery',
      candidates: [],
      scope: {},
      coverage: { totalVisible: 0, hasMore: false, observedAt: new Date().toISOString() },
      message: '当前没有选定具体目标系统。请先打开目标详情页，或明确告诉我要查询的目标。',
    }
  }
  if (slotTargetId !== targetId) {
    delete slots.cursor
    delete slots.filter
    slots.targetId = targetId
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

  // The Supervisor can provide a slot, but it cannot change an entity the
  // user named explicitly (for example, supplier -> manufacturer).
  const requestedEntityType = inferBusinessRecordEntityType(question)
  const modelEntityType = typeof slots.entityType === 'string' && slots.entityType ? slots.entityType : undefined
  const entityType = requestedEntityType && requestedEntityType !== 'ambiguous'
    ? requestedEntityType
    : modelEntityType
  if (requestedEntityType === 'ambiguous' || !entityType) {
    return {
      kind: 'discovery',
      candidates: [],
      scope: { targetId, targetName },
      coverage: { totalVisible: 0, hasMore: false, observedAt: new Date().toISOString() },
      message: '请明确要查厂家／制造商，还是供应商业务记录。',
    }
  }
  const entityLabel = businessEntityLabel(entityType)
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
        message: `目标系统「${targetName}」尚无已批准且生效的「${entityLabel}」业务数据快照来源。请前往【目标配置 - 数据集】导入、绑定并批准业务快照。`,
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
      message: `目标系统「${targetName}」尚无已批准且生效的「${entityLabel}」业务数据快照来源。请前往【目标配置 - 数据集】导入、绑定并批准业务快照。`,
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

  const sourceDetails = [
    recordsResult.coverage.sourceName
      ? `来源数据集「${recordsResult.coverage.sourceName}」`
      : `来源快照 ${recordsResult.snapshotId.slice(0, 8)}`,
    `覆盖依据：${recordsResult.coverage.completenessBasis}`,
    recordsResult.coverage.observedAt
      ? `源数据采集时间：${recordsResult.coverage.observedAt}`
      : recordsResult.coverage.importedAt
        ? `源数据采集时间未记录；数据集导入时间：${recordsResult.coverage.importedAt}`
        : '源数据采集与导入时间均未记录',
  ].join('；')
  const message =
    candidates.length === 0
      ? `在目标系统「${targetName}」下未找到匹配的「${entityLabel}」业务记录（${sourceDetails}）。`
      : `在目标系统「${targetName}」下检索到 ${candidates.length} 条「${entityLabel}」业务记录（${sourceDetails}）：`

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
