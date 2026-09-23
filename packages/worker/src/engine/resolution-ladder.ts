import { appendResolutionDecision, newId, type DbHandle } from '@cairn/db'
import {
  crossCheckMatches,
  describeLocatorCandidates,
  isCrossCheckContainerTag,
  policyAllowsAiRung,
  policyStartsAtAiRung,
  resolvedSelector,
  syncSha256,
  policyAllowsVisionAi,
  type BrowserCommand,
  type BrowserCommandResult,
  type ExecutionError,
  type ResolutionDecision,
  type ResolutionPolicy,
  type ResolutionReasonCode,
  type ResolutionRungRecord,
  type Step,
  type TargetDescriptor,
} from '@cairn/shared'
import type { MapConsumptionFollowUp, MapConsumptionService } from '../map/consumption.service.js'
import type { AiPort, BrowserPort } from './ports.js'
import type { StepExecutionContext, StepExecutionOutcome } from './step-executor.js'

const WRITE_EFFECTS = new Set(['SIDE_EFFECT', 'IDEMPOTENT'])
const TARGET_MISS_OUTCOMES = new Set(['NOT_FOUND', 'AMBIGUOUS', 'TARGET_NOT_FOUND', 'TARGET_AMBIGUOUS'])
const TARGET_MISS_CODES = new Set(['TARGET_NOT_FOUND', 'TARGET_AMBIGUOUS'])
const STRONG_EXISTING_CODES = new Set(['CANCELLED', 'LEASE_LOST', 'SESSION_LEASE_LOST'])

function clampSpentMs(started: number): number {
  return Math.min(120_000, Math.max(0, Date.now() - started))
}

function clampCallNs(callNs?: number[]): number[] | undefined {
  if (!callNs?.length) return callNs
  return callNs.slice(0, 8)
}

export function isDeterministicMiss(result: BrowserCommandResult): boolean {
  if (result.ok) return false
  const outcome = result.diagnostics?.outcome
  if (outcome) return TARGET_MISS_OUTCOMES.has(outcome)
  return TARGET_MISS_CODES.has(result.error.code)
}

function preferExistingError(existing: ExecutionError, persist: ExecutionError): ExecutionError {
  if (STRONG_EXISTING_CODES.has(existing.code)) return existing
  if (persist.code === 'CANCELLED' || persist.code === 'LEASE_LOST') return persist
  return existing
}

function reasonFromBrowser(result: Extract<BrowserCommandResult, { ok: false }>): ResolutionReasonCode | undefined {
  const code = result.error.code
  if (code === 'TARGET_NOT_FOUND' || code === 'TARGET_AMBIGUOUS') return code
  if (code === 'SURFACE_LOST') return 'SURFACE_LOST'
  if (code === 'BROWSER_CAPABILITY_MISSING' || code === 'CAPABILITY_MISSING') return 'CAPABILITY_MISSING'
  if (code === 'CANCELLED') return 'CANCELLED'
  if (code === 'SESSION_LEASE_LOST' || code === 'LEASE_LOST') return 'LEASE_LOST'
  return undefined
}

function hungError(message?: string): ExecutionError {
  return {
    code: 'AI_HUNG',
    category: 'UNKNOWN',
    retryable: false,
    safeMessage: message ?? 'AI 调用未落定，会话不可复用',
  }
}

export function commandHasResolvableTarget(command: BrowserCommand): command is BrowserCommand & { target: TargetDescriptor } {
  return 'target' in command && Boolean(command.target)
}

export function resolutionError(code: ResolutionReasonCode, message: string, retryable = false): ExecutionError {
  return {
    code,
    category: code === 'BUDGET_EXHAUSTED' || code === 'PERSISTENCE_FAILED' || code === 'LEASE_LOST' || code === 'CANCELLED'
      ? code === 'BUDGET_EXHAUSTED'
        ? 'VALIDATION'
        : code === 'CANCELLED'
          ? 'CANCELLED'
          : 'INFRASTRUCTURE'
      : 'EXECUTOR',
    retryable,
    safeMessage: message,
  }
}

