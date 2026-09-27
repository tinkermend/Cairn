import { syncSha256 } from './sha256-sync.js'
import { z } from 'zod'
import { canonicalOrigin, parseHttpUrl } from './access-scope.js'
import type { TargetDescriptor } from './target-descriptor.js'
import { entityIdSchema, utcInstantSchema } from './wire.js'

// ==========================================
// 1. Target State Rule & 3-Level State Keys
// ==========================================

export const routeMatchRuleSchema = z.strictObject({
  pattern: z.string().min(1).max(256),
  name: z.string().min(1).max(128),
  ignoreQueryParams: z.array(z.string().min(1).max(64)).default([]),
})
export type RouteMatchRule = z.infer<typeof routeMatchRuleSchema>

export const stateVariantRuleSchema = z.strictObject({
  key: z.string().min(1).max(64),
  kind: z.enum(['list', 'detail', 'tab', 'other']),
  selector: z.string().min(1).max(256),
  exclusiveWith: z.array(z.string().min(1).max(64)).default([]),
})
export type StateVariantRule = z.infer<typeof stateVariantRuleSchema>

export const targetStateRuleSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  ruleVersion: z.number().int().min(1),
  routeMatches: z.array(routeMatchRuleSchema).default([]),
  readyAssertion: z
    .strictObject({
      selector: z.string().max(256).optional(),
      predicate: z.string().max(256).optional(),
    })
    .default({}),
  variants: z.array(stateVariantRuleSchema).default([]),
  allowedSpaHashPrefixes: z.array(z.string().min(1).max(64)).default(['#/']),
  ignoreQueryParams: z.array(z.string().min(1).max(64)).max(64).default([]),
})
export type TargetStateRule = z.infer<typeof targetStateRuleSchema>

export const targetStateRuleDtoSchema = z.strictObject({
  targetId: entityIdSchema,
  revision: z.number().int().min(0),
  rule: targetStateRuleSchema,
  updatedAt: utcInstantSchema,
})
export type TargetStateRuleDto = z.infer<typeof targetStateRuleDtoSchema>

export const targetStateRuleQueryParamsUpdateBodySchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  ignoreQueryParams: z.array(z.string().trim().min(1).max(64)).max(64)
    .refine(items => new Set(items).size === items.length, '查询参数名称不能重复'),
  reason: z.string().trim().min(1).max(512),
})
export type TargetStateRuleQueryParamsUpdateBody = z.infer<typeof targetStateRuleQueryParamsUpdateBodySchema>

export function normalizeExplorationPath(rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed || trimmed === '/') return '/'
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withLeading.endsWith('/') && withLeading.length > 1 ? withLeading.slice(0, -1) : withLeading
}

export function buildPageKey(input: {
  targetId: string
  url: string
  frame?: string
  allowedSpaHashPrefixes?: readonly string[]
  ignoreQueryParams?: readonly string[]
}): string {
  const parsed = parseHttpUrl(input.url)
  const canonical = parsed ? canonicalOrigin(parsed.origin) ?? '' : ''
  const pathname = parsed ? normalizeExplorationPath(parsed.pathname) : ''
  const ignore = new Set(input.ignoreQueryParams ?? [])
  let hashPart = ''
  if (parsed && parsed.hash && input.allowedSpaHashPrefixes) {
    for (const prefix of input.allowedSpaHashPrefixes) {
      if (parsed.hash.startsWith(prefix)) {
        hashPart = parsed.hash
        if (ignore.size && hashPart.includes('?')) {
          const queryStart = hashPart.indexOf('?')
          const params = new URLSearchParams(hashPart.slice(queryStart + 1))
          for (const key of ignore) params.delete(key)
          const remaining = params.toString()
          hashPart = hashPart.slice(0, queryStart) + (remaining ? '?' + remaining : '')
        }
        break
      }
    }
  }
  let queryPart = ''
  if (parsed && parsed.search) {
    const searchParams = new URLSearchParams(parsed.search)
    const filtered: [string, string][] = []
    for (const [k, v] of searchParams.entries()) {
      if (!ignore.has(k)) filtered.push([k, v])
    }
    filtered.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    if (filtered.length > 0) {
      const q = new URLSearchParams(filtered)
      queryPart = `?${q.toString()}`
    }
  }
  const framePart = input.frame ? `|frame:${input.frame.trim()}` : ''
  return `page:${input.targetId}:${canonical}${pathname}${queryPart}${hashPart}${framePart}`
}

export function buildViewStateKey(input: {
  pageKey: string
  ruleVersion: number
  variantKey?: string
}): string {
  const variant = input.variantKey ? input.variantKey.trim() : 'default'
  return `view:${input.pageKey}:${variant}:v${input.ruleVersion}`
}

