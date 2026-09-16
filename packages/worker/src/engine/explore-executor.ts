import {
  FACTORY_EXPLORATION_POLICY,
  MAP_EXPLORE_STEP_TYPES,
  explorationActionResultSchema,
  explorationPolicySchema,
  explorationProposalSchema,
  explorationVerificationSchema,
  jsonValueSchema,
  observationBundleSchema,
  retainUntilFor,
  type ExplorationPolicy,
  type ObservationBundle,
} from '@cairn/shared'
import { buildObservationBundle, decideExploreGuard, proposeExploreHop } from '@cairn/map'
import type { BrowserPort } from './ports.js'
import type { StepExecutionContext, StepExecutionOutcome, StepExecutor } from './step-executor.js'

export class MapExploreExecutor implements StepExecutor {
  readonly supportedTypes: readonly string[] = [...MAP_EXPLORE_STEP_TYPES]

  constructor(private readonly browser?: BrowserPort) {}

  async execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    if (ctx.step.type === 'map_observe') return this.observe(ctx)
    if (ctx.step.type === 'map_propose') return this.propose(ctx)
    if (ctx.step.type === 'map_guarded_action') return this.act(ctx)
    if (ctx.step.type === 'map_verify') return this.verify(ctx)
    return fail('EXECUTOR_UNSUPPORTED_TYPE', `不支持的探索步骤：${ctx.step.type}`)
  }

  private async observe(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    const hold = ctx.sessionGrant ? await this.browser?.describeHold?.(ctx.runId) : undefined
    const input = ctx.step.type === 'map_observe' ? ctx.step.input : { mode: 'allowlist' as const, allowlist: [], seedUrls: [] }
    const policy = policyFrom(ctx, input)
    const output = buildObservationBundle({
      currentUrl: hold?.url,
      policy,
      seedUrls: input.seedUrls,
    })
    return { kind: 'success', output: asJson(output) }
  }

  private propose(ctx: StepExecutionContext): StepExecutionOutcome {
    const observation = readObservation(ctx)
    if (!observation) return fail('EXPLORATION_OBSERVATION_MISSING', '提名缺少本轮观察')
    return { kind: 'success', output: asJson(proposeExploreHop(observation)) }
  }

  private async act(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    const proposal = readProposal(ctx)
    const observation = readObservation(ctx, 'explore_observation')
    if (!proposal || !observation) return fail('EXPLORATION_PROPOSAL_MISSING', '守卫缺少提名或观察')
    const policy = policyFrom(ctx, { allowlist: observation.allowlist, mode: 'allowlist' })
    const decision = decideExploreGuard({ proposal, observation, policy })
    if (decision.decision !== 'allow' || proposal.kind !== 'navigate' || !proposal.url) {
      return {
        kind: 'success',
        output: asJson(
          explorationActionResultSchema.parse({
            state: 'not_dispatched',
            ...(proposal.url ? { url: proposal.url } : {}),
            error: decision.reason,
          }),
        ),
      }
    }
    if (!this.browser || !ctx.sessionGrant) {
      return fail('BROWSER_UNAVAILABLE', '探索动作没有可用会话')
    }
    const allowedOrigins = ctx.snapshot.allowedOrigins ?? []
    const result = await this.browser.execute(
      ctx.sessionGrant,
      { type: 'navigate', url: proposal.url, allowedOrigins },
      ctx.signal,
      {
        runId: ctx.runId,
        stepRunId: ctx.stepRunId,
        attemptId: ctx.attemptId,
        screenshot: ctx.evidencePolicy.screenshot,
        trace: ctx.evidencePolicy.trace,
        screenshotRetainUntil: retainUntilFor('screenshot', ctx.evidencePolicy).toISOString(),
        traceRetainUntil: retainUntilFor('trace', ctx.evidencePolicy).toISOString(),
      },
    )
    if (!result.ok) {
      return {
        kind: 'failed',
        error: result.error,
        output: asJson(
          explorationActionResultSchema.parse({
            state: 'unknown',
            url: proposal.url,
            error: result.error.safeMessage,
          }),
        ),
        screenshot: result.screenshot,
        trace: result.trace,
      }
    }
    return {
      kind: 'success',
        output: asJson(explorationActionResultSchema.parse({ state: 'completed', url: proposal.url })),
      screenshot: result.screenshot,
      trace: result.trace,
    }
  }

  private async verify(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    const action = readAction(ctx)
    const hold = ctx.sessionGrant ? await this.browser?.describeHold?.(ctx.runId) : undefined
    const dispatched = action?.state === 'completed' || action?.state === 'dispatched'
    const pageChanged = Boolean(hold?.url && action?.url && hold.url !== action.url)
    const output = explorationVerificationSchema.parse({
      location: hold?.url ? 'support' : 'unknown',
      action: dispatched ? 'support' : action ? 'unknown' : 'unknown',
      pageChange: pageChanged ? 'support' : 'unknown',
      businessResult: 'unknown',
      promoted: false,
      ...(hold?.url ? { currentUrl: hold.url } : {}),
    })
    return { kind: 'success', output: asJson(output) }
  }
}

function asJson(value: unknown) {
  return jsonValueSchema.parse(JSON.parse(JSON.stringify(value)))
}

function fail(code: string, safeMessage: string): StepExecutionOutcome {
  return {
    kind: 'failed',
    error: { code, category: 'VALIDATION', retryable: false, safeMessage },
    timedOut: false,
    aborted: false,
  }
}

function policyFrom(ctx: StepExecutionContext, input?: { allowlist?: ExplorationPolicy['allowlist']; mode?: ExplorationPolicy['mode'] }): ExplorationPolicy {
  const frozen = (ctx.snapshot.mapJob as { exploration?: unknown } | undefined)?.exploration
  const parsed = explorationPolicySchema.safeParse(frozen)
  if (parsed.success) return parsed.data
  return explorationPolicySchema.parse({
    ...FACTORY_EXPLORATION_POLICY,
    mode: input?.mode ?? FACTORY_EXPLORATION_POLICY.mode,
    allowlist: input?.allowlist ?? [],
  })
}

function readObservation(ctx: StepExecutionContext, key?: string): ObservationBundle | undefined {
  const from =
    key ??
    (ctx.step.type === 'map_propose' || ctx.step.type === 'map_guarded_action' || ctx.step.type === 'map_verify'
      ? 'from' in ctx.step.input && typeof ctx.step.input.from === 'string'
        ? ctx.step.type === 'map_verify'
          ? ctx.step.input.observationFrom
          : ctx.step.input.from
        : 'explore_observation'
      : 'explore_observation')
  const raw = ctx.context[from] ?? ctx.context.explore_observation
  const parsed = observationBundleSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

function readProposal(ctx: StepExecutionContext) {
  const from = ctx.step.type === 'map_guarded_action' ? ctx.step.input.from : 'explore_proposal'
  return explorationProposalSchema.safeParse(ctx.context[from]).data
}

function readAction(ctx: StepExecutionContext) {
  const from = ctx.step.type === 'map_verify' ? ctx.step.input.from : 'explore_action'
  return explorationActionResultSchema.safeParse(ctx.context[from]).data
}
