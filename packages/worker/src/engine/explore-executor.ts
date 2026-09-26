import {
  FACTORY_EXPLORATION_POLICY,
  MAP_EXPLORE_STEP_TYPES,
  buildPageKey,
  buildPresentationStateKey,
  buildViewStateKey,
  explorationActionResultSchema,
  explorationPolicySchema,
  explorationProposalSchema,
  explorationVerificationSchema,
  jsonValueSchema,
  observationBundleSchema,
  retainUntilFor,
  targetStateRuleSchema,
  type ExplorationPolicy,
  type ObservationBundle,
  type TargetStateRule,
} from '@cairn/shared'
import { buildObservationBundle, decideExploreGuard, proposeExploreHop } from '@cairn/map'
import {
  getTargetStateRule,
  recordExploreDiscoveries,
  recordExploreState,
  recordExploreTraversal,
  type DbHandle,
} from '@cairn/db'
import type { BrowserPort } from './ports.js'
import type { StepExecutionContext, StepExecutionOutcome, StepExecutor } from './step-executor.js'
import { toObservationCandidates } from '../browser/explore-candidate-collector.js'
import type { ExploreGuardController } from '../browser/explore-network-guard.js'

export class MapExploreExecutor implements StepExecutor {
  readonly supportedTypes: readonly string[] = [...MAP_EXPLORE_STEP_TYPES]

  constructor(
    private readonly browser?: BrowserPort,
    private readonly db?: DbHandle,
  ) {}

  async execute(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    if (ctx.step.type === 'map_observe') return this.observe(ctx)
    if (ctx.step.type === 'map_propose') return this.propose(ctx)
    if (ctx.step.type === 'map_guarded_action') return this.act(ctx)
    if (ctx.step.type === 'map_verify') return this.verify(ctx)
    return fail('EXECUTOR_UNSUPPORTED_TYPE', `不支持的探索步骤：${ctx.step.type}`)
  }

