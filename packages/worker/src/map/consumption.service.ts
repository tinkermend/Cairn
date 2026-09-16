import { createHash } from 'node:crypto'
import {
  appendMapFacts,
  appendMapSelectionDecision,
  findMapConsumptionAttemptObservation,
  loadFrozenMapCandidates,
  newId,
  type DbHandle,
} from '@cairn/db'
import {
  applicabilityReason, canEnterCandidateBranch, chooseUniqueLocatedCandidate,
  isStepEligibleForMapConsumption, preserveConsumptionScope, type LocatedCandidate,
} from '@cairn/map'
import {
  canonicalJson, isMapConsumptionEnabled, mapConditionSnapshot, mapConditionSnapshotSchema, mapSelectionDecisionSchema,
  retainUntilFor, type BrowserCommand, type BrowserCommandResult, type ExecutionError,
  type MapFactBatchItem, type MapSelectionDecision, type MapSelectionReasonCode, type Step,
} from '@cairn/shared'
import type { BrowserPort } from '../engine/ports.js'
import type { StepExecutionContext } from '../engine/step-executor.js'

export type MapConsumptionFollowUp =
  | { kind: 'passthrough' }
  | { kind: 'replaced'; result: BrowserCommandResult }
  | { kind: 'blocked'; error: ExecutionError }

/** The race only wraps reads. A late query/locate cannot dispatch a business command. */
async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort!: () => void
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([work(), stopped]) }
  finally { signal.removeEventListener('abort', abort) }
}

export class MapConsumptionService {
  constructor(private readonly handle: DbHandle, private readonly browser?: BrowserPort) {}

