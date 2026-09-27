import type { BrowserContext, Dialog, Page, Route } from 'playwright'
import {
  accessPathMatchesExact,
  isUnsafeActionText,
  sanitizeExplorationUrl,
  urlAllowedByAccessRules,
  type TargetAccessPolicy,
} from '@cairn/shared'

/** Browser traffic in a map ingestion is denied unless it satisfies this guard. */
export type ExploreGuardOptions = {
  allowedOrigins: string[]
  accessPolicy?: TargetAccessPolicy
  allowedSpaHashPrefixes?: string[]
  /** Only map ingestion may use target-level bounded POST inference. */
  allowInferredReadPosts?: boolean
  pageKey?: () => string | undefined
}

export type BlockedRequestRecord = {
  url: string
  method: string
  resourceType: string
  reason: string
  /** A non-content rule changes completeness only; the request is still aborted and audited. */
  impactBasis?: 'unclassified' | 'unreadable_ping' | 'verified_non_content_rule'
  pageKey?: string
  timestamp: string
}

export type InferredReadPostRecord = {
  url: string
  resourceType: 'xhr' | 'fetch'
  pageKey?: string
  timestamp: string
}

/** Unclassified XHR/fetch is always a possible gap in the captured page. */
export function affectsCapturedSurface(request: Pick<BlockedRequestRecord, 'resourceType' | 'impactBasis'>): boolean {
  return request.resourceType !== 'ping' && request.impactBasis !== 'verified_non_content_rule'
}

const OUT_OF_SCOPE_DATA = '数据请求不在业务授权范围'
const UNKNOWN_POST = 'POST 未命中只读规则'

export function blockedRequestImpactBasis(
  request: Pick<BlockedRequestRecord, 'url' | 'method' | 'resourceType' | 'reason'>,
  policy: TargetAccessPolicy | undefined,
): NonNullable<BlockedRequestRecord['impactBasis']> {
  if (request.resourceType === 'ping') return 'unreadable_ping'
  if (request.method !== 'POST' || !['xhr', 'fetch'].includes(request.resourceType)
    || (request.reason !== UNKNOWN_POST && request.reason !== OUT_OF_SCOPE_DATA)) return 'unclassified'
  let parsed: URL
  try { parsed = new URL(request.url) } catch { return 'unclassified' }
  if (isUnsafeActionText(parsed.pathname)) return 'unclassified'
  const match = policy?.verifiedNonContentRequests?.some(rule => rule.method === request.method
    && rule.resourceType === request.resourceType && new URL(rule.origin).origin === parsed.origin
    && accessPathMatchesExact(parsed.pathname, rule.pathPattern))
  return match ? 'verified_non_content_rule' : 'unclassified'
}

export type DialogRecord = { type: string; message: string; timestamp: string }
export interface ExploreGuardController {
  wasDialogEncountered(): boolean
  getDialogs(): readonly DialogRecord[]
  getBlockedRequests(): readonly BlockedRequestRecord[]
  getInferredReadPosts(): readonly InferredReadPostRecord[]
  uninstall(): Promise<void>
}

const STATIC_RESOURCES = new Set(['stylesheet', 'image', 'media', 'font', 'script', 'texttrack'])
type Decision = { allowed: true; basis?: 'graphql_query' | 'declared_read_post' | 'inferred_read_post' }
  | { allowed: false; reason: string }

