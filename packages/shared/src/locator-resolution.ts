import {
  LOCATOR_ROUTE_LABELS,
  locatorPlanSchema,
  type LocatorLimits,
  type LocatorPlan,
  type LocatorRoute,
  type LocatorSkip,
} from './locator-plan.js'
import {
  mergeEffectiveResolution,
  type ResolutionPolicy,
} from './resolution-policy.js'
import type { PlatformConfigDocument } from './platform-config.js'
import type { TargetResolutionPolicy } from './resolution-policy.js'
import type { AuthoringNode, ScenarioAuthoringDocumentV2 } from './authoring-document.js'

export type LocatorLayer = { plan?: LocatorPlan; policy?: ResolutionPolicy }
export type LocatorLimitLayer = { limits?: LocatorLimits; ceiling?: ResolutionPolicy }

export type LocatorResolutionInput = {
  platform: LocatorLayer & LocatorLimitLayer & { defaultPolicy: ResolutionPolicy; ceiling: ResolutionPolicy }
  target?: LocatorLayer & LocatorLimitLayer
  scenario?: LocatorLayer
  step?: LocatorLayer
  textReady: boolean
  visionReady: boolean
}

export type LocatorResolution = {
  requested: LocatorRoute[]
  actual: LocatorRoute[]
  skipped: LocatorSkip[]
  allowed: LocatorRoute[]
  source: 'step' | 'scenario' | 'target' | 'platform'
}

export class LocatorPlanError extends Error {
  readonly code = 'LOCATOR_ROUTE_UNAVAILABLE'
  constructor(message: string, readonly route?: LocatorRoute) {
    super(message)
    this.name = 'LocatorPlanError'
  }
}

export function legacyCeilingRoutes(ceiling: ResolutionPolicy): LocatorRoute[] {
  if (ceiling === 'deterministic_only') return ['rule']
  if (ceiling === 'prefer_deterministic_text' || ceiling === 'prefer_text_ai') return ['rule', 'text_ai']
  return ['rule', 'text_ai', 'vision_ai']
}

/** 必须忠实映射 v1 的实际调用顺序，文本配置不齐时 v1 原本会跳过文本档。 */
export function legacyPolicyRoutes(policy: ResolutionPolicy, textReady: boolean): LocatorRoute[] {
  switch (policy) {
    case 'deterministic_only': return ['rule']
    case 'prefer_deterministic_text': return textReady ? ['rule', 'text_ai'] : ['rule']
    case 'prefer_deterministic': return textReady ? ['rule', 'text_ai', 'vision_ai'] : ['rule', 'vision_ai']
    case 'prefer_text_ai': return textReady ? ['text_ai', 'rule'] : ['rule']
    case 'prefer_ai': return textReady ? ['text_ai', 'vision_ai', 'rule'] : ['vision_ai', 'rule']
    case 'ai_only': return textReady ? ['text_ai', 'vision_ai'] : ['vision_ai']
  }
}

export function resolveLocatorPlan(input: LocatorResolutionInput): LocatorResolution {
  const platformAllowed = input.platform.limits?.allowed ?? legacyCeilingRoutes(input.platform.ceiling)
  const targetAllowed = input.target?.limits?.allowed ?? (input.target?.ceiling ? legacyCeilingRoutes(input.target.ceiling) : platformAllowed)
  const allowed = platformAllowed.filter((route) => targetAllowed.includes(route))

  const layer = input.step?.plan || input.step?.policy ? input.step
    : input.scenario?.plan || input.scenario?.policy ? input.scenario
    : input.target?.plan || input.target?.policy ? input.target
    : input.platform
  const source: LocatorResolution['source'] = layer === input.step ? 'step'
    : layer === input.scenario ? 'scenario'
    : layer === input.target ? 'target' : 'platform'
  const legacyEffective = mergeEffectiveResolution({
    ceiling: input.platform.ceiling,
    defaultResolution: input.platform.defaultPolicy,
    targetCeiling: input.target?.ceiling,
    targetPreference: input.target?.policy,
    document: input.scenario?.policy,
    step: input.step?.policy,
  })
  const requested = layer?.plan
    ? [...locatorPlanSchema.parse(layer.plan).order]
    : legacyPolicyRoutes(legacyEffective, input.textReady)
  const explicit = source === 'step' || source === 'scenario'
  const skipped: LocatorSkip[] = []
  const actual: LocatorRoute[] = []
  for (const route of requested) {
    const reason = !platformAllowed.includes(route) ? 'PLATFORM_LIMIT'
      : !targetAllowed.includes(route) ? 'TARGET_LIMIT'
      : route === 'text_ai' && !input.textReady ? 'TEXT_NOT_READY'
      : route === 'vision_ai' && !input.visionReady ? 'VISION_NOT_READY' : undefined
    if (!reason) { actual.push(route); continue }
    if (explicit) {
      const detail = reason === 'TEXT_NOT_READY' ? '平台 AI 文本模型未就绪，请检查启用状态、地址、模型和绑定密钥'
        : reason === 'VISION_NOT_READY' ? '浏览器 AI 视觉模型未就绪，请检查启用状态、地址、模型和绑定密钥'
        : reason === 'TARGET_LIMIT' ? '目标系统定位能力上限不允许此路线' : '平台定位能力上限不允许此路线'
      throw new LocatorPlanError(`${detail}：${LOCATOR_ROUTE_LABELS[route]}`, route)
    }
    skipped.push({ route, reason })
  }
  if (actual.length === 0) throw new LocatorPlanError('定位计划没有可用路线，请检查平台 AI / 浏览器 AI 配置与能力上限')
  return { requested, actual, skipped, allowed, source }
}