export function buildPresentationStateKey(input: {
  viewStateKey: string
  ancestorPath?: readonly string[]
}): string {
  const path = (input.ancestorPath ?? []).map((s) => s.trim()).filter(Boolean)
  const pathStr = path.length > 0 ? path.join(' > ') : 'root'
  const digest = syncSha256(pathStr).slice(0, 16)
  return `pres:${input.viewStateKey}:${digest}`
}

export function computeControlFingerprint(input: {
  role: string
  accessibleName: string
  ancestorPath?: readonly string[]
  frameSelector?: string
  targetUrl?: string
  locatorDescriptor?: TargetDescriptor
}): string {
  const path = (input.ancestorPath ?? []).join('>')
  const descriptorStr = input.locatorDescriptor ? JSON.stringify(input.locatorDescriptor) : ''
  const payload = [
    input.role.toLowerCase().trim(),
    input.accessibleName.trim(),
    path,
    input.frameSelector?.trim() ?? '',
    input.targetUrl?.trim() ?? '',
    descriptorStr,
  ].join('|')
  return syncSha256(payload).slice(0, 32)
}

export const UNSAFE_ACTION_PATTERN = /(提交|保存|删除|审批|支付|发布|上传|下载|导出|注销|退出|重启|重置|停止|启动|submit|save|delete|approve|publish|upload|download|export|logout|signout|write|restart|reboot|reset|stop|shutdown|(?:^|[^a-z])pay(?:$|[^a-z]))/i

export function isUnsafeActionText(text: string): boolean {
  return UNSAFE_ACTION_PATTERN.test(text)
}

export function sanitizeExplorationUrl(
  rawUrl: string,
  baseUrl?: string,
  options?: {
    allowedSpaHashPrefixes?: readonly string[]
  },
): { ok: boolean; canonicalUrl?: string; digest?: string; reason?: string } {
  let resolved: URL
  try {
    resolved = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'URL 格式无法解析' }
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    return { ok: false, reason: '非 HTTP(S) 协议' }
  }
  if (resolved.username || resolved.password) {
    return { ok: false, reason: 'URL 包含认证信息' }
  }
  if (UNSAFE_ACTION_PATTERN.test(resolved.pathname) || UNSAFE_ACTION_PATTERN.test(resolved.search)) {
    return { ok: false, reason: 'URL 疑似写入或危险动作' }
  }
  let allowedHash = ''
  if (resolved.hash && options?.allowedSpaHashPrefixes) {
    for (const prefix of options.allowedSpaHashPrefixes) {
      if (resolved.hash.startsWith(prefix)) {
        allowedHash = resolved.hash
        break
      }
    }
  }
  if (allowedHash && UNSAFE_ACTION_PATTERN.test(allowedHash)) {
    return { ok: false, reason: 'SPA 路由疑似写入或危险动作' }
  }
  const searchParams = new URLSearchParams(resolved.search)
  const SENSITIVE_QUERY = /(token|auth|sign|ticket|session|secret|key|passwd|password)/i
  for (const key of [...searchParams.keys()]) {
    if (SENSITIVE_QUERY.test(key)) {
      searchParams.delete(key)
    }
  }
  const cleanSearch = searchParams.toString() ? `?${searchParams.toString()}` : ''
  const canonicalUrl = `${resolved.origin}${normalizeExplorationPath(resolved.pathname)}${cleanSearch}${allowedHash}`
  const digest = syncSha256(canonicalUrl)
  return { ok: true, canonicalUrl, digest }
}


// ==========================================
// 2. Collected Facts
// ==========================================

export const candidateCategorySchema = z.enum([
  'explicit_url',
  'reveal',
  'opaque_navigation',
])
export type CandidateCategory = z.infer<typeof candidateCategorySchema>

export const exploreEvidenceStatusSchema = z.enum(['complete', 'partial', 'missing'])
export type ExploreEvidenceStatus = z.infer<typeof exploreEvidenceStatusSchema>

export const exploreStateSchema = z.strictObject({
  id: entityIdSchema,
  targetId: entityIdSchema,
  targetAccountId: entityIdSchema,
  jobId: entityIdSchema.optional(),
  runId: entityIdSchema.optional(),
  pageKey: z.string().min(1).max(512),
  viewStateKey: z.string().min(1).max(512),
  presentationStateKey: z.string().min(1).max(512),
  stateRuleVersion: z.number().int().min(1).default(1),
  readiness: z.enum(['ready', 'ambiguous', 'unknown']),
  snapshotData: z.record(z.string(), z.unknown()),
  evidenceRef: z.string().optional(),
  createdAt: utcInstantSchema,
})
export type ExploreState = z.infer<typeof exploreStateSchema>
