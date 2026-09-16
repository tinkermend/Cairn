import {
  MAP_IDENTITY_RULE_VERSION,
  MAP_ROUTE_RULE_VERSION,
  type MapIdentityAlias,
  type MapMatchResult,
  type MapObservation,
  type MapPageKind,
  type MapProjectionObjectState,
  type MapProjectionPageState,
} from '@cairn/shared'

const ROUTING_PARAMS = new Set(['module', 'tab', 'page', 'view', 'section', 'menu'])
const INSTANCE_PARAMS = new Set(['id', 'orderid', 'order_id', 'rowid', 'itemid', 'entityid', 'uuid'])
const SENSITIVE_PARAMS = new Set(['token', 'session', 'sid', 'jwt', 'access_token', 'auth'])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DIGITS_RE = /^\d{2,}$/

export type ClassifiedRoute = {
  kind: MapPageKind
  routeToken: string
  routeTemplate: string
  frameKey: string
  allocationKey: string
  reasons: string[]
}

function sanitize(value: string, max = 80): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
  return cleaned || 'x'
}

function fitKey(parts: string[], max = 192): string {
  let key = parts.join(':')
  if (key.length <= max) return key
  const keep = parts.slice()
  const routeIndex = keep.findIndex((part, index) => index >= 3 && part.length > 16)
  if (routeIndex >= 0) {
    const overflow = key.length - max
    keep[routeIndex] = keep[routeIndex]!.slice(0, Math.max(8, keep[routeIndex]!.length - overflow))
  }
  key = keep.join(':')
  return key.length <= max ? key : key.slice(0, max)
}

function pageKind(framePathLength: number): MapPageKind {
  if (framePathLength <= 0) return 'top'
  if (framePathLength === 1) return 'frame_primary'
  return 'composite'
}

export function classifyRoute(input: {
  url: string
  framePathLength?: number
  frameName?: string
}): ClassifiedRoute {
  const kind = pageKind(input.framePathLength ?? 0)
  const frameKey = sanitize(input.frameName || (kind === 'top' ? 'top' : 'frame'), 32)
  const reasons = [`ruleVersion:${MAP_ROUTE_RULE_VERSION}`]
  let parsed: URL | undefined
  try {
    parsed = new URL(input.url)
  } catch {
    const token = sanitize(input.url, 64)
    const allocationKey = fitKey(['page', 'v1', kind, token, frameKey])
    return {
      kind,
      routeToken: token,
      routeTemplate: token,
      frameKey,
      allocationKey,
      reasons: [...reasons, 'url-unparsed'],
    }
  }
  const segments = parsed.pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (UUID_RE.test(segment)) {
        reasons.push('path-uuid-templated')
        return ':uuid'
      }
      if (DIGITS_RE.test(segment)) {
        reasons.push('path-id-templated')
        return ':id'
      }
      return sanitize(segment, 48)
    })
  const kept: string[] = []
  for (const [rawKey, value] of parsed.searchParams.entries()) {
    const key = rawKey.toLowerCase()
    if (SENSITIVE_PARAMS.has(key)) {
      reasons.push(`sensitive-dropped:${sanitize(key, 24)}`)
      continue
    }
    if (INSTANCE_PARAMS.has(key)) {
      reasons.push(`instance-templated:${sanitize(key, 24)}`)
      continue
    }
    if (ROUTING_PARAMS.has(key)) {
      kept.push(`${sanitize(key, 24)}=${sanitize(value, 48)}`)
      reasons.push(`routing-kept:${sanitize(key, 24)}`)
      continue
    }
    kept.push(`${sanitize(key, 24)}=${sanitize(value, 48)}`)
    reasons.push(`unknown-kept:${sanitize(key, 24)}`)
  }
  kept.sort()
  const pathToken = segments.join('.') || 'root'
  const routeToken = kept.length ? `${pathToken}.${kept.join('.')}` : pathToken
  const routeTemplate = `${parsed.origin}${parsed.pathname.split('/').map((segment) => {
    if (!segment) return ''
    if (UUID_RE.test(segment)) return ':uuid'
    if (DIGITS_RE.test(segment)) return ':id'
    return segment
  }).join('/')}${kept.length ? `?${kept.join('&')}` : ''}`
  return {
    kind,
    routeToken,
    routeTemplate: routeTemplate.slice(0, 512),
    frameKey,
    allocationKey: fitKey(['page', 'v1', kind, sanitize(routeToken, 96), frameKey]),
    reasons,
  }
}

export function objectAllocationKey(input: {
  pageAllocationKey: string
  regionKey: string
  stableToken: string
}): string {
  return fitKey([
    'object',
    'v1',
    sanitize(input.pageAllocationKey, 80),
    sanitize(input.regionKey, 32),
    sanitize(input.stableToken, 48),
  ])
}

export function stableObjectToken(input: {
  testId?: string
  role?: string
  name?: string
  sourceEventKey?: string
}): { token: string; reasons: string[] } {
  if (input.testId) return { token: sanitize(`testid-${input.testId}`, 48), reasons: ['stable:testId'] }
  if (input.role && input.name) {
    return { token: sanitize(`role-${input.role}-${input.name}`, 48), reasons: ['stable:role+name'] }
  }
  if (input.name) return { token: sanitize(`name-${input.name}`, 48), reasons: ['stable:name'] }
  return {
    token: sanitize(`pending-${input.sourceEventKey ?? 'unknown'}`, 48),
    reasons: ['stable:pending-source'],
  }
}

