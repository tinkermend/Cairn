import type { Page } from 'playwright'
import {
  BROWSER_AI_SDK_VERSION,
  type AiElementBinding,
  type AiPageObservation,
  type AiValueProvenance,
  type JsonValue,
  type RunGrant,
  type SessionGrant,
} from '@cairn/shared'
import { appendAiTaskEvent, type DbHandle } from '@cairn/db'
import { inspectElementCandidate } from '../../browser/element-candidate-inspector.js'

export interface ActionRecorderOptions {
  page: Page
  attemptId: string
  runId: string
  stepRunId: string
  agentInstanceId: string
  grant: RunGrant
  /** 会话租约（含 holderWorkerId），与 Run 租约一起构成事实追加的所有权校验。 */
  sessionLease?: SessionGrant & { holderWorkerId: string }
  db: DbHandle
  runInput?: Record<string, unknown> | JsonValue
  contextBindings?: Map<string, unknown>
  allowedOrigins?: string[]
  sensitiveSelectors?: string[]
}

const sensitiveName =
  /password|passwd|secret|token|authorization|cookie|api[_-]?key|密码|口令|密钥|验证码/i
const sensitiveLiteral =
  /^(?:\*{3,}|•{3,}|\[REDACTED\])$|(?:Bearer\s+[\w.-]+)|(?:sk-[\w-]{16,})|(?:eyJ[\w-]+\.[\w-]+\.[\w-]+)/i
const embeddedSecret =
  /(?:password|passwd|secret|token|api[_-]?key|密码|口令|密钥)\s*(?:[:=：]|为|是)\s*[^\s,，;；]+/i

export function sanitizePageUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    if (!['https:', 'http:'].includes(url.protocol)) return rawUrl
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (sensitiveName.test(key) || sensitiveLiteral.test(url.searchParams.get(key) ?? '')) {
        url.searchParams.delete(key)
      }
    }
    return url.toString()
  } catch {
    return rawUrl
  }
}

export function normalizeUrlPattern(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    const pathname = url.pathname
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
      .replace(/\/\d+(?=\/|$)/g, '/:id')
    return `${url.origin}${pathname}`
  } catch {
    return rawUrl.split('?')[0] || rawUrl
  }
}

/**
 * 从动作参数中提取定位中心与元素描述。
 * 1.12.6：locate.center（或顶层 x/y）是逻辑坐标——SDK 在调用 action 前已用
 * shrunkShotToLogicalRatio 把截图像素换算成视口坐标（见 parseActionParam），直接可用；
 * 元素描述在 locate.description 上（locate.prompt 只在 aiLocate 直连时出现）。
 */
export function extractPointAndDescription(param: unknown): {
  point?: { x: number; y: number } | null
  description?: string | null
} {
  if (!param || typeof param !== 'object') return {}
  const obj = param as Record<string, any>
  let point: { x: number; y: number } | null = null
  let description: string | null = null

  if (typeof obj.x === 'number' && typeof obj.y === 'number') {
    point = { x: obj.x, y: obj.y }
  }

  const locate = obj.locate || obj.target || obj.element
  if (locate && typeof locate === 'object') {
    if (Array.isArray(locate.center) && locate.center.length >= 2) {
      point = { x: locate.center[0], y: locate.center[1] }
    } else if (typeof locate.x === 'number' && typeof locate.y === 'number') {
      point = { x: locate.x, y: locate.y }
    }
    if (typeof locate.description === 'string' && locate.description.trim()) {
      description = locate.description
    } else if (typeof locate.prompt === 'string' && locate.prompt.trim()) {
      description = locate.prompt
    }
  }

  if (!description && typeof obj.prompt === 'string' && obj.prompt.trim()) {
    description = obj.prompt
  }
  if (!description && typeof obj.description === 'string' && obj.description.trim()) {
    description = obj.description
  }

  if (description && description.length > 256) {
    description = description.slice(0, 256)
  }

  return { point, description }
}

export function extractActionValue(param: unknown): unknown {
  if (!param || typeof param !== 'object') return undefined
  const obj = param as Record<string, any>
  if (obj.value !== undefined) return obj.value
  if (obj.text !== undefined) return obj.text
  if (obj.keyName !== undefined) return obj.keyName
  if (obj.key !== undefined) return obj.key
  return undefined
}

export interface ResolveValueProvenanceInput {
  value: unknown
  isSensitiveTarget?: boolean
  elementDescription?: string | null
  contextBindings?: Map<string, unknown>
  runInput?: Record<string, unknown> | JsonValue
}