  private async observe(ctx: StepExecutionContext): Promise<StepExecutionOutcome> {
    const hold = ctx.sessionGrant ? await this.browser?.describeHold?.(ctx.runId) : undefined
    const input =
      ctx.step.type === 'map_observe' ? ctx.step.input : { mode: 'allowlist' as const, allowlist: [], seedUrls: [] }
    const policy = policyFrom(ctx, input)
    const currentUrl = hold?.url ?? ''
    const allowedOrigins = ctx.snapshot.allowedOrigins ?? []

    // 尝试加载 Target 状态规则
    let stateRule: TargetStateRule = targetStateRuleSchema.parse({
      ruleVersion: 1,
      routeMatches: [],
      readyAssertion: {},
      variants: [],
      allowedSpaHashPrefixes: ['#/'],
    })
    if (this.db && ctx.targetId) {
      try {
        const ruleDto = await getTargetStateRule(this.db, ctx.targetId)
        if (ruleDto) stateRule = ruleDto
      } catch {}
    }

    // 若浏览器端口支持只读候选收集且有会话授权
    if (this.browser?.collectExploration && ctx.sessionGrant) {
      try {
        const scanResult = await this.browser.collectExploration(
          ctx.sessionGrant,
          {
            targetId: ctx.targetId,
            allowedOrigins,
            allowlist: policy.allowlist.map((item) =>
              typeof item === 'string' ? item : `${item.origin}${item.pathPrefix || ''}`,
            ),
            stateRule,
            maxCandidates: policy.maxCandidates,
          },
          ctx.signal,
        )

        const pageKey = buildPageKey({
          targetId: ctx.targetId,
          url: scanResult.currentUrl || currentUrl,
          frame: 'main',
          allowedSpaHashPrefixes: stateRule.allowedSpaHashPrefixes,
        })
        const viewStateKey = buildViewStateKey({
          pageKey,
          ruleVersion: stateRule.ruleVersion,
          variantKey: scanResult.domSignals.tabs[0],
        })
        const presentationStateKey = buildPresentationStateKey({
          viewStateKey,
          ancestorPath: scanResult.openAncestorPaths[0],
        })

        let stateId: string | undefined
        if (this.db) {
          try {
            stateId = await recordExploreState(this.db, {
              targetId: ctx.targetId,
              targetAccountId: ctx.snapshot.targetAccountId ?? 'default',
              jobId: ctx.snapshot.mapJob?.jobId,
              runId: ctx.runId,
              pageKey,
              viewStateKey,
              presentationStateKey,
              stateRuleVersion: stateRule.ruleVersion,
              readiness: 'ready',
              snapshotData: {
                url: scanResult.currentUrl,
                title: scanResult.title,
                domSignals: scanResult.domSignals,
              },
            })

            const discoveriesToRecord = scanResult.candidates.map((c) => ({
              targetId: ctx.targetId,
              jobId: ctx.snapshot.mapJob?.jobId ?? '00000000-0000-4000-8000-000000000000',
              runId: ctx.runId,
              stepRunId: ctx.stepRunId,
              attemptId: ctx.attemptId,
              sourceStateId: stateId,
              sourcePresentationStateKey: presentationStateKey,
              controlFingerprint: c.controlFingerprint,
              accessibleName: c.accessibleName,
              role: c.role,
              ancestorPath: c.ancestorPath,
              frameSelector: c.frame,
              candidateCategory: c.candidateCategory,
              targetUrl: c.canonicalTargetUrl,
              targetDigest: c.targetDigest,
              targetHint: c.stateHint || (c.canonicalTargetUrl ? 'known_url' : 'unknown_destination'),
              locatorDescriptor: c.targetDescriptor,
              collectorVersion: '1.0.0',
              evidenceStatus: 'complete' as const,
              rejectionReason: c.rejectionReason,
              status: (c.eligible ? 'pending_review' : 'rejected') as 'pending_review' | 'rejected',
            }))

            await recordExploreDiscoveries(this.db, discoveriesToRecord)
          } catch {}
        }

        const observationCandidates = toObservationCandidates(scanResult.candidates, 16)
        let origin = ''
        try {
          origin = scanResult.currentUrl ? new URL(scanResult.currentUrl).origin : ''
        } catch {}

        const output = observationBundleSchema.parse({
          currentUrl: scanResult.currentUrl || currentUrl,
          origin,
          title: scanResult.title,
          allowlisted: true,
          allowlist: policy.allowlist,
          candidates: observationCandidates,
          visited: scanResult.currentUrl ? [scanResult.currentUrl] : [],
        })

        return {
          kind: 'success',
          output: asJson({
            ...output,
            explorationState: {
              stateId,
              pageKey,
              viewStateKey,
              presentationStateKey,
              candidatesTotal: scanResult.candidates.length,
              truncated: scanResult.truncated,
              gaps: scanResult.gaps,
            },
          }),
        }
      } catch (err) {
        // 出错回退基础观察
      }
    }

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

    if (decision.decision !== 'allow') {
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

    // 安装网络守卫与弹窗拦截器
    let guardController: ExploreGuardController | undefined
    if (this.browser.installExploreGuard) {
      try {
        guardController = await this.browser.installExploreGuard(ctx.sessionGrant, {
          allowlist: policy.allowlist,
          allowedOrigins,
        })
      } catch {}
    }

    let command: import('@cairn/shared').BrowserCommand
    if (proposal.kind === 'navigate' && proposal.url) {
      command = { type: 'navigate', url: proposal.url, allowedOrigins }
    } else {
      const stepTarget =
        ctx.step.type === 'map_guarded_action' && ctx.step.input?.targetDescriptor
          ? ctx.step.input.targetDescriptor
          : undefined
      command = {
        type: 'click',
        target: stepTarget ?? {
          framePath: [],
          candidates: [{ by: 'css', value: `[data-candidate-id="${proposal.candidateId}"]` }],
        },
      }
    }

    let result: import('@cairn/shared').BrowserCommandResult
    try {
      result = await this.browser.execute(ctx.sessionGrant, command, ctx.signal, {
        runId: ctx.runId,
        stepRunId: ctx.stepRunId,
        attemptId: ctx.attemptId,
        screenshot: ctx.evidencePolicy.screenshot,
        trace: ctx.evidencePolicy.trace,
        screenshotRetainUntil: retainUntilFor('screenshot', ctx.evidencePolicy).toISOString(),
        traceRetainUntil: retainUntilFor('trace', ctx.evidencePolicy).toISOString(),
        commandType: command.type,
        screenshotViewport: ctx.evidencePolicy.screenshotViewport,
        sensitiveSelectors: ctx.snapshot.targetAuth?.sensitiveSelectors ?? [],
      })
    } finally {
      if (guardController) {
        await guardController.uninstall().catch(() => {})
      }
    }

    const dialogEncountered = guardController?.wasDialogEncountered() ?? false
    const blockedRequests = guardController?.getBlockedRequests() ?? []

    // 记录探索遍历事实
    const preObs = (ctx.context.explore_observation as { explorationState?: { stateId?: string; presentationStateKey?: string } } | undefined)?.explorationState
    const fromStateId = preObs?.stateId
    const fromPresentationStateKey = preObs?.presentationStateKey || 'root'

    if (!result.ok || dialogEncountered || blockedRequests.length > 0) {
      const errorMessage = dialogEncountered
        ? '动作过程中出现弹窗并已自动关闭，结果不明'
        : blockedRequests.length > 0
          ? `检测到违规网络请求：${blockedRequests[0]?.reason}`
          : (!result.ok ? result.error.safeMessage : '探索动作未正常完成')

      if (this.db) {
        try {
          await recordExploreTraversal(this.db, {
            targetId: ctx.targetId,
            jobId: ctx.snapshot.mapJob?.jobId ?? '00000000-0000-4000-8000-000000000000',
            runId: ctx.runId,
            attemptId: ctx.attemptId,
            actionCategory: proposal.kind === 'reveal' ? 'reveal' : proposal.url ? 'direct_url_open' : 'ui_activate',
            relationType: proposal.kind === 'reveal' ? 'reveals_navigation' : proposal.url ? 'link_observed' : 'ui_activate',
            fromStateId,
            fromPresentationStateKey,
            guardDecision: 'allow',
            guardReason: decision.reason,
            actionOutcome: 'unknown',
            locationVerify: 'unknown',
            actionVerify: 'unknown',
            pageChangeVerify: 'unknown',
            businessResult: 'unknown',
            promoted: false,
            evidenceStatus: 'missing',
            errorMessage,
          })
        } catch {}
      }

      // 动作结果不明或具有副作用语义时，转入 NEEDS_REVIEW
      return {
        kind: 'needs_review',
        error: {
          code: 'EXPLORATION_ACTION_OUTCOME_UNKNOWN',
          category: 'EXECUTOR',
          retryable: false,
          safeMessage: errorMessage,
        },
        output: asJson(
          explorationActionResultSchema.parse({
            state: 'unknown',
            ...(proposal.url ? { url: proposal.url } : {}),
            error: errorMessage,
          }),
        ),
        screenshot: result.screenshot,
        trace: result.trace,
      }
    }

    if (this.db) {
      try {
        await recordExploreTraversal(this.db, {
          targetId: ctx.targetId,
          jobId: ctx.snapshot.mapJob?.jobId ?? '00000000-0000-4000-8000-000000000000',
          runId: ctx.runId,
          attemptId: ctx.attemptId,
          actionCategory: proposal.kind === 'reveal' ? 'reveal' : proposal.url ? 'direct_url_open' : 'ui_activate',
          relationType: proposal.kind === 'reveal' ? 'reveals_navigation' : proposal.url ? 'link_observed' : 'ui_activate',
          fromStateId,
          fromPresentationStateKey,
          guardDecision: 'allow',
          guardReason: decision.reason,
          actionOutcome: 'completed',
          locationVerify: 'support',
          actionVerify: 'support',
          pageChangeVerify: 'support',
          businessResult: 'unknown',
          promoted: false,
          evidenceStatus: 'complete',
        })
      } catch {}
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

function policyFrom(
  ctx: StepExecutionContext,
  input?: { allowlist?: ExplorationPolicy['allowlist']; mode?: ExplorationPolicy['mode'] },
): ExplorationPolicy {
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
  if (ctx.step.type === 'map_guarded_action' && (ctx.step.input as any)?.proposal) {
    const parsed = explorationProposalSchema.safeParse((ctx.step.input as any).proposal)
    if (parsed.success) return parsed.data
  }
  const from = ctx.step.type === 'map_guarded_action' ? ctx.step.input.from : 'explore_proposal'
  return explorationProposalSchema.safeParse(ctx.context[from]).data
}

function readAction(ctx: StepExecutionContext) {
  const from = ctx.step.type === 'map_verify' ? ctx.step.input.from : 'explore_action'
  return explorationActionResultSchema.safeParse(ctx.context[from]).data
}
