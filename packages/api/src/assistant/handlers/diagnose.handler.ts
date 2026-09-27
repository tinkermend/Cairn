import {
  type AssistantDiagnosis,
  type AssistantNextAction,
  citationKey,
  hasAllPermissions,
  quoteStepFocusId,
  quoteTargetSystemId,
  quotedStepIdOnRun,
} from '@cairn/shared'
import { DomainError } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry'
import { assembleDiagnoseContext, validateGrounding } from '../context-assembler'
import { generateDiagnosisHypotheses } from '../model-session'
import { requireVisibleTarget } from './common'

export async function handleRunDiagnose(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantDiagnosis> {
  const { actor, slots, body, session, db, targets, signal, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索运行事实与证据轴...')

  let runId = String(slots.runId ?? body.pageContext?.runId ?? '')
  if (!runId && (slots.findRecentFailed || /最近失败|最近一次失败/.test(body.question))) {
    const { listRuns } = await import('@cairn/db')
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const runsList = await listRuns(
      db,
      {
        from: sevenDaysAgo,
        limit: 20,
      },
      actor.id,
    ).catch(() => ({ items: [] }))

    const failedRun = runsList.items.find((r) => r.status === 'FAILED')
    if (failedRun) {
      runId = failedRun.id
    } else {
      return {
        kind: 'diagnosis',
        observedAt: new Date().toISOString(),
        eventSeq: 1,
        focus: 'failure',
        facts: [
          {
            id: 'fact-recent-failed',
            text: '近 7 天内当前可见范围内未发现处于 FAILED、TIMED_OUT 或 ERROR 的失败运行（已排除用户主动取消的运行）',
            citations: [],
          },
        ],
        hypotheses: [],
        missingInformation: ['近 7 天内无异常运行记录'],
        missingReasons: [],
        nextActions: [
          {
            kind: 'run.detail',
            label: '前往运行列表查看全部历史',
            href: '/runs',
            citations: [],
          },
        ],
      }
    }
  }

  if (!runId) {
    throw new DomainError('bad_request', 'MISSING_SLOT', '缺少必需参数 runId')
  }

  const { getRun } = await import('@cairn/db')
  const run = await getRun(db, runId, actor.id).catch(() => null)
  if (!run) {
    throw new DomainError('not_found', 'RUN_NOT_FOUND', '运行不存在')
  }
  await requireVisibleTarget(actor, run.targetId, targets, db)

  let quote = body.pageContext?.quote
  let quotedStepId: string | undefined
  if (quote) {
    const quoteRef = quote.objectRef
    const quoteTargetId = quoteTargetSystemId(quote)
    if (quoteTargetId && quoteTargetId !== run.targetId) {
      quote = undefined
    } else if (quoteRef?.kind === 'run' && quoteRef.id !== runId) {
      quote = undefined
    } else if (quoteRef?.kind === 'scenario' && quoteRef.id !== run.scenarioId) {
      quote = undefined
    } else {
      const focusId = quoteStepFocusId(quote)
      if (focusId) {
        quotedStepId = quotedStepIdOnRun(quote, run.stepRuns)
        if (!quotedStepId) quote = undefined
      }
    }
  }

  const { observation, pack } = await assembleDiagnoseContext(db, runId, {
    stepId:
      quotedStepId ??
      (typeof slots.stepId === 'string' ? slots.stepId : body.pageContext?.stepId),
    focus: typeof slots.focus === 'string' ? slots.focus : 'overview',
    quote,
  }, actor.id)

  const nextActions: AssistantNextAction[] = [...pack.nextActions]
  if (hasAllPermissions(actor.permissions, ['target:read'])) {
    nextActions.push({
      kind: 'target.accounts',
      label: '查看目标账号',
      href: `/targets/${observation.run.targetId}`,
      citations: [citationKey('run', observation.run.id)],
    })
  }
  if (hasAllPermissions(actor.permissions, ['workflow:read'])) {
    nextActions.push({
      kind: 'studio.step',
      label: '打开场景工作区',
      href: `/scenarios/${observation.run.scenarioId}`,
      citations: [citationKey('run', observation.run.id)],
    })
  }

  const missingInformation = [...pack.missingInformation]
  let hypotheses: AssistantDiagnosis['hypotheses'] = []

  if (session) {
    await onProgress?.('generating', '大模型正在分析根因假设...')
    const generated = await generateDiagnosisHypotheses(
      session,
      body.question,
      pack.text,
      pack.citations,
      signal,
    )

    await onProgress?.('validating', '正在验证假设事实引用与可信度...')
    const { valid, invalid } = validateGrounding(generated.hypotheses, pack.citations)
    hypotheses = valid

    if (generated.error) {
      missingInformation.push('模型未能提出经引用校验的可能原因')
    } else if (hypotheses.length === 0 && invalid.length > 0) {
      missingInformation.push('模型生成的根因假设未通过事实引用校验')
    } else if (hypotheses.length === 0) {
      missingInformation.push('模型没有给出可引用的可能原因')
    }
  }

  return {
    kind: 'diagnosis',
    observedAt: new Date().toISOString(),
    eventSeq: observation.eventSeq,
    focus: pack.focus,
    facts: pack.facts,
    hypotheses,
    missingInformation,
    missingReasons: pack.missingReasons,
    nextActions,
  }
}