export function resolveValueProvenance(
  valueOrInput: unknown | ResolveValueProvenanceInput,
  legacyContextBindings?: Map<string, unknown>,
  legacyRunInput?: Record<string, unknown> | JsonValue,
): AiValueProvenance {
  let value: unknown
  let isSensitiveTarget = false
  let elementDescription: string | null = null
  let contextBindings: Map<string, unknown> | undefined
  let runInput: Record<string, unknown> | JsonValue | undefined

  if (
    valueOrInput !== null &&
    typeof valueOrInput === 'object' &&
    'value' in valueOrInput &&
    ('isSensitiveTarget' in valueOrInput ||
      'elementDescription' in valueOrInput ||
      'contextBindings' in valueOrInput ||
      'runInput' in valueOrInput)
  ) {
    const input = valueOrInput as ResolveValueProvenanceInput
    value = input.value
    isSensitiveTarget = Boolean(input.isSensitiveTarget)
    elementDescription = input.elementDescription ?? null
    contextBindings = input.contextBindings
    runInput = input.runInput
  } else {
    value = valueOrInput
    contextBindings = legacyContextBindings
    runInput = legacyRunInput
  }

  if (value === undefined || value === null) {
    return { kind: 'none', source: null, value: null }
  }
  const strVal = typeof value === 'string' ? value : JSON.stringify(value)
  if (!strVal) {
    return { kind: 'none', source: null, value: null }
  }

  // 1. 敏感检查：目标敏感、描述敏感、或字面量命中敏感规则
  if (
    isSensitiveTarget ||
    (elementDescription && sensitiveName.test(elementDescription)) ||
    (typeof value === 'string' && (sensitiveLiteral.test(strVal) || embeddedSecret.test(strVal)))
  ) {
    return { kind: 'redacted', source: 'redacted', value: null }
  }

  // 2. 匹配 input 与 context 来源
  const matches: { type: 'input' | 'context'; key: string }[] = []

  if (runInput && typeof runInput === 'object' && !Array.isArray(runInput)) {
    for (const [key, inVal] of Object.entries(runInput)) {
      if (inVal && typeof inVal === 'object' && (inVal as any).kind === 'file') continue
      if (inVal === value || (typeof inVal === 'string' && inVal === strVal)) {
        matches.push({ type: 'input', key })
      }
    }
  }

  if (contextBindings) {
    for (const [key, ctxVal] of contextBindings.entries()) {
      if (ctxVal === value || (typeof ctxVal === 'string' && ctxVal === strVal)) {
        matches.push({ type: 'context', key })
      }
    }
  }

  // 3. 多来源同时匹配记 ambiguous，不存值
  if (matches.length > 1) {
    return {
      kind: 'ambiguous',
      source: matches.map((m) => `${m.type}:${m.key}`).join(','),
      value: null,
    }
  }

  // 4. 单一来源匹配，仅记 key，不存值
  if (matches.length === 1) {
    const match = matches[0]!
    return {
      kind: match.type,
      source: match.key,
      value: null,
    }
  }

  // 5. 字面量：上限 1 KiB (1024 字节)；超出记 TOO_LONG，不存值
  const byteLength = Buffer.byteLength(strVal, 'utf8')
  if (byteLength > 1024) {
    return {
      kind: 'literal',
      source: 'TOO_LONG',
      value: null,
    }
  }

  return {
    kind: 'literal',
    source: 'literal',
    value: strVal,
  }
}

export function extractParamsSummary(param: unknown): Record<string, JsonValue> | null {
  if (!param || typeof param !== 'object') return null
  const summary: Record<string, JsonValue> = {}
  for (const [k, v] of Object.entries(param as Record<string, unknown>)) {
    if (k === 'locate' || k === 'target' || k === 'element') {
      const loc = v as any
      if (loc && typeof loc === 'object') {
        summary[k] = {
          center: Array.isArray(loc.center) ? (loc.center as [number, number]) : null,
          description:
            typeof loc.description === 'string' && loc.description
              ? loc.description
              : typeof loc.prompt === 'string' && loc.prompt
                ? loc.prompt
                : null,
        }
      }
      continue
    }
    // 敏感字段与输入值（value / text）必须由 valueProvenance 独立治理与脱敏，严禁在 paramsSummary 中明文沉淀
    if (k === 'value' || k === 'text' || sensitiveName.test(k)) {
      continue
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      summary[k] = v
    } else if (v === null) {
      summary[k] = null
    }
  }
  return Object.keys(summary).length > 0 ? summary : null
}