export async function persistResolutionDecision(
  handle: DbHandle,
  ctx: StepExecutionContext,
  input: Omit<ResolutionDecision, 'decisionId' | 'runId' | 'stepRunId' | 'attemptId' | 'stepId' | 'createdAt'>,
): Promise<{ ok: true; decision: ResolutionDecision } | { ok: false; error: ExecutionError }> {
  const decision = {
    ...input,
    decisionId: newId(),
    runId: ctx.runId,
    stepRunId: ctx.stepRunId,
    attemptId: ctx.attemptId,
    stepId: ctx.step.id,
  } satisfies ResolutionDecision
  try {
    const saved = await appendResolutionDecision(handle, { grant: ctx.grant, decision })
    return { ok: true, decision: saved }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (code === 'RESOLUTION_FACT_STALE_OWNER') {
      if (ctx.signal.aborted) {
        return { ok: false, error: resolutionError('CANCELLED', '步骤已取消') }
      }
      return { ok: false, error: resolutionError('LEASE_LOST', '解析决策的运行所有权已失效') }
    }
    return {
      ok: false,
      error: resolutionError('PERSISTENCE_FAILED', '解析决策事实写入失败或运行所有权已失效', true),
    }
  }
}

export function outcomeFromBrowser(result: BrowserCommandResult): string {
  return result.ok ? 'FOUND' : result.error.code
}

export async function runResolutionLadder(input: {
  handle: DbHandle
  ctx: StepExecutionContext
  step: Step
  command: BrowserCommand
  browser: BrowserPort
  ai?: AiPort
  consumption: MapConsumptionService
  execute: (command: BrowserCommand) => Promise<BrowserCommandResult>
}): Promise<StepExecutionOutcome> {
  const { handle, ctx, step, command, browser, ai, consumption, execute } = input
  const frozen = ctx.snapshot.resolution
  if (!frozen || !commandHasResolvableTarget(command)) {
    const result = await execute(command)
    const followUp = await consumption.afterBaseline(ctx, step, result, command)
    return finalizeBrowser(followUp, result)
  }

  const effective: ResolutionPolicy = frozen.steps[step.id] ?? 'deterministic_only'
  const target = command.target
  const rungs: ResolutionRungRecord[] = []
  const semantic = target.semantic?.trim() || describeLocatorCandidates(target.candidates)
  const semanticDigest = semantic ? syncSha256(semantic) : undefined

  const record = async (
    decision: ResolutionDecision['decision'],
    reasonCode?: ResolutionReasonCode,
  ) => persistResolutionDecision(handle, ctx, {
    effectivePolicy: effective,
    rungs,
    decision,
    reasonCode,
    semanticDigest,
    evidenceRefs: [],
  })

  if (policyStartsAtAiRung(effective)) {
    const aiOutcome = await tryAiRung({ handle, ctx, step, command, target, effective, semantic, ai, browser, execute, rungs })
    if (aiOutcome.kind === 'success' || aiOutcome.kind === 'failed') return aiOutcome.outcome
    if (effective === 'ai_only') {
      const persisted = await record('failed', aiOutcome.reason)
      if (!persisted.ok) return failed(preferExistingError(aiOutcome.error ?? resolutionError(aiOutcome.reason ?? 'AI_NOT_FOUND', 'AI 定位未命中'), persisted.error))
      return failed(aiOutcome.error ?? resolutionError(aiOutcome.reason ?? 'AI_NOT_FOUND', 'AI 定位未命中'))
    }
  }

  const startedD = Date.now()
  const deterministic = await execute(command)
  rungs.push({
    rung: 'D',
    outcome: outcomeFromBrowser(deterministic),
    spentMs: clampSpentMs(startedD),
    candidatesTried: deterministic.diagnostics?.candidatesTried,
  })
  if (deterministic.ok) {
    const followUp = await consumption.afterBaseline(ctx, step, deterministic, command)
    const persisted = await record('deterministic')
    if (!persisted.ok) return failed(persisted.error)
    if (followUp.kind === 'blocked') return failed(followUp.error)
    return finalizeBrowser(followUp, deterministic)
  }
  if (!isDeterministicMiss(deterministic)) {
    const persisted = await record('failed', reasonFromBrowser(deterministic))
    if (!persisted.ok) return failed(preferExistingError(deterministic.error, persisted.error), deterministic)
    return failed(deterministic.error, deterministic)
  }

  if (!policyStartsAtAiRung(effective)) {
    const startedM = Date.now()
    const followUp = await consumption.afterBaseline(ctx, step, deterministic, command)
    if (followUp.kind === 'replaced') {
      rungs.push({
        rung: 'M',
        outcome: outcomeFromBrowser(followUp.result),
        spentMs: clampSpentMs(startedM),
        mapDecisionId: followUp.mapDecisionId,
      })
      const persisted = await record(followUp.result.ok ? 'map' : 'failed', followUp.result.ok ? undefined : 'TARGET_NOT_FOUND')
      if (!persisted.ok) {
        const existing = followUp.result.ok
          ? persisted.error
          : preferExistingError(followUp.result.error, persisted.error)
        return followUp.result.ok ? failed(persisted.error) : failed(existing, followUp.result)
      }
      return finalizeBrowser(followUp, followUp.result)
    }
    if (followUp.kind === 'blocked') {
      rungs.push({ rung: 'M', outcome: followUp.error.code, spentMs: clampSpentMs(startedM) })
      const persisted = await record('failed', 'PERSISTENCE_FAILED')
      if (!persisted.ok) return failed(preferExistingError(followUp.error, persisted.error))
      return failed(followUp.error)
    }
    rungs.push({ rung: 'M', outcome: 'SKIPPED', spentMs: clampSpentMs(startedM) })
  }

  if (policyAllowsAiRung(effective) && !policyStartsAtAiRung(effective)) {
    const aiOutcome = await tryAiRung({ handle, ctx, step, command, target, effective, semantic, ai, browser, execute, rungs })
    if (aiOutcome.kind === 'success' || aiOutcome.kind === 'failed') return aiOutcome.outcome
    const fallback = aiOutcome.error ?? deterministic.error
    const persisted = await record('failed', aiOutcome.reason ?? 'TARGET_NOT_FOUND')
    if (!persisted.ok) return failed(preferExistingError(fallback, persisted.error), deterministic)
    return failed(fallback, deterministic)
  }

  const persisted = await record('failed', 'TARGET_NOT_FOUND')
  if (!persisted.ok) return failed(preferExistingError(deterministic.error, persisted.error), deterministic)
  return failed(deterministic.error, deterministic)
}

