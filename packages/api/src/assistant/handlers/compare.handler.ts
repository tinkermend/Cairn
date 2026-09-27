import {
  type AssistantCompare,
} from '@cairn/shared'
import { DomainError } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry'
import { assembleRunCompareContext } from '../context-assembler'
import { requireVisibleTarget } from './common'

export async function handleRunCompare(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantCompare> {
  const { actor, slots, db, targets, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索基准与对比运行事实...')

  const baseRunId = String(slots.baseRunId ?? '')
  const targetRunId = String(slots.compareRunId ?? slots.targetRunId ?? '')

  if (!baseRunId || !targetRunId) {
    throw new DomainError('bad_request', 'MISSING_SLOT', '缺少必需参数 baseRunId 或 compareRunId')
  }

  const { getRun } = await import('@cairn/db')
  const [baseRun, targetRun] = await Promise.all([
    getRun(db, baseRunId, actor.id).catch(() => null),
    getRun(db, targetRunId, actor.id).catch(() => null),
  ])

  if (!baseRun) {
    throw new DomainError('not_found', 'RUN_NOT_FOUND', `基准运行不存在: ${baseRunId}`)
  }
  if (!targetRun) {
    throw new DomainError('not_found', 'RUN_NOT_FOUND', '未能获取对比运行的数据，无法完成对比')
  }

  try {
    await requireVisibleTarget(actor, baseRun.targetId, targets, db)
  } catch {
    throw new DomainError('forbidden', 'TARGET_FORBIDDEN', '未能获取第一侧运行的有效授权数据，无法完成对比')
  }

  try {
    await requireVisibleTarget(actor, targetRun.targetId, targets, db)
  } catch {
    throw new DomainError('forbidden', 'TARGET_FORBIDDEN', '未能获取第二侧运行的有效授权数据，无法完成对比')
  }

  const { pack } = await assembleRunCompareContext(
    db,
    baseRunId,
    targetRunId,
    actor.id,
  )

  return {
    kind: 'compare',
    baseRunId,
    targetRunId,
    summary: pack.summary,
    comparability: pack.comparability,
    differences: pack.differences,
    facts: pack.facts,
    missingInformation: pack.missingInformation,
    nextActions: pack.nextActions,
  }
}