export function cluesFromObservation(observation: MapObservation): {
  url: string
  regionKey: string
  testId?: string
  role?: string
  name?: string
  rowBound: boolean
} {
  const predicates = Object.fromEntries(
    observation.semanticSummary.predicates.map((item) => [item.name, item.value]),
  )
  const regionKey =
    observation.regionRefs[0]?.key ??
    (typeof predicates.region === 'string' ? predicates.region : 'region')
  const name =
    typeof predicates.label === 'string'
      ? predicates.label
      : typeof predicates.name === 'string'
        ? predicates.name
        : undefined
  const role = typeof predicates.role === 'string' ? predicates.role : undefined
  const testId = typeof predicates.testId === 'string' ? predicates.testId : undefined
  const rowBound = Boolean(predicates.rowKey || predicates.rowPattern || observation.actionRef?.instanceBinding)
  return {
    url: observation.topUrlPattern,
    regionKey: String(regionKey),
    testId,
    role,
    name,
    rowBound,
  }
}

export function matchPageIdentity(input: {
  observation: MapObservation
  pages: MapProjectionPageState[]
}): {
  allocation: ClassifiedRoute
  matchResult: MapMatchResult
  page?: MapProjectionPageState
  reasons: string[]
} {
  const frameName = input.observation.framePath[0]?.name ?? input.observation.framePath[0]?.urlPattern
  const allocation = classifyRoute({
    url: input.observation.topUrlPattern,
    framePathLength: input.observation.framePath.length,
    frameName,
  })
  const matches = input.pages.filter((page) => page.allocationKey === allocation.allocationKey)
  if (matches.length > 1) {
    return {
      allocation,
      matchResult: 'AMBIGUOUS',
      reasons: [...allocation.reasons, 'equal-page-candidates', `ruleVersion:${MAP_IDENTITY_RULE_VERSION}`],
    }
  }
  if (matches.length === 1) {
    return {
      allocation,
      matchResult: 'MATCH',
      page: matches[0],
      reasons: [...allocation.reasons, 'allocation-key', `ruleVersion:${MAP_IDENTITY_RULE_VERSION}`],
    }
  }
  return {
    allocation,
    matchResult: 'MATCH',
    reasons: [...allocation.reasons, 'discover-page', `ruleVersion:${MAP_IDENTITY_RULE_VERSION}`],
  }
}

export function matchObjectIdentity(input: {
  observation: MapObservation
  pageAllocationKey: string
  objects: MapProjectionObjectState[]
  aliases: MapIdentityAlias[]
}): {
  allocationKey: string
  regionKey: string
  stableToken: string
  matchResult: MapMatchResult
  object?: MapProjectionObjectState
  reasons: string[]
} {
  const clues = cluesFromObservation(input.observation)
  const stable = stableObjectToken({
    testId: clues.testId,
    role: clues.role,
    name: clues.name,
    sourceEventKey: input.observation.sourceEventKey,
  })
  const allocationKey = objectAllocationKey({
    pageAllocationKey: input.pageAllocationKey,
    regionKey: clues.regionKey,
    stableToken: stable.token,
  })
  const aliased = input.aliases.find(
    (alias) => alias.oldAllocationKey === allocationKey || alias.newAllocationKey === allocationKey,
  )
  const resolvedKey = aliased?.newAllocationKey ?? allocationKey
  const sameRegion = input.objects.filter(
    (object) =>
      object.pageAllocationKey === input.pageAllocationKey && object.regionKey === clues.regionKey,
  )
  const exact = input.objects.filter((object) => object.allocationKey === resolvedKey)
  const reasons = [...stable.reasons, `ruleVersion:${MAP_IDENTITY_RULE_VERSION}`]
  if (clues.role && clues.name && !clues.rowBound && sameRegion.length > 1 && exact.length !== 1) {
    return {
      allocationKey: resolvedKey,
      regionKey: clues.regionKey,
      stableToken: stable.token,
      matchResult: 'AMBIGUOUS',
      reasons: [...reasons, 'row-unbound-multiple'],
    }
  }
  if (exact.length > 1) {
    return {
      allocationKey: resolvedKey,
      regionKey: clues.regionKey,
      stableToken: stable.token,
      matchResult: 'AMBIGUOUS',
      reasons: [...reasons, 'equal-object-candidates'],
    }
  }
  if (exact.length === 1) {
    return {
      allocationKey: resolvedKey,
      regionKey: clues.regionKey,
      stableToken: stable.token,
      matchResult: 'MATCH',
      object: exact[0],
      reasons: [...reasons, aliased ? 'identity-alias' : 'allocation-key'],
    }
  }
  if (aliased?.newAllocationKey) {
    const mapped = input.objects.find((object) => object.allocationKey === aliased.newAllocationKey)
    return {
      allocationKey: aliased.newAllocationKey,
      regionKey: clues.regionKey,
      stableToken: stable.token,
      matchResult: 'MATCH',
      object: mapped,
      reasons: [...reasons, 'identity-alias'],
    }
  }
  return {
    allocationKey,
    regionKey: clues.regionKey,
    stableToken: stable.token,
    matchResult: 'MATCH',
    reasons: [...reasons, 'discover-object'],
  }
}
