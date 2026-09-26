import type {
  FrozenMapJob,
  FrozenTargetAccessPolicy,
  TargetAccessPolicy,
  TargetAccessPurpose,
  TargetAccessRule,
} from './map-jobs.js'

export type NormalizedAccessPath =
  | { kind: 'all' }
  | { kind: 'prefix'; value: string }
  | { kind: 'invalid' }

export type CompiledAllowlistEntry = {
  origin: string
  pathPrefix?: string
  exact?: boolean
}

export type CompiledAccessScope = {
  purposes: TargetAccessPurpose[]
  rules: TargetAccessRule[]
  extraAllowlist?: CompiledAllowlistEntry[]
}

const ACCESS_PURPOSES_USER: TargetAccessPurpose[] = ['business_surface', 'authentication']
const ACCESS_PURPOSES_MAP_JOB: TargetAccessPurpose[] = ['business_surface']

export function isPublishedAccessPathPrefix(value: string): boolean {
  return value.startsWith('/') && value.length <= 512 && !/[?#]/.test(value)
}

export function normalizeAccessPathPrefix(raw: string | undefined): NormalizedAccessPath {
  if (raw == null) return { kind: 'all' }
  let value = raw.trim()
  if (!value) return { kind: 'invalid' }
  const cut = value.search(/[?#]/)
  if (cut >= 0) value = value.slice(0, cut)
  if (!value) return { kind: 'invalid' }
  if (!value.startsWith('/')) value = `/${value}`
  if (value.length > 512) return { kind: 'invalid' }
  return { kind: 'prefix', value }
}

export function accessPathMatches(pathname: string, prefix: string): boolean {
  if (prefix === '/') return true
  const normalized = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  return pathname === normalized || pathname.startsWith(`${normalized}/`)
}

export function accessPathMatchesExact(pathname: string, prefix: string): boolean {
  const normalized = prefix === '/' ? '/' : prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (normalized === '/') return pathname === '/' || pathname === ''
  return pathname === normalized || pathname === `${normalized}/`
}

export function parseHttpUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function canonicalOrigin(value: string): string | null {
  try {
    const parsed = new URL(value)
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

function ruleMatchesPath(pathname: string, rawPrefix: string | undefined): boolean {
  const normalized = normalizeAccessPathPrefix(rawPrefix)
  if (normalized.kind === 'invalid') return false
  if (normalized.kind === 'all') return true
  return accessPathMatches(pathname, normalized.value)
}

function isOriginWideDeny(rule: TargetAccessRule): boolean {
  const normalized = normalizeAccessPathPrefix(rule.pathPrefix)
  return normalized.kind === 'all' || (normalized.kind === 'prefix' && normalized.value === '/')
}

function urlAllowedForPurpose(parsed: URL, rules: readonly TargetAccessRule[], purpose: TargetAccessPurpose): boolean {
  const relevant = rules.filter((rule) => rule.purpose === purpose && canonicalOrigin(rule.origin) === parsed.origin)
  if (relevant.some((rule) => rule.effect === 'deny' && ruleMatchesPath(parsed.pathname, rule.pathPrefix))) {
    return false
  }
  return relevant.some((rule) => rule.effect === 'allow' && ruleMatchesPath(parsed.pathname, rule.pathPrefix))
}

export function urlAllowedByAccessRules(
  url: string,
  rules: readonly TargetAccessRule[],
  purposes: readonly TargetAccessPurpose[],
): boolean {
  const parsed = parseHttpUrl(url)
  if (!parsed) return false
  return purposes.some((purpose) => urlAllowedForPurpose(parsed, rules, purpose))
}

export function originsForAccessPurposes(
  policy: TargetAccessPolicy | null | undefined,
  purposes: readonly TargetAccessPurpose[],
): string[] {
  if (!policy) return []
  const denied = new Set<string>()
  for (const rule of policy.rules) {
    if (rule.effect !== 'deny' || !purposes.includes(rule.purpose)) continue
    const origin = canonicalOrigin(rule.origin)
    if (origin && isOriginWideDeny(rule)) denied.add(origin)
  }
  const allowed: string[] = []
  for (const rule of policy.rules) {
    if (rule.effect !== 'allow' || !purposes.includes(rule.purpose)) continue
    const origin = canonicalOrigin(rule.origin)
    if (!origin || denied.has(origin)) continue
    allowed.push(origin)
  }
  return [...new Set(allowed)]
}

export function compileAccessScopeFromOrigins(origins: readonly string[]): CompiledAccessScope {
  return {
    purposes: ['business_surface'],
    rules: origins.flatMap((origin) => {
      const canonical = canonicalOrigin(origin) ?? origin
      return [{ origin: canonical, purpose: 'business_surface' as const, effect: 'allow' as const }]
    }),
  }
}

function extraEntryMatches(parsed: URL, entry: CompiledAllowlistEntry): boolean {
  const origin = canonicalOrigin(entry.origin)
  if (!origin || parsed.origin !== origin) return false
  const normalized = normalizeAccessPathPrefix(entry.pathPrefix)
  if (normalized.kind === 'invalid') return false
  if (normalized.kind === 'all') return !entry.exact
  return entry.exact
    ? accessPathMatchesExact(parsed.pathname, normalized.value)
    : accessPathMatches(parsed.pathname, normalized.value)
}

export function urlAllowedByCompiledScope(url: string, scope: CompiledAccessScope): boolean {
  if (!urlAllowedByAccessRules(url, scope.rules, scope.purposes)) return false
  if (!scope.extraAllowlist?.length) return true
  const parsed = parseHttpUrl(url)
  if (!parsed) return false
  return scope.extraAllowlist.some((entry) => extraEntryMatches(parsed, entry))
}

export function compileAccessScopeFromSnapshot(snapshot: {
  accessPolicy?: FrozenTargetAccessPolicy | null
  allowedOrigins?: readonly string[] | null
  mapJob?: Pick<FrozenMapJob, 'jobId'> | null
}): CompiledAccessScope {
  const mapJob = Boolean(snapshot.mapJob?.jobId)
  const purposes = mapJob ? ACCESS_PURPOSES_MAP_JOB : ACCESS_PURPOSES_USER
  const rules = snapshot.accessPolicy?.policy.rules
    ?? compileAccessScopeFromOrigins(snapshot.allowedOrigins ?? []).rules
  return { purposes: [...purposes], rules }
}