async function tryAiRung(input: {
  handle: DbHandle
  ctx: StepExecutionContext
  step: Step
  command: BrowserCommand
  target: TargetDescriptor
  effective: ResolutionPolicy
  semantic: string
  ai?: AiPort
  browser: BrowserPort
  execute: (command: BrowserCommand) => Promise<BrowserCommandResult>
  rungs: ResolutionRungRecord[]
}): Promise<
  | { kind: 'success'; outcome: StepExecutionOutcome }
  | { kind: 'failed'; outcome: StepExecutionOutcome }
  | { kind: 'miss' | 'skip'; reason?: ResolutionReasonCode; error?: ExecutionError }
> {
  const { ctx, step, command, target, effective, semantic, ai, browser, execute, rungs } = input
  const started = Date.now()
  const spent = () => clampSpentMs(started)
  const persistFailed = async (
    reason: ResolutionReasonCode,
    error: ExecutionError,
    extras?: { hung?: boolean },
  ) => {
    const persisted = await persistResolutionDecision(input.handle, ctx, {
      effectivePolicy: effective,
      rungs,
      decision: 'failed',
      reasonCode: reason,
      semanticDigest: semantic ? syncSha256(semantic) : undefined,
      evidenceRefs: [],
    })
    const finalError = !persisted.ok && reason !== 'LEASE_LOST' && reason !== 'CANCELLED' && reason !== 'AI_HUNG'
      ? persisted.error
      : !persisted.ok
        ? preferExistingError(error, persisted.error)
        : error
    if (extras?.hung) {
      return {
        kind: 'failed' as const,
        outcome: {
          kind: 'needs_review' as const,
          error: finalError,
          timedOut: false,
          aborted: false,
          hung: true,
        },
      }
    }
    return { kind: 'failed' as const, outcome: failed(finalError) }
  }
  if (ctx.signal.aborted) {
    rungs.push({ rung: 'A', outcome: 'CANCELLED', spentMs: spent() })
    return persistFailed('CANCELLED', resolutionError('CANCELLED', '步骤已取消'))
  }
  if (target.framePath.length > 0) {
    rungs.push({ rung: 'A', outcome: 'FRAME_UNSUPPORTED', spentMs: spent() })
    return { kind: 'skip', reason: 'FRAME_UNSUPPORTED', error: resolutionError('FRAME_UNSUPPORTED', 'AI 定位首期只支持主文档') }
  }
  if (!ai || !ai.locate || !ctx.snapshot.aiExecution || !ctx.sessionGrant) {
    rungs.push({ rung: 'A', outcome: 'AI_DISABLED', spentMs: spent() })
    return { kind: 'skip', reason: 'AI_DISABLED', error: resolutionError('AI_DISABLED', '当前运行未冻结 AI 定位能力') }
  }
  if (!semantic) {
    rungs.push({ rung: 'A', outcome: 'AI_NOT_FOUND', spentMs: spent() })
    return { kind: 'miss', reason: 'AI_NOT_FOUND', error: resolutionError('AI_NOT_FOUND', '没有可供 AI 定位的语义描述') }
  }
  const requestTimeoutMs = ctx.snapshot.aiExecution.requestTimeoutMs
  const remainingMs = ctx.deadlineAtMs == null ? Number.POSITIVE_INFINITY : ctx.deadlineAtMs - ctx.clock.now()
  if (Number.isFinite(requestTimeoutMs) && remainingMs < requestTimeoutMs) {
    rungs.push({ rung: 'A', outcome: 'BUDGET_EXHAUSTED', spentMs: spent() })
    return {
      kind: 'skip',
      reason: 'BUDGET_EXHAUSTED',
      error: resolutionError('BUDGET_EXHAUSTED', '剩余尝试期限不够一次 AI 定位请求'),
    }
  }
  const located = await ai.locate(
    ctx.sessionGrant,
    {
      prompt: semantic,
      deepLocate: step.policy?.deepLocate === true,
      allowedOrigins: ctx.snapshot.allowedOrigins ?? [],
      loginOrigin: ctx.snapshot.loginOrigin,
      loginPath: ctx.snapshot.loginPath,
      allowVision: policyAllowsVisionAi(effective),
    },
    ctx.signal,
    {
      runId: ctx.runId,
      stepRunId: ctx.stepRunId,
      attemptId: ctx.attemptId,
      grant: ctx.grant,
      maxCalls: ctx.snapshot.aiExecution.maxCalls,
      model: ctx.snapshot.aiExecution.modelName,
      config: ctx.snapshot.aiExecution,
    },
  )
  if (located.hung || located.error?.code === 'AI_HUNG') {
    rungs.push({ rung: 'A', outcome: 'AI_HUNG', spentMs: spent(), aiCallNs: clampCallNs(located.callNs) })
    return persistFailed('AI_HUNG', located.error ?? hungError(located.summary), { hung: true })
  }
  if (located.error?.code === 'SESSION_LEASE_LOST' || located.error?.code === 'LEASE_LOST') {
    rungs.push({ rung: 'A', outcome: 'LEASE_LOST', spentMs: spent(), aiCallNs: clampCallNs(located.callNs) })
    return persistFailed('LEASE_LOST', located.error)
  }
  if (located.error?.code === 'AI_BUDGET_EXCEEDED' || located.error?.code === 'BUDGET_EXHAUSTED') {
    rungs.push({ rung: 'A', outcome: 'BUDGET_EXHAUSTED', spentMs: spent(), aiCallNs: clampCallNs(located.callNs) })
    return persistFailed('BUDGET_EXHAUSTED', resolutionError('BUDGET_EXHAUSTED', '已超过本步骤模型调用预算'))
  }
  if (located.error?.code === 'CANCELLED' || ctx.signal.aborted) {
    rungs.push({ rung: 'A', outcome: 'CANCELLED', spentMs: spent(), aiCallNs: clampCallNs(located.callNs) })
    return persistFailed('CANCELLED', located.error ?? resolutionError('CANCELLED', '步骤已取消'))
  }
  if (located.error && located.error.retryable && located.error.code !== 'AI_NOT_FOUND') {
    rungs.push({
      rung: 'A',
      outcome: located.error.code,
      spentMs: spent(),
      aiCallNs: clampCallNs(located.callNs),
    })
    return persistFailed('AI_NOT_FOUND', located.error)
  }
  if (!located.ok || !located.center) {
    rungs.push({
      rung: 'A',
      outcome: located.error?.code ?? 'AI_NOT_FOUND',
      spentMs: spent(),
      aiCallNs: clampCallNs(located.callNs),
    })
    return {
      kind: 'miss',
      reason: (located.error?.code as ResolutionReasonCode | undefined) ?? 'AI_NOT_FOUND',
      error: located.error ?? resolutionError('AI_NOT_FOUND', located.summary ?? 'AI 未定位到目标'),
    }
  }
  if (!browser.bindResolvedFromPoint || !browser.clearResolved) {
    rungs.push({ rung: 'A', outcome: 'CAPABILITY_MISSING', spentMs: spent(), center: located.center })
    return { kind: 'skip', reason: 'CAPABILITY_MISSING', error: resolutionError('CAPABILITY_MISSING', '浏览器端口未提供点到元素映射') }
  }
  const token = `${ctx.attemptId.slice(0, 8)}-${newId().slice(0, 8)}`
  const bound = await browser.bindResolvedFromPoint(ctx.sessionGrant, {
    center: located.center,
    dpr: located.dpr ?? 1,
    token,
  }, ctx.signal)
  if (!bound.ok) {
    rungs.push({
      rung: 'A',
      outcome: bound.reason,
      spentMs: spent(),
      aiCallNs: clampCallNs(located.callNs),
      center: located.center,
      rectReliable: false,
    })
    return { kind: 'miss', reason: bound.reason, error: resolutionError(bound.reason, bound.message) }
  }
  const writeStep = WRITE_EFFECTS.has(step.effectType)
  let crossCheck: ResolutionRungRecord['crossCheck'] = 'skipped'
  if (writeStep && effective === 'prefer_deterministic') {
    if (target.candidates.length === 0) {
      crossCheck = 'not_applicable'
      rungs.push({
        rung: 'A',
        outcome: 'CROSS_CHECK_NOT_APPLICABLE',
        spentMs: spent(),
        aiCallNs: clampCallNs(located.callNs),
        center: located.center,
        rectReliable: false,
        crossCheck,
      })
      await browser.clearResolved(ctx.sessionGrant, token).catch(() => undefined)
      return {
        kind: 'miss',
        reason: 'CROSS_CHECK_NOT_APPLICABLE',
        error: resolutionError('CROSS_CHECK_NOT_APPLICABLE', '写步骤只有语义描述，prefer_deterministic 下拒绝 AI 定位'),
      }
    }
    if (isCrossCheckContainerTag(bound.tagName) || !crossCheckMatches(bound.texts, target.candidates)) {
      crossCheck = 'failed'
      rungs.push({
        rung: 'A',
        outcome: 'CROSS_CHECK_FAILED',
        spentMs: spent(),
        aiCallNs: clampCallNs(located.callNs),
        center: located.center,
        rectReliable: false,
        crossCheck,
      })
      await browser.clearResolved(ctx.sessionGrant, token).catch(() => undefined)
      return persistFailed('CROSS_CHECK_FAILED', resolutionError('CROSS_CHECK_FAILED', 'AI 定位到的元素与确定性候选不匹配'))
    }
    crossCheck = 'passed'
  }
  rungs.push({
    rung: 'A',
    outcome: 'FOUND',
    spentMs: spent(),
    aiCallNs: located.callNs,
    center: located.center,
    rectReliable: false,
    crossCheck,
  })
  const persisted = await persistResolutionDecision(input.handle, ctx, {
    effectivePolicy: effective,
    rungs,
    decision: 'ai',
    semanticDigest: syncSha256(semantic),
    evidenceRefs: [],
  })
  if (!persisted.ok) {
    await browser.clearResolved(ctx.sessionGrant, token).catch(() => undefined)
    return { kind: 'failed', outcome: failed(persisted.error) }
  }
  try {
    const resolvedCommand = {
      ...command,
      target: {
        framePath: [],
        candidates: [{ by: 'css' as const, value: resolvedSelector(token) }],
      },
    } as BrowserCommand
    const result = await execute(resolvedCommand)
    if (result.ok) {
      return {
        kind: 'success',
        outcome: success({
          ...result,
          diagnostics: {
            ...(result.diagnostics ?? { outcome: 'FOUND', candidatesTried: [] }),
            resolvedVia: 'ai',
            suggestedCandidate: bound.suggestedCandidate,
            ...(bound.suggestedCandidate
              ? {
                  suggestedPatch: {
                    kind: 'ADD_CANDIDATE' as const,
                    suggestedCandidate: bound.suggestedCandidate,
                  },
                }
              : {}),
          },
        }),
      }
    }
    return { kind: 'failed', outcome: failed(result.error, result) }
  } finally {
    await browser.clearResolved(ctx.sessionGrant, token).catch(() => undefined)
  }
}

function success(result: Extract<BrowserCommandResult, { ok: true }>): StepExecutionOutcome {
  return {
    kind: 'success',
    output: result.output,
    screenshot: result.screenshot,
    trace: result.trace,
  }
}

function failed(error: ExecutionError, result?: BrowserCommandResult): StepExecutionOutcome {
  return {
    kind: 'failed',
    error,
    output: result && !result.ok ? result.output : undefined,
    diagnostics: result?.diagnostics,
    screenshot: result?.screenshot,
    trace: result?.trace,
    timedOut: false,
    aborted: error.code === 'CANCELLED',
  }
}

function finalizeBrowser(followUp: MapConsumptionFollowUp, result: BrowserCommandResult): StepExecutionOutcome {
  if (followUp.kind === 'blocked') return failed(followUp.error)
  const finalResult = followUp.kind === 'replaced' ? followUp.result : result
  return finalResult.ok ? success(finalResult) : failed(finalResult.error, finalResult)
}