export async function capturePageObservation(page: Page, documentEpoch: number): Promise<AiPageObservation> {
  const url = sanitizePageUrl(page.url())
  const readyState = await page
    .evaluate(() => (globalThis as any).document?.readyState ?? 'complete')
    .catch(() => 'complete')
  return {
    url,
    urlPattern: normalizeUrlPattern(url),
    documentEpoch,
    readyState,
    timestamp: new Date().toISOString(),
  }
}

/**
 * 动作事实录制器。
 *
 * 拦截分两处（1.12.6 的假设，升级须重跑 AP06 探针）：
 * - 派发边（wrapActionSpace 的 action.call）：参数已由 SDK 换算为逻辑坐标，
 *   在此做派发前点检并提交 prepared，动作抛错在此补 failed；
 * - 收尾边（PlaywrightWebPage 构造参数 afterInvokeAction）：SDK 等完导航与网络空闲后
 *   回调，在此提交 completed、写请求信号与动作后页面观察。
 *
 * 经 fullActionSpace 追加的动作（如 Sleep）没有派发边回调，只有收尾边：completed 单独成事件，
 * binding 记 not_applicable。
 */
export class ActionRecorder {
  private ordinalSequence = 0
  private pendingOrdinal: number | null = null
  private pendingActionName: string | null = null
  private actionStartTime = 0
  private currentWriteSignalCount = 0
  private currentWriteSignalPaths: string[] = []
  private currentPageBefore: AiPageObservation | null = null
  private currentElementDescription: string | null = null
  private currentBinding: AiElementBinding | null = null
  private currentValueProvenance: AiValueProvenance | null = null
  private currentParamsSummary: Record<string, JsonValue> | null = null
  private documentEpoch = 1
  private isDestroyed = false

  private onRequest = (request: any) => {
    try {
      const method = (request.method?.() ?? '').toUpperCase()
      if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
      const urlStr = request.url?.()
      if (!urlStr) return
      const parsed = new URL(urlStr)
      const allowed = this.opts.allowedOrigins
      if (allowed && allowed.length > 0 && !allowed.includes(parsed.origin)) {
        return // 忽略第三方源请求
      }
      const pathPattern = parsed.pathname
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
        .replace(/\/\d+(?=\/|$)/g, '/:id')
      const signal = `${method} ${pathPattern}`
      this.currentWriteSignalCount++
      if (this.currentWriteSignalPaths.length < 5 && !this.currentWriteSignalPaths.includes(signal)) {
        this.currentWriteSignalPaths.push(signal)
      }
    } catch {}
  }

  private onNavigated = (frame: any) => {
    try {
      if (frame === this.opts.page.mainFrame()) this.documentEpoch += 1
    } catch {}
  }

  constructor(private readonly opts: ActionRecorderOptions) {
    try {
      this.opts.page.on('request', this.onRequest)
      this.opts.page.on('framenavigated', this.onNavigated)
    } catch {}
  }

  destroy(): void {
    if (this.isDestroyed) return
    this.isDestroyed = true
    try {
      this.opts.page.removeListener('request', this.onRequest)
      this.opts.page.removeListener('framenavigated', this.onNavigated)
    } catch {}
  }

  /** 派发边：参数为逻辑坐标。点检、prepared 提交都发生在动作真正发出之前。 */
  async onDispatch(actionName: string, param: unknown): Promise<void> {
    const ordinal = this.ordinalSequence++
    this.pendingOrdinal = ordinal
    this.pendingActionName = actionName
    this.actionStartTime = Date.now()
    this.currentWriteSignalCount = 0
    this.currentWriteSignalPaths = []
    this.currentElementDescription = null
    this.currentBinding = null
    this.currentValueProvenance = null
    this.currentParamsSummary = null

    this.currentPageBefore = await capturePageObservation(this.opts.page, this.documentEpoch)

    const { point, description } = extractPointAndDescription(param)
    const binding = await inspectElementCandidate({
      page: this.opts.page,
      point,
      actionName,
      elementDescription: description,
      sensitiveSelectors: this.opts.sensitiveSelectors,
      contextValues: this.contextValues(),
    })
    this.currentBinding = binding

    const isSensitiveTarget = binding.reason === 'SENSITIVE_TARGET'
    this.currentElementDescription = isSensitiveTarget ? null : (description ?? null)

    this.currentValueProvenance = resolveValueProvenance({
      value: extractActionValue(param),
      isSensitiveTarget,
      elementDescription: description,
      contextBindings: this.opts.contextBindings,
      runInput: this.opts.runInput,
    })
    this.currentParamsSummary = extractParamsSummary(param)

    await appendAiTaskEvent(this.opts.db, {
      attemptId: this.opts.attemptId,
      runId: this.opts.runId,
      stepRunId: this.opts.stepRunId,
      agentInstanceId: this.opts.agentInstanceId,
      ordinal,
      phase: 'prepared',
      source: 'action_edge',
      actionName,
      sdkVersion: BROWSER_AI_SDK_VERSION,
      elementDescription: this.currentElementDescription,
      binding,
      valueProvenance: this.currentValueProvenance,
      paramsSummary: this.currentParamsSummary,
      pageBefore: this.currentPageBefore,
      grant: this.opts.grant,
      sessionLease: this.opts.sessionLease,
    })
  }