  async afterBaseline(ctx: StepExecutionContext, step: Step, baseline: BrowserCommandResult,
    originalCommand: BrowserCommand): Promise<MapConsumptionFollowUp> {
    if (!isMapConsumptionEnabled(ctx.snapshot)) return { kind: 'passthrough' }
    const frozen = ctx.snapshot.mapConsumption
    const started = ctx.clock.now()
    const deadline = Math.min(started + frozen.policy.maxResolveMs,
      ctx.deadlineAtMs ?? Infinity,
      ctx.snapshot.deadlineAt ? Date.parse(ctx.snapshot.deadlineAt) : Infinity)
    const runtime = await this.runtimeCondition(ctx)
    const observed = runtime.condition
    const spent = () => Math.min(120_000, Math.max(0, ctx.clock.now() - started))
    const base = {
      runId: ctx.runId, stepRunId: ctx.stepRunId, attemptId: ctx.attemptId, decisionOrdinal: 0,
      targetId: ctx.targetId, releaseId: frozen.releaseId, manifestDigest: frozen.manifestDigest,
      policyVersion: frozen.policy.policyVersion, consumerVersion: frozen.consumerVersion,
      mode: frozen.mode, conditionSnapshot: observed,
      coverage: runtime.coverage,
      baselineOutcome: baseline.ok ? 'FOUND' : baseline.error.code,
      candidatesEvaluated: [] as MapSelectionDecision['candidatesEvaluated'],
    }
    const persist = async (partial: Pick<MapSelectionDecision, 'decision' | 'reasonCode'> & Partial<MapSelectionDecision>) => {
      try {
        const decision = mapSelectionDecisionSchema.parse({ ...base, ...partial, decisionId: newId(),
          spentMs: spent(), extraAiCalls: 0, evidenceRefs: [] })
        await appendMapSelectionDecision(this.handle, { grant: ctx.grant, decision })
        return { kind: 'persisted' as const, decision }
      } catch {
        return { kind: 'blocked' as const, error: { code: 'MAP_DECISION_PERSISTENCE_FAILED',
          category: 'INFRASTRUCTURE' as const, retryable: true, safeMessage: '地图选择事实写入失败或运行所有权已失效' } }
      }
    }
    const skip = async (reasonCode: MapSelectionReasonCode,
      candidatesEvaluated = base.candidatesEvaluated): Promise<MapConsumptionFollowUp> => {
      // Best-effort comparison must not turn an already executed baseline into a retry.
      await persist({ decision: reasonCode === 'BASELINE_FOUND' ? 'baseline' : 'skipped', reasonCode, candidatesEvaluated })
      return { kind: 'passthrough' }
    }

    const eligible = isStepEligibleForMapConsumption(step, frozen.policy)
    if (!eligible.ok) return skip(eligible.reasonCode)
    const gate = canEnterCandidateBranch({ baselineOk: baseline.ok,
      errorCode: baseline.ok ? undefined : baseline.error.code, cancelled: ctx.signal.aborted,
      remainingMs: deadline - ctx.clock.now() })
    if (!gate.enter) return skip(gate.reasonCode ?? 'BASELINE_OTHER')
    if (!this.browser || !ctx.sessionGrant) return skip('QUERY_UNAVAILABLE')
    if ((originalCommand.type !== 'extract' && originalCommand.type !== 'assert') || !originalCommand.target) return skip('STEP_NOT_ELIGIBLE')

    const budget = new AbortController()
    const timer = setTimeout(() => budget.abort(), Math.max(1, deadline - ctx.clock.now()))
    const signal = AbortSignal.any([ctx.signal, budget.signal])
    const evaluations: MapSelectionDecision['candidatesEvaluated'] = []
    const stopReason = (): MapSelectionReasonCode | undefined => ctx.signal.aborted ? 'CANCELLED' :
      budget.signal.aborted || ctx.clock.now() >= deadline ? 'BUDGET_EXHAUSTED' : undefined
    try {
      let loaded: Awaited<ReturnType<typeof loadFrozenMapCandidates>>
      try { loaded = await bounded(() => loadFrozenMapCandidates(this.handle, frozen, step.id), signal) }
      catch { return skip(stopReason() ?? 'QUERY_UNAVAILABLE') }
      if (!loaded.digestOk) return skip('MANIFEST_INTEGRITY')
      if (!loaded.candidates.length) return skip('NO_BINDING')
      const located: LocatedCandidate[] = []
      const tokens = new Map<LocatedCandidate, string>()
      let remainingCandidates = frozen.policy.maxCandidateCount
      let skipReason: MapSelectionReasonCode = 'LOCATE_FAILED'
      for (const candidate of loaded.candidates) {
        if (evaluations.length >= 8) return skip('BUDGET_EXHAUSTED', evaluations)
        const stopped = stopReason()
        if (stopped) return skip(stopped, evaluations)
        const applicability = applicabilityReason(candidate.condition, observed)
        const descriptor = preserveConsumptionScope(originalCommand.target, candidate.descriptor)
        if (applicability.match !== 'satisfied' || !candidate.locatorConfirmed || !descriptor) {
          skipReason = applicability.reasonCode ?? 'CONDITION_UNKNOWN'
          evaluations.push({ objectId: candidate.binding.assetRef.objectId,
            implementationKey: candidate.binding.assetRef.implementationKey,
            descriptorVersion: candidate.binding.assetRef.descriptorVersion,
            matches: 0, outcome: 'SKIPPED', reasonCode: skipReason })
          continue
        }
        // Count every resolver candidate, not merely each descriptor. Never choose from
        // a truncated search: an unexamined candidate could make the result ambiguous.
        if (descriptor.candidates.length > remainingCandidates) return skip('BUDGET_EXHAUSTED', evaluations)
        remainingCandidates -= descriptor.candidates.length
        let result: BrowserCommandResult
        try {
          result = await bounded(() => this.browser!.execute(ctx.sessionGrant!, {
            type: 'locate', target: descriptor, timeoutMs: Math.max(1, Math.floor(deadline - ctx.clock.now())),
          }, signal), signal)
        } catch { return skip(stopReason() ?? 'QUERY_UNAVAILABLE', evaluations) }
        const stoppedAfterLocate = stopReason()
        if (stoppedAfterLocate) return skip(stoppedAfterLocate, evaluations)
        const matches = result.ok ? 1 : Math.max(0, ...(result.diagnostics?.candidatesTried.map(item => item.matches) ?? []))
        const outcome = result.ok ? 'FOUND' : result.diagnostics?.outcome ?? 'NOT_FOUND'
        evaluations.push({ objectId: candidate.binding.assetRef.objectId,
          implementationKey: candidate.binding.assetRef.implementationKey,
          descriptorVersion: candidate.binding.assetRef.descriptorVersion, matches, outcome })
        const item: LocatedCandidate = { binding: candidate.binding, descriptor,
          objectId: candidate.binding.assetRef.objectId!, matches, outcome }
        located.push(item)
        if (result.ok && result.resolvedTargetToken) tokens.set(item, result.resolvedTargetToken)
        if (!result.ok && result.error.code === 'SESSION_LEASE_LOST') return skip('LEASE_LOST', evaluations)
        if (outcome === 'SURFACE_LOST' || outcome === 'CAPABILITY_MISSING') return skip('LOCATE_FAILED', evaluations)
      }
      const chosen = chooseUniqueLocatedCandidate(located)
      const selected = chosen.selected
      if (!selected) return skip(located.length ? chosen.reasonCode : skipReason, evaluations)
      const token = tokens.get(selected)
      if (!token) return skip('LOCATE_FAILED', evaluations)
      const selection = { candidatesEvaluated: evaluations, assetRef: selected.binding.assetRef,
        selectedDescriptorVersion: selected.binding.assetRef.descriptorVersion,
        selectedDescriptorDigest: createHash('sha256').update(canonicalJson(selected.descriptor)).digest('hex') }
      if (frozen.mode === 'shadow') {
        await persist({ ...selection, decision: 'shadow_only', reasonCode: 'SHADOW_WOULD_USE' })
        return { kind: 'passthrough' }
      }
      const written = await persist({ ...selection, decision: 'selected', reasonCode: 'FALLBACK_USED' })
      if (written.kind === 'blocked') return written
      // Persistence may outlive the resolve budget; never read after cancellation/expiry.
      if (stopReason()) return { kind: 'passthrough' }
      const result = await bounded(() => this.browser!.execute(ctx.sessionGrant!, {
        ...originalCommand, target: selected.descriptor, expectedTargetToken: token,
      }, signal, {
        runId: ctx.runId, stepRunId: ctx.stepRunId, attemptId: ctx.attemptId,
        screenshot: ctx.evidencePolicy.screenshot, trace: ctx.evidencePolicy.trace,
        screenshotRetainUntil: retainUntilFor('screenshot', ctx.evidencePolicy).toISOString(),
        traceRetainUntil: retainUntilFor('trace', ctx.evidencePolicy).toISOString(),
      }), signal).catch(() => undefined)
      if (!result) return { kind: 'passthrough' }
      if (!(await this.appendFeedback(ctx, written.decision, originalCommand, result))) {
        return { kind: 'blocked', error: { code: 'MAP_DECISION_PERSISTENCE_FAILED',
          category: 'INFRASTRUCTURE', retryable: true, safeMessage: '地图消费评价写入失败' } }
      }
      return { kind: 'replaced', result }
    } finally { clearTimeout(timer) }
  }

