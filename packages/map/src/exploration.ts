import {
  FACTORY_EXPLORATION_POLICY,
  isUrlInExploreAllowlist,
  observationBundleSchema,
  type ExplorationCandidate,
  type ExplorationGuardDecision,
  type ExplorationPolicy,
  type ExplorationProposal,
  type ObservationBundle,
} from '@cairn/shared'
import { isUnsafeMapActionName } from './jobs.js'

export function seedUrlsForExploration(
  entryUrl: string,
  extras: readonly string[] = [],
): string[] {
  const urls = [entryUrl, ...extras]
  const seen = new Set<string>()
  const unique: string[] = []
  for (const url of urls) {
    try {
      const normalized = new URL(url).toString()
      if (seen.has(normalized)) continue
      seen.add(normalized)
      unique.push(normalized)
    } catch {
      continue
    }
  }
  return unique
}

export function buildObservationBundle(input: {
  currentUrl?: string
  title?: string
  policy: ExplorationPolicy
  seedUrls: readonly string[]
}): ObservationBundle {
  const currentUrl = input.currentUrl ?? ''
  let origin = ''
  try {
    origin = currentUrl ? new URL(currentUrl).origin : ''
  } catch {
    origin = ''
  }
  const allowlisted = currentUrl ? isUrlInExploreAllowlist(currentUrl, input.policy.allowlist) : false
  const candidates: ExplorationCandidate[] = []
  for (const url of input.seedUrls) {
    if (candidates.length >= input.policy.maxCandidates) break
    if (!isUrlInExploreAllowlist(url, input.policy.allowlist)) continue
    if (currentUrl && urlsEqual(url, currentUrl)) continue
    candidates.push({
      id: `nav:${candidates.length + 1}`,
      kind: 'navigate',
      url,
      reason: input.policy.mode === 'seeded_budget' ? '种子外扩一跳' : 'allowlist 内未访问地址',
    })
  }
  return observationBundleSchema.parse({
    currentUrl,
    origin,
    ...(input.title ? { title: input.title } : {}),
    allowlisted,
    allowlist: input.policy.allowlist,
    candidates,
    visited: currentUrl ? [currentUrl] : [],
  })
}

export function proposeExploreHop(observation: ObservationBundle): ExplorationProposal {
  const next = observation.candidates[0]
  if (!next) {
    return { kind: 'stop', reason: 'no_safe_candidate' }
  }
  return {
    kind: 'navigate',
    candidateId: next.id,
    url: next.url,
    reason: next.reason,
  }
}

export function decideExploreGuard(input: {
  proposal: ExplorationProposal
  observation: ObservationBundle
  policy?: ExplorationPolicy
}): ExplorationGuardDecision {
  const policy = input.policy ?? FACTORY_EXPLORATION_POLICY
  if (input.proposal.kind === 'stop') {
    return { decision: 'skip', reason: input.proposal.reason }
  }
  if (input.proposal.kind === 'reveal') {
    return { decision: 'skip', reason: '本轮不派发 reveal' }
  }
  const candidate = input.observation.candidates.find((item) => item.id === input.proposal.candidateId)
  const url = candidate?.url ?? input.proposal.url
  if (!input.proposal.candidateId || !candidate || !url) {
    return { decision: 'stop', reason: '提名必须引用本轮观察候选' }
  }
  if (url !== candidate.url) {
    return { decision: 'stop', reason: '提名 URL 与候选不一致' }
  }
  const allowlist = policy.allowlist.length ? policy.allowlist : input.observation.allowlist
  if (!isUrlInExploreAllowlist(url, allowlist)) {
    return { decision: 'stop', reason: '目标不在探索 allowlist' }
  }
  if (isUnsafeMapActionName(url) || isUnsafeMapActionName(input.proposal.reason)) {
    return { decision: 'stop', reason: '名称或路径像写入动作' }
  }
  return { decision: 'allow', reason: '允许名单内只读导航' }
}

function urlsEqual(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString()
  } catch {
    return left === right
  }
}