  /** 派发失败：动作抛错，SDK 不会再走收尾钩子，在这里补 failed。 */
  async onDispatchFailed(actionName: string, error: unknown): Promise<void> {
    if (this.pendingActionName !== actionName || this.pendingOrdinal === null) return
    const durationMs = Date.now() - (this.actionStartTime || Date.now())
    const errorCode =
      (error as any)?.code ||
      (error instanceof Error ? error.message.slice(0, 64) : 'ACTION_FAILED')

    await appendAiTaskEvent(this.opts.db, {
      attemptId: this.opts.attemptId,
      runId: this.opts.runId,
      stepRunId: this.opts.stepRunId,
      agentInstanceId: this.opts.agentInstanceId,
      ordinal: this.pendingOrdinal,
      phase: 'failed',
      source: 'action_edge',
      actionName,
      sdkVersion: BROWSER_AI_SDK_VERSION,
      elementDescription: this.currentElementDescription,
      binding: this.currentBinding ?? notApplicableBinding(),
      valueProvenance: this.currentValueProvenance ?? noneProvenance(),
      paramsSummary: this.currentParamsSummary,
      pageBefore: this.currentPageBefore ?? (await capturePageObservation(this.opts.page, this.documentEpoch)),
      durationMs,
      errorCode,
      grant: this.opts.grant,
      sessionLease: this.opts.sessionLease,
    }).catch(() => undefined)
    this.pendingOrdinal = null
    this.pendingActionName = null
  }

  /**
   * 收尾边：SDK 的 afterInvokeAction 在等完导航与网络空闲后回调，参数为逻辑坐标。
   * 在此提交 completed、写请求信号与动作后页面观察。
   */
  async onSettled(actionName: string, _param: unknown): Promise<void> {
    const matched = this.pendingActionName === actionName && this.pendingOrdinal !== null
    const ordinal = matched ? this.pendingOrdinal! : this.ordinalSequence++
    const durationMs = matched && this.actionStartTime ? Date.now() - this.actionStartTime : null
    const pageBefore =
      (matched && this.currentPageBefore) ||
      (await capturePageObservation(this.opts.page, this.documentEpoch))
    const pageAfter = await capturePageObservation(this.opts.page, this.documentEpoch)
    const writeSignalCount = this.currentWriteSignalCount
    const writeSignalPaths = [...this.currentWriteSignalPaths]

    await appendAiTaskEvent(this.opts.db, {
      attemptId: this.opts.attemptId,
      runId: this.opts.runId,
      stepRunId: this.opts.stepRunId,
      agentInstanceId: this.opts.agentInstanceId,
      ordinal,
      phase: 'completed',
      source: 'action_edge',
      actionName,
      sdkVersion: BROWSER_AI_SDK_VERSION,
      elementDescription: matched ? this.currentElementDescription : null,
      binding: matched ? (this.currentBinding ?? notApplicableBinding()) : notApplicableBinding(),
      valueProvenance: matched ? (this.currentValueProvenance ?? noneProvenance()) : noneProvenance(),
      paramsSummary: matched ? this.currentParamsSummary : null,
      pageBefore,
      pageAfter,
      writeSignalCount,
      writeSignalPaths,
      durationMs,
      grant: this.opts.grant,
      sessionLease: this.opts.sessionLease,
    }).catch(() => undefined)

    // 写请求窗口随动作收尾闭合；下一个动作的派发重新开窗。
    this.currentWriteSignalCount = 0
    this.currentWriteSignalPaths = []
    this.pendingOrdinal = null
    this.pendingActionName = null
    this.currentPageBefore = null
  }

  private contextValues(): string[] | undefined {
    return this.opts.contextBindings
      ? Array.from(this.opts.contextBindings.values()).filter((v): v is string => typeof v === 'string')
      : undefined
  }
}

function notApplicableBinding(): AiElementBinding {
  return { status: 'not_applicable', redirected: false, candidates: [], dataDependent: false }
}

function noneProvenance(): AiValueProvenance {
  return { kind: 'none', source: null, value: null }
}