const READ_INTENT = new Set([
  'get', 'list', 'find', 'search', 'query', 'fetch', 'load', 'count', 'stat', 'stats',
  'detail', 'details', 'info', 'tree', 'trend', 'summary', 'overview', 'report', 'analysis',
  'analyse', 'analyze', 'lookup', 'page', 'pages',
])
const WRITE_INTENT = new Set([
  'create', 'add', 'insert', 'update', 'patch', 'upsert', 'remove', 'delete', 'destroy',
  'save', 'submit', 'upload', 'download', 'export', 'import', 'send', 'trigger', 'execute',
  'run', 'restart', 'reboot', 'reset', 'start', 'stop', 'shutdown', 'approve', 'publish',
  'pay', 'charge', 'enable', 'disable', 'grant', 'revoke', 'invite', 'issue', 'assign',
  'bind', 'unbind', 'sync', 'mark', 'ack', 'track', 'collect', 'beacon', 'telemetry',
  'log', 'logger', 'record', 'login', 'logout', 'mutation', 'mutate', 'increment',
  'consume', 'touch', 'visit', 'register', 'subscribe', 'unsubscribe',
])
const OPERATION_KEYS = new Set(['action', 'operation', 'command', 'method', 'operationname'])
const READ_BODY_KEYS = new Set([
  'page', 'pagenum', 'pagenumber', 'pagesize', 'limit', 'offset', 'sort', 'sortby',
  'filter', 'filters', 'search', 'query', 'keyword', 'criteria',
])

function intentTokens(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/).filter(Boolean).map(token => token.toLowerCase())
}

/** This is a bounded risk inference, never proof that the remote handler is side-effect free. */
function balancedReadPostCandidate(input: {
  url: URL; resourceType: string; contentType: string; body: string | null
}): boolean {
  if (input.resourceType !== 'xhr' && input.resourceType !== 'fetch') return false
  if (!input.body || input.body.length > 16_384 || isUnsafeActionText(input.url.search)) return false
  const pathTokens = intentTokens(input.url.pathname)
  if (pathTokens.some(token => WRITE_INTENT.has(token))) return false
  let fields: Record<string, unknown>
  if (input.contentType.includes('json')) {
    try {
      const body: unknown = JSON.parse(input.body)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return false
      fields = body as Record<string, unknown>
    } catch { return false }
  } else if (input.contentType.includes('application/x-www-form-urlencoded')) {
    fields = Object.create(null) as Record<string, unknown>
    for (const [key, value] of new URLSearchParams(input.body)) {
      if (Object.hasOwn(fields, key)) return false
      fields[key] = value
    }
  } else return false
  let readBodySignal = false
  let checked = 0
  const stack: Array<{ value: object; depth: number }> = [{ value: fields, depth: 0 }]
  while (stack.length) {
    const { value, depth } = stack.pop()!
    for (const [key, field] of Object.entries(value)) {
      if (++checked > 128) return false
      const tokens = intentTokens(key)
      if (tokens.some(token => WRITE_INTENT.has(token)) || tokens.includes('sql') || tokens.includes('file')) return false
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (READ_BODY_KEYS.has(normalized)) readBodySignal = true
      if (normalized === 'query' && typeof field === 'string'
        && /^\s*(?:insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i.test(field)) return false
      if (OPERATION_KEYS.has(normalized) && typeof field === 'string') {
        const operationTokens = intentTokens(field)
        if (operationTokens.some(token => WRITE_INTENT.has(token))) return false
        if (operationTokens.some(token => READ_INTENT.has(token))) readBodySignal = true
      }
      if (field && typeof field === 'object') {
        if (depth >= 4) return false
        stack.push({ value: field, depth: depth + 1 })
      }
    }
  }
  return pathTokens.some(token => READ_INTENT.has(token) || /^top\d+$/.test(token)) || readBodySignal
}

/** Tiny operation scanner: strips comments and strings, then inspects top-level definitions. */
export function onlyGraphqlQueries(source: string): boolean {
  let clean = ''
  for (let i = 0; i < source.length;) {
    if (source[i] === '#') {
      while (i < source.length && source[i] !== '\n') i++
      clean += ' '
      continue
    }
    if (source.slice(i, i + 3) === '"""') {
      const end = source.indexOf('"""', i + 3)
      if (end < 0) return false
      i = end + 3
      clean += ' '
      continue
    }
    if (source[i] === '"') {
      i++
      let closed = false
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue }
        if (source[i++] === '"') { closed = true; break }
      }
      if (!closed) return false
      clean += ' '
      continue
    }
    clean += source[i++]
  }
  const tokens = clean.match(/\.\.\.|[A-Za-z_][A-Za-z_0-9]*|[{}()[\]:!@$=|]/g) ?? []
  let index = 0
  let operations = 0
  while (index < tokens.length) {
    const head = tokens[index]
    if (head === 'fragment' || head === 'query') {
      if (head === 'query') operations++
      index++
      while (index < tokens.length && tokens[index] !== '{') index++
    } else if (head === '{') operations++
    else return false
    if (tokens[index] !== '{') return false
    let depth = 0
    do {
      if (tokens[index] === '{') depth++
      if (tokens[index] === '}') depth--
      index++
    } while (index < tokens.length && depth > 0)
    if (depth !== 0) return false
  }
  return operations > 0
}