  private async runtimeCondition(ctx: StepExecutionContext): Promise<{
    condition: ReturnType<typeof mapConditionSnapshot>
    coverage: string
  }> {
    const initial = mapConditionSnapshot({ targetId: ctx.targetId, targetAccountId: ctx.snapshot.targetAccountId })
    if (!this.browser?.sampleMapConditions || !ctx.sessionGrant) {
      return { condition: initial, coverage: 'page_frame_unavailable' }
    }
    try {
      const sampled = await this.browser.sampleMapConditions(ctx.sessionGrant, ctx.signal)
      const unknownFields = initial.unknownFields.filter((field) =>
        !((field === 'locale' && sampled.locale) || (field === 'viewport' && sampled.viewport)),
      )
      return {
        condition: mapConditionSnapshotSchema.parse({
          ...initial,
          ...(sampled.locale ? { locale: sampled.locale } : {}),
          ...(sampled.viewport ? { viewport: sampled.viewport } : {}),
          unknownFields,
        }),
        coverage: sampled.pageFrameObserved ? 'page_frame_observed' : 'page_frame_unknown',
      }
    } catch {
      return { condition: initial, coverage: 'page_frame_unknown' }
    }
  }

  /**
   * A selection is not a successful sample by itself.  The feedback joins a
   * pre-existing same-Attempt observation and records locator/read/business
   * dimensions independently.  No observation means there is nothing honest to
   * evaluate, so it remains absent rather than being fabricated after the read.
   */
  private async appendFeedback(
    ctx: StepExecutionContext,
    decision: MapSelectionDecision,
    command: BrowserCommand,
    result: BrowserCommandResult,
  ): Promise<boolean> {
    let observation: { observationId: string } | null
    try {
      observation = await findMapConsumptionAttemptObservation(this.handle, {
        targetId: ctx.targetId, runId: ctx.runId, attemptId: ctx.attemptId,
      })
    } catch {
      return false
    }
    if (!observation) return true
    const sourceEventKey = `map-consumption:${decision.decisionId}`
    const condition = decision.conditionSnapshot
    const at = new Date().toISOString()
    const locatorVerdict = result.ok ? 'confirmed' as const : 'not_observed' as const
    const facts: MapFactBatchItem[] = [{
      type: 'verification',
      verification: {
        id: newId(), schemaVersion: 1, targetId: ctx.targetId,
        dedupeKey: `${sourceEventKey}:locator`, observationIds: [observation.observationId],
        actionRef: { stepId: ctx.step.id, stepRunId: ctx.stepRunId, attemptId: ctx.attemptId, actionKind: command.type },
        dimension: 'locator', verdict: locatorVerdict,
        claim: {
          proposition: result.ok
            ? '选定候选在同一受管节点完成只读读取或判断'
            : '选定候选未能完成同一节点的只读读取或判断',
          ...(condition ? { condition } : {}),
        },
        evidenceRefs: [], evaluatedAt: at, evaluatorVersion: 'map-consumption@1',
        verificationSource: { kind: 'rule', runId: ctx.runId, stepRunId: ctx.stepRunId,
          attemptId: ctx.attemptId, ruleRef: 'map-consumption-feedback', sourceEventKey, sourceVersion: 'map-consumption@1' },
      },
    }]
    const business = command.type === 'assert'
      ? {
          verdict: result.ok ? 'confirmed' as const : result.error.code === 'ASSERT_FAILED' ? 'rejected' as const : 'not_observed' as const,
          proposition: result.ok ? '选定候选满足原业务断言' : '选定候选未满足或无法完成原业务断言',
          expected: command.expect,
        }
      : {
          verdict: 'not_observed' as const,
          proposition: '提取完成不构成业务正确性的独立证明',
        }
    facts.push({
      type: 'verification',
      verification: {
        id: newId(), schemaVersion: 1, targetId: ctx.targetId,
        dedupeKey: `${sourceEventKey}:business`, observationIds: [observation.observationId],
        actionRef: { stepId: ctx.step.id, stepRunId: ctx.stepRunId, attemptId: ctx.attemptId, actionKind: command.type },
        dimension: 'business', verdict: business.verdict,
        claim: { proposition: business.proposition, ...(condition ? { condition } : {}), ...(business.expected ? { expected: business.expected } : {}) },
        evidenceRefs: [], evaluatedAt: at, evaluatorVersion: 'map-consumption@1',
        verificationSource: { kind: 'rule', runId: ctx.runId, stepRunId: ctx.stepRunId,
          attemptId: ctx.attemptId, ruleRef: 'map-consumption-feedback', sourceEventKey, sourceVersion: 'map-consumption@1' },
      },
    })
    try {
      await appendMapFacts(this.handle, { caller: { kind: 'run', grant: ctx.grant }, facts })
      return true
    } catch {
      return false
    }
  }
}