export function locatorReadiness(document: PlatformConfigDocument): { textReady: boolean; visionReady: boolean } {
  return {
    textReady: Boolean(document.platformAi.enabled && document.platformAi.baseUrl && document.platformAi.model && document.platformAi.secretRef),
    visionReady: Boolean(document.browserAi.enabled && document.browserAi.baseUrl && document.browserAi.model && document.browserAi.modelFamily && document.browserAi.secretRef),
  }
}

export function resolveLocatorPlansForSteps(input: {
  steps: readonly { id: string; type?: string; input?: unknown; disabled?: boolean; policy?: { locatorPlan?: LocatorPlan; resolution?: ResolutionPolicy } }[]
  document: PlatformConfigDocument
  target?: TargetResolutionPolicy | null
  scenarioPlan?: LocatorPlan
  scenarioPolicy?: ResolutionPolicy
}): Record<string, LocatorResolution> {
  const readiness = locatorReadiness(input.document)
  const platform = {
    plan: input.document.locator?.defaultPlan,
    limits: input.document.locator?.limits,
    defaultPolicy: input.document.browserAi.defaultResolution,
    ceiling: input.document.browserAi.resolutionCeiling,
  }
  const target = input.target ? {
    plan: input.target.plan,
    limits: input.target.limits,
    policy: input.target.preference,
    ceiling: input.target.ceiling,
  } : undefined
  const out: Record<string, LocatorResolution> = {}
  for (const step of input.steps) {
    if (step.disabled || !stepHasActionTarget(step)) continue
    out[step.id] = resolveLocatorPlan({
      platform,
      target,
      scenario: { plan: input.scenarioPlan, policy: input.scenarioPolicy },
      step: { plan: step.policy?.locatorPlan, policy: step.policy?.resolution },
      ...readiness,
    })
  }
  return out
}

/** 不给导航、显式 AI 步骤或规则成功条件预留模型定位预算。 */
export function stepHasActionTarget(step: { type?: string; input?: unknown }): boolean {
  if (step.type === 'assert') return false
  if (step.input === undefined) return true
  return Boolean(step.input && typeof step.input === 'object' && 'target' in step.input && step.input.target)
}

/** 新修订使用 v2；旧字段保留给尚未升级的已发布场景。 */
export function upgradePlatformLocatorConfig(document: PlatformConfigDocument): PlatformConfigDocument {
  if (document.locator) return document
  const effective = mergeEffectiveResolution({
    ceiling: document.browserAi.resolutionCeiling,
    defaultResolution: document.browserAi.defaultResolution,
    browserAiEnabled: document.browserAi.enabled,
  })
  return {
    ...document,
    locator: {
      defaultPlan: { v: 2, order: legacyPolicyRoutes(effective, locatorReadiness(document).textReady && locatorReadiness(document).visionReady) },
      limits: { v: 2, allowed: legacyCeilingRoutes(document.browserAi.resolutionCeiling) },
    },
  }
}

/** 编辑旧草稿时升级其显式 v1 设置；未设置的层继续继承平台/目标。 */
export function upgradeAuthoringLocatorDocument(input: {
  document: ScenarioAuthoringDocumentV2
  platform: PlatformConfigDocument
  target?: TargetResolutionPolicy | null
}): ScenarioAuthoringDocumentV2 {
  const { document, platform, target } = input
  const textReady = locatorReadiness(platform).textReady && locatorReadiness(platform).visionReady
  const oldPolicy = (step?: ResolutionPolicy): ResolutionPolicy => mergeEffectiveResolution({
    ceiling: platform.browserAi.resolutionCeiling,
    defaultResolution: platform.browserAi.defaultResolution,
    targetCeiling: target?.ceiling,
    targetPreference: target?.preference,
    document: document.resolution,
    step,
    browserAiEnabled: platform.browserAi.enabled,
  })
  const convertNodes = (nodes: AuthoringNode[]): AuthoringNode[] => nodes.map((node): AuthoringNode => {
    if (node.kind === 'step') {
      const policy = node.step.policy
      if (!policy?.resolution) return node
      const { resolution: _old, ...rest } = policy
      return { ...node, step: {
        ...node.step,
        policy: { ...rest, locatorPlan: { v: 2, order: legacyPolicyRoutes(oldPolicy(policy.resolution), textReady) } },
      } } as AuthoringNode
    }
    if (node.kind !== 'block') return node
    if ('then' in node) {
      return { ...node, then: convertNodes(node.then), ...(node.else ? { else: convertNodes(node.else) } : {}) }
    }
    return { ...node, body: convertNodes(node.body) }
  })
  const { resolution: _old, ...rest } = document
  return {
    ...rest,
    locatorProtocol: 2,
    ...(document.locatorPlan ? { locatorPlan: document.locatorPlan }
      : document.resolution ? { locatorPlan: { v: 2, order: legacyPolicyRoutes(oldPolicy(), textReady) } } : {}),
    nodes: convertNodes(document.nodes),
  }
}
