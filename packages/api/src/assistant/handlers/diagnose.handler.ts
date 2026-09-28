import {
  type AssistantDiagnosis,
  type AssistantFact,
  type AssistantNextAction,
  citationKey,
  hasAllPermissions,
  readScreenshotPayload,
  SCREENSHOT_ROLE_LABELS,
  quoteStepFocusId,
  quoteTargetSystemId,
  quotedStepIdOnRun,
} from '@cairn/shared'
import { DomainError } from '@cairn/db'
import type { AssistantCapabilityHandlerContext } from '../registry'
import { assembleDiagnoseContext, hasSpecificDiagnosisFailureEvidence } from '../context-assembler'
import { requireVisibleTarget } from './common'

export async function handleRunDiagnose(
  ctx: AssistantCapabilityHandlerContext,
): Promise<AssistantDiagnosis> {
  const { actor, slots, body, db, targets, onProgress } = ctx
  await onProgress?.('loading_facts', '正在检索运行事实与证据轴...')

  let runId = String(slots.runId ?? body.pageContext?.runId ?? '')
  let recentFailureWindow: { from: string; to: string } | null = null
  if (!runId && (slots.findRecentFailed || /最近失败|最近一次失败/.test(body.question))) {
    const { listRuns } = await import('@cairn/db')
    const observedAt = new Date()
    const sevenDaysAgo = new Date(observedAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
    let runsList: Awaited<ReturnType<typeof listRuns>>
    try {
      // Filter in storage before pagination. A failed run may be older than the
      // first page of successful runs and must not be reported as absent.
      runsList = await listRuns(db, {
        from: sevenDaysAgo,
        status: 'FAILED',
        targetId: body.pageContext?.targetId,
        limit: 1,
      }, actor.id)
    } catch {
      throw new DomainError('unavailable', 'RUN_LIST_UNAVAILABLE', '暂时无法读取运行记录，不能判断最近 7 天是否有失败运行')
    }

    const failedRun = runsList.items[0]
    if (failedRun) {
      runId = failedRun.id
      recentFailureWindow = { from: sevenDaysAgo, to: observedAt.toISOString() }
    } else {
      return {
        kind: 'diagnosis',
        observedAt: observedAt.toISOString(),
        eventSeq: 1,
        focus: 'failure',
        facts: [
          {
            id: 'fact-recent-failed',
            text: '近 7 天内当前可见的业务运行中未发现状态为 FAILED 的记录（不含地图作业；不代表业务结果断言全部通过）',
            citations: [],
          },
        ],
        hypotheses: [],
        missingInformation: [],
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

  // The actor-scoped Run observation exposes ExecutionError.safeMessage to the
  // console. Use only that display-safe field; never project error.cause,
  // attempt output, or page content into assistant facts.
  const failureMessageByFactId = new Map<string, string>()
  for (const step of observation.run.stepRuns) {
    const error = step.attempts.at(-1)?.error
    if (error?.safeMessage) {
      const displayMessage = error.safeMessage.replace(/\s+/g, ' ').trim()
      if (displayMessage && displayMessage !== error.code) {
        failureMessageByFactId.set(`step-${step.id}-error`, displayMessage)
      }
    }
  }
  const facts: AssistantFact[] = pack.facts.map((fact) => {
    const displayMessage = failureMessageByFactId.get(fact.id)
    if (displayMessage) {
      const prefix = `${fact.text} 说明：`
      return { ...fact, text: prefix + displayMessage.slice(0, Math.max(0, 1024 - prefix.length)) }
    }
    if (fact.id === 'status' && observation.run.status === 'NEEDS_REVIEW') {
      return { ...fact, text: `${fact.text} 需先人工核查实际页面结果；未知副作用不能直接重跑。` }
    }
    return fact
  })

  const nextActions: AssistantNextAction[] = [...pack.nextActions]
  const firstFailedStep = observation.run.stepRuns.find((step) =>
    step.status === 'FAILED' || Boolean(step.attempts.at(-1)?.error))
  if (firstFailedStep) {
    const evidenceAction = nextActions.find((item) => item.kind === 'run.evidence')
    if (evidenceAction) {
      evidenceAction.label = observation.run.status === 'NEEDS_REVIEW'
        ? `核查「${firstFailedStep.name.slice(0, 18)}」操作后的实际状态`
        : `先核对「${firstFailedStep.name.slice(0, 20)}」失败现场证据`
      evidenceAction.href = `/runs/${observation.run.id}?stepRunId=${encodeURIComponent(firstFailedStep.id)}`
    }
  }
  if (observation.run.status === 'NEEDS_REVIEW') {
    const reviewAction = nextActions.find((item) => item.kind === 'run.review') ?? {
      kind: 'run.review' as const,
      label: '先人工核查运行结果',
      href: `/runs/${observation.run.id}`,
      citations: [citationKey('run', observation.run.id)],
    }
    const index = nextActions.findIndex((item) => item.kind === 'run.review')
    if (index >= 0) nextActions.splice(index, 1)
    nextActions.unshift(reviewAction)
  }
  const accountEvidence = observation.run.status === 'WAITING_FOR_AUTH' ||
    observation.run.placement?.state === 'session_not_ready' ||
    observation.run.placement?.state === 'session_lost' ||
    observation.run.stepRuns.some((step) => step.attempts.some((attempt) =>
      /^(?:AUTH_|RUN_ACCOUNT_|SESSION_)/.test(attempt.error?.code ?? '')))
  if (accountEvidence && hasAllPermissions(actor.permissions, ['target:read'])) {
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
  const recordedScreenshot = observation.evidence.items.some((item) =>
    item.type === 'screenshot' && item.status === 'available')
  // The capture pipeline records a conservative quality signal without
  // sending image pixels to the assistant. Surface only a flagged signal from
  // an authorized evidence item; never treat it as a visual root cause.
  const flaggedScreenshot = observation.evidence.items
    .filter((item) => item.type === 'screenshot' && item.status === 'available')
    .map((item) => ({ item, payload: readScreenshotPayload(item.payload) }))
    .filter((entry) => entry.payload?.diagnosis === 'suspected_blank' || entry.payload?.diagnosis === 'still_loading')
    .sort((left, right) => {
      const failedAttemptId = firstFailedStep?.attempts.at(-1)?.id
      const rank = (entry: typeof left) =>
        (entry.item.attemptId === failedAttemptId ? 4 : 0) +
        (entry.payload?.role === 'on_error' ? 2 : 0) +
        (entry.payload?.diagnosis === 'suspected_blank' ? 1 : 0)
      return rank(right) - rank(left)
    })[0]
  if (flaggedScreenshot && facts.length < 24) {
    const signalText = flaggedScreenshot.payload?.diagnosis === 'suspected_blank'
      ? '采集端自动检查标记这张截图“疑似空白”'
      : '采集端自动检查标记这张截图“疑似仍在加载”'
    const screenshotStep = observation.run.stepRuns.find((step) => step.id === flaggedScreenshot.item.stepRunId)
    const captureLabel = flaggedScreenshot.payload
      ? `${SCREENSHOT_ROLE_LABELS[flaggedScreenshot.payload.role]}截图（${flaggedScreenshot.payload.capturedAt}）`
      : '截图'
    facts.push({
      id: `screenshot-${flaggedScreenshot.item.id}`,
      text: `${screenshotStep ? `步骤「${screenshotStep.name.slice(0, 48)}」的` : ''}${captureLabel}：${signalText}；这只是采集时的质量信号，不能据此确认页面位置或失败根因。`,
      citations: [citationKey('evidence', flaggedScreenshot.item.id)],
    })
  }
  const asksForImageContents = /截图|图像|画面/.test(body.question) &&
    /页面|停在|显示|看到|是什么|哪里/.test(body.question)
  if (recordedScreenshot) {
    const limitation = observation.run.status === 'SUCCEEDED'
      ? observation.run.outcomeStatus === 'FAIL'
        ? '运行中有已记录的截图，但本次分析没有读取图像内容；不能据此确认截图页面状态或业务检查差异。请在运行证据中人工核对。'
        : '运行中有已记录的截图，但本次分析没有读取图像内容；不能描述截图里的具体页面状态。'
      : '运行中有已记录的截图，但本次分析没有读取图像内容；无法确认具体页面内容、所在位置或失败根因。请在运行证据中人工核对。'
    missingInformation.push(limitation)
  } else if (asksForImageContents) {
    missingInformation.push('本次运行没有可供分析的截图证据；无法判断页面当时停在哪里。')
  }
  const unverifiedBusinessFailure = observation.run.status === 'SUCCEEDED' &&
    observation.run.outcomeStatus === 'FAIL'
  const recordedErrors = observation.run.stepRuns.flatMap((step) =>
    step.attempts.map((attempt) => attempt.error).filter((error) => error !== null))
  const genericExecutorFailure = observation.run.status === 'FAILED' && recordedErrors.length > 0 &&
    recordedErrors.every((error) => error.code === 'EXECUTOR_ERROR' &&
      (!error.safeMessage || error.safeMessage.trim() === '执行器执行失败'))
  const ambiguousLocatorFailure = observation.run.status === 'FAILED' && recordedErrors.length > 0 &&
    recordedErrors.every((error) => error.code === 'AI_NOT_FOUND' &&
      /定位不唯一或目标被遮挡/.test(error.safeMessage ?? ''))
  if (unverifiedBusinessFailure) {
    missingInformation.push('已确认执行完成但业务检查失败；当前回答没有可核对的期望值与实际值，不能确定具体差异。请在运行详情核对该业务检查与现场证据。')
  }
  if (genericExecutorFailure) {
    missingInformation.push('当前只记录到通用执行器错误，无法确定是浏览器、网络、脚本还是页面导致；请先核对失败步骤的运行证据与错误详情。')
  }
  if (ambiguousLocatorFailure) {
    missingInformation.push('错误说明只表明目标定位不唯一或可能被遮挡，不能确认是哪一种，也不能断定元素不存在；请核对失败步骤的截图与定位信息。')
  }
  if (hasSpecificDiagnosisFailureEvidence(observation.run)) {
    missingInformation.push('已记录的错误码与安全说明可解释失败表现；更深层的原因没有独立证据，不能直接断定。请核对失败步骤的现场证据。')
  }
  if (observation.run.status === 'FAILED' && (!firstFailedStep || recordedErrors.length === 0)) {
    missingInformation.push('运行标记为失败，但没有可定位的失败步骤和具体错误记录；不能推断根因。请先核对运行详情与证据轴。')
  } else if (observation.run.status !== 'FAILED' && /(?:为什么失败|失败原因|根因|出错)/.test(body.question)) {
    missingInformation.push(`本次运行当前状态为 ${observation.run.status}，没有已确认的执行失败根因；请先核对执行状态与业务结果。`)
  }

  return {
    kind: 'diagnosis',
    observedAt: new Date().toISOString(),
    eventSeq: observation.eventSeq,
    focus: pack.focus,
    facts: recentFailureWindow
      ? [{
          id: 'fact-recent-failed-window',
          text: `在 ${recentFailureWindow.from} 至 ${recentFailureWindow.to} 的当前可见业务运行中，至少找到 1 条状态为 FAILED 的记录；以下诊断的是最近一条。`,
          citations: [citationKey('run', runId)],
        }, ...facts].slice(0, 24)
      : facts,
    hypotheses: [],
    missingInformation,
    missingReasons: pack.missingReasons,
    nextActions,
  }
}
