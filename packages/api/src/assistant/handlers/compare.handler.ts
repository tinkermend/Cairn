import {
  type AssistantResult,
} from '@cairn/shared'
import { DomainError, encodeCursor, getRun, listRuns } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry'
import { assembleRunCompareContext } from '../context-assembler'
import { requireVisibleTarget } from './common'

export async function handleRunCompare(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantResult> {
  const { actor, slots, db, targets, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索基准与对比运行事实...')

  let baseRunId = String(slots.baseRunId ?? '')
  let targetRunId = String(slots.compareRunId ?? slots.targetRunId ?? '')
  const comparePrevious = slots.comparePrevious === true

  if (!baseRunId || (!targetRunId && !comparePrevious)) {
    throw new DomainError('bad_request', 'MISSING_SLOT', '缺少必需参数 baseRunId 或 compareRunId')
  }

  if (comparePrevious) {
    // A relative comparison is scoped to the current, authorized Run. The
    // keyset cursor excludes that Run and every newer Run, including ties.
    const current = await getRun(db, baseRunId, actor.id)
    await requireVisibleTarget(actor, current.targetId, targets, db)
    let prior
    try {
      prior = await listRuns(db, {
        scenarioId: current.scenarioId,
        targetId: current.targetId,
        cursor: encodeCursor(new Date(current.createdAt), current.id),
        limit: 1,
      }, actor.id)
    } catch {
      return {
        kind: 'unsupported',
        reasonCode: 'RUN_HISTORY_UNAVAILABLE',
        message: '暂时无法读取该场景的历史运行，请稍后重试或手动选择另一条运行。',
      }
    }
    const previous = prior.items[0]
    if (!previous) {
      return {
        kind: 'clarify',
        missingFields: ['targetRunId'],
        question: '当前运行之前没有可访问的同场景、同目标系统运行。请选择另一条运行进行对比。',
      }
    }
    baseRunId = previous.id
    targetRunId = current.id
  }

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
    summary: comparePrevious ? `上一次与本次运行对比：${pack.summary}` : pack.summary,
    comparability: pack.comparability,
    differences: pack.differences,
    facts: pack.facts,
    missingInformation: pack.missingInformation,
    nextActions: pack.nextActions,
  }
}