function graphqlPost(contentType: string, body: string | null, pathIsGraphql: boolean): { graphql: boolean; queriesOnly: boolean } {
  if (contentType.includes('application/graphql')) return { graphql: true, queriesOnly: !!body && onlyGraphqlQueries(body) }
  if (!contentType.includes('json') || !body) return { graphql: false, queriesOnly: false }
  try {
    const parsed: unknown = JSON.parse(body)
    const batch = Array.isArray(parsed) ? parsed : [parsed]
    if (!batch.length) return { graphql: true, queriesOnly: false }
    const isGraphql = pathIsGraphql || batch.some(item => item && typeof item === 'object'
      && ('extensions' in item || 'operationName' in item
        || ('query' in item && typeof item.query === 'string'
          && /^\s*(?:#|query\b|mutation\b|subscription\b|fragment\b|\{)/.test(item.query))))
    if (!isGraphql) return { graphql: false, queriesOnly: false }
    return { graphql: true, queriesOnly: batch.every(item => item && typeof item === 'object'
      && 'query' in item && typeof item.query === 'string' && onlyGraphqlQueries(item.query)) }
  } catch { return { graphql: false, queriesOnly: false } }
}

export function classifyReadOnlyRequest(input: {
  url: string
  method: string
  resourceType: string
  navigation: boolean
  contentType?: string
  postData?: string | null
}, options: ExploreGuardOptions): Decision {
  const method = input.method.toUpperCase()
  if (input.resourceType === 'websocket' || input.resourceType === 'eventsource')
    return { allowed: false, reason: '实时双向或流式请求被阻断' }
  if (input.navigation || input.resourceType === 'document') {
    if (method !== 'GET' && method !== 'HEAD') return { allowed: false, reason: '导航只能使用 GET/HEAD' }
    const safe = sanitizeExplorationUrl(input.url, undefined, { allowedSpaHashPrefixes: options.allowedSpaHashPrefixes })
    if (!safe.ok) return { allowed: false, reason: '导航地址不安全：' + safe.reason }
    const allowed = options.accessPolicy
      ? urlAllowedByAccessRules(input.url, options.accessPolicy.rules, ['business_surface'])
      : options.allowedOrigins.includes(new URL(input.url).origin)
    return allowed ? { allowed: true } : { allowed: false, reason: '导航地址不在业务授权范围' }
  }
  if (STATIC_RESOURCES.has(input.resourceType))
    return method === 'GET' || method === 'HEAD'
      ? { allowed: true } : { allowed: false, reason: '静态资源请求只能使用 GET/HEAD' }
  let parsed: URL
  try { parsed = new URL(input.url) } catch { return { allowed: false, reason: '请求地址无效' } }
  const allowed = options.accessPolicy
    ? urlAllowedByAccessRules(input.url, options.accessPolicy.rules, ['business_surface'])
    : options.allowedOrigins.includes(parsed.origin)
  if (!allowed) return { allowed: false, reason: OUT_OF_SCOPE_DATA }
  if (isUnsafeActionText(parsed.pathname)) return { allowed: false, reason: '路径疑似写操作' }
  if (method === 'GET' || method === 'HEAD') return { allowed: true }
  if (method !== 'POST') return { allowed: false, reason: method + ' 写请求被阻断' }
  const gql = graphqlPost(input.contentType?.toLowerCase() ?? '', input.postData ?? null,
    parsed.pathname.toLowerCase().includes('graphql'))
  if (gql.graphql) return gql.queriesOnly
    ? { allowed: true, basis: 'graphql_query' } : { allowed: false, reason: 'GraphQL 非 query 或无法解析' }
  if (parsed.pathname.toLowerCase().includes('graphql'))
    return { allowed: false, reason: 'GraphQL 请求缺少可验证的 query 文本' }
  const allowedPost = options.accessPolicy?.readOnlyRequests.some(rule => rule.method === 'POST'
    && new URL(rule.origin).origin === parsed.origin && accessPathMatchesExact(parsed.pathname, rule.pathPattern))
  if (allowedPost) return { allowed: true, basis: 'declared_read_post' }
  if (options.allowInferredReadPosts && options.accessPolicy?.postReadMode === 'balanced' && balancedReadPostCandidate({
    url: parsed, resourceType: input.resourceType,
    contentType: input.contentType?.toLowerCase() ?? '', body: input.postData ?? null,
  })) return { allowed: true, basis: 'inferred_read_post' }
  return { allowed: false, reason: UNKNOWN_POST }
}

function redactedUrl(value: string): string {
  try {
    const url = new URL(value)
    return (url.origin + url.pathname).slice(0, 512)
  } catch { return value.split('?')[0]!.slice(0, 512) }
}

export async function installExploreGuard(context: BrowserContext, options: ExploreGuardOptions): Promise<ExploreGuardController> {
  const blockedRequests: BlockedRequestRecord[] = []
  const inferredReadPosts: InferredReadPostRecord[] = []
  const dialogs: DialogRecord[] = []
  const onDialog = (dialog: Dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 256), timestamp: new Date().toISOString() })
    void dialog.dismiss().catch(() => {})
  }
  for (const page of context.pages()) page.on('dialog', onDialog)
  const onPage = (page: Page) => page.on('dialog', onDialog)
  context.on('page', onPage)
  const routeHandler = async (route: Route) => {
    const request = route.request()
    const result = classifyReadOnlyRequest({
      url: request.url(), method: request.method(), resourceType: request.resourceType(),
      navigation: request.isNavigationRequest(), contentType: request.headers()['content-type'], postData: request.postData(),
    }, options)
    if (result.allowed) {
      if (result.basis === 'inferred_read_post') inferredReadPosts.push({
        url: redactedUrl(request.url()), resourceType: request.resourceType() as 'xhr' | 'fetch',
        pageKey: options.pageKey?.(), timestamp: new Date().toISOString(),
      })
      await route.continue().catch(() => {})
      return
    }
    const blocked = {
      url: redactedUrl(request.url()), method: request.method().toUpperCase(), resourceType: request.resourceType(),
      reason: result.reason, pageKey: options.pageKey?.(), timestamp: new Date().toISOString(),
    }
    blockedRequests.push({ ...blocked, impactBasis: blockedRequestImpactBasis(blocked, options.accessPolicy) })
    await route.abort('blockedbyclient').catch(() => {})
  }
  await context.route('**/*', routeHandler)
  return {
    wasDialogEncountered: () => dialogs.length > 0,
    getDialogs: () => dialogs,
    getBlockedRequests: () => blockedRequests,
    getInferredReadPosts: () => inferredReadPosts,
    async uninstall() {
      context.off('page', onPage)
      for (const page of context.pages()) page.off('dialog', onDialog)
      await context.unroute('**/*', routeHandler).catch(() => {})
    },
  }
}
