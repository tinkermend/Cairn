import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import {
  MAX_FRAME_DEPTH,
  MAX_LOCATOR_CANDIDATES,
  locatorCandidateSchema,
  type LocatorCandidate,
  type TargetDescriptor,
} from './target-descriptor.js'
import { entityIdSchema, jsonValueSchema, utcInstantSchema, type JsonValue } from './wire.js'
import { idempotencyKeySchema } from './run-api.js'
import { scenarioNameSchema } from './scenario.js'

/** 当前识途录制器壳对应的来源版本。服务端接受其它版本，但会记诊断。 */
export const RECORDER_SOURCE_VERSION = 'playwright-crx@0.15.0'

export const MAX_RECORDING_EVENTS = 200
export const MAX_RECORDING_JSON_BYTES = 256_000

export const RECORDING_ERROR_CODES = [
  'RECORDING_NOT_FOUND',
  'RECORDING_IDEMPOTENCY_CONFLICT',
  'RECORDING_EMPTY',
  'RECORDING_TOO_LARGE',
  'RECORDING_FORBIDDEN_PAYLOAD',
] as const
export type RecordingErrorCode = (typeof RECORDING_ERROR_CODES)[number]

export const RECORDING_ACTION_NAMES = [
  'check',
  'click',
  'closePage',
  'fill',
  'navigate',
  'openPage',
  'press',
  'select',
  'uncheck',
  'setInputFiles',
  'assertText',
  'assertValue',
  'assertChecked',
  'assertVisible',
  'assertSnapshot',
] as const
export type RecordingActionName = (typeof RECORDING_ACTION_NAMES)[number]

export const RECORDING_ITEM_STATUSES = ['mapped', 'unresolved', 'parameterized'] as const
export type RecordingItemStatus = (typeof RECORDING_ITEM_STATUSES)[number]

export const RECORDING_CANDIDATE_STEP_TYPES = ['navigate', 'click', 'fill', 'assert'] as const
export type RecordingCandidateStepType = (typeof RECORDING_CANDIDATE_STEP_TYPES)[number]

const recordingLocatorSchema: z.ZodType<{
  kind: string
  body?: unknown
  options?: Record<string, unknown>
  next?: unknown
}> = z.lazy(() =>
  z
    .object({
      kind: z.string().min(1).max(64),
      body: z.unknown().optional(),
      options: z.record(z.string(), z.unknown()).optional(),
      next: recordingLocatorSchema.optional(),
    })
    .passthrough(),
)

/** playwright-crx JSONL 一行。只约束上传需要的字段，多余键在归一化时丢掉。 */
export const recordingEventSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    signals: z.array(z.unknown()).max(16).optional(),
    selector: z.string().max(2048).optional(),
    url: z.string().max(2048).optional(),
    text: z.string().max(16_384).optional(),
    button: z.string().max(16).optional(),
    clickCount: z.number().int().optional(),
    modifiers: z.number().int().optional(),
    key: z.string().max(64).optional(),
    options: z.array(z.string().max(512)).max(32).optional(),
    files: z.array(z.string().max(512)).max(16).optional(),
    substring: z.boolean().optional(),
    value: z.string().max(16_384).optional(),
    checked: z.boolean().optional(),
    snapshot: z.string().max(16_384).optional(),
    pageAlias: z.string().max(64).optional(),
    framePath: z.array(z.string().max(512)).max(8).optional(),
    locator: recordingLocatorSchema.optional(),
  })
  .passthrough()
export type RecordingEvent = z.infer<typeof recordingEventSchema>

export const recordingItemSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  sourceIndexes: z.array(z.number().int().nonnegative()).min(1),
  status: z.enum(RECORDING_ITEM_STATUSES),
  sourceAction: z.string().min(1).max(64),
  name: z.string().min(1).max(128),
  candidateStepType: z.enum(RECORDING_CANDIDATE_STEP_TYPES).optional(),
  input: jsonValueSchema.optional(),
  pageAlias: z.string().max(64).optional(),
  framePath: z.array(z.string().max(512)).max(MAX_FRAME_DEPTH).optional(),
  diagnostics: z.array(z.string().min(1).max(512)).max(16),
  sensitive: z.boolean().optional(),
})
export type RecordingItem = z.infer<typeof recordingItemSchema>

export const createRecordingBodySchema = z.strictObject({
  targetId: entityIdSchema,
  recordingId: entityIdSchema,
  sourceVersion: z.string().trim().min(1).max(64),
  idempotencyKey: idempotencyKeySchema,
  name: scenarioNameSchema.optional(),
  events: z.array(recordingEventSchema).min(1).max(MAX_RECORDING_EVENTS),
})
export type CreateRecordingBody = z.infer<typeof createRecordingBodySchema>

const recordingActorSchema = z.object({
  id: entityIdSchema,
  displayName: z.string().min(1),
})

export const recordingDraftSchema = z.object({
  id: entityIdSchema,
  targetId: entityIdSchema,
  targetName: z.string().min(1),
  name: scenarioNameSchema,
  recordingId: entityIdSchema,
  sourceVersion: z.string().min(1),
  eventCount: z.number().int().nonnegative(),
  itemCount: z.number().int().nonnegative(),
  unresolvedCount: z.number().int().nonnegative(),
  createdBy: recordingActorSchema,
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type RecordingDraftDto = z.infer<typeof recordingDraftSchema>

export const recordingDraftDetailSchema = recordingDraftSchema.extend({
  items: z.array(recordingItemSchema),
  diagnostics: z.array(z.string()),
  events: z.array(recordingEventSchema),
})
export type RecordingDraftDetailDto = z.infer<typeof recordingDraftDetailSchema>

export const recordingDraftListResponseSchema = z.object({
  items: z.array(recordingDraftSchema),
  nextCursor: nextCursorSchema,
})
export type RecordingDraftListResponse = z.infer<typeof recordingDraftListResponseSchema>

export type NormalizeRecordingResult = {
  events: RecordingEvent[]
  items: RecordingItem[]
  diagnostics: string[]
  eventCount: number
  unresolvedCount: number
}

const SENSITIVE_LOCATOR = /password|passwd|secret|token|otp|\bpin\b|密码|口令|验证码/i
const FORBIDDEN_EVENT_KEYS = ['storageState', 'cookies', 'localStorage', 'sessionStorage']

export class RecordingNormalizationError extends Error {
  readonly code: RecordingErrorCode

  constructor(code: RecordingErrorCode, message: string) {
    super(message)
    this.name = 'RecordingNormalizationError'
    this.code = code
  }
}

/**
 * 从 Side Panel 已收到的 JSONL Source 取出操作行。
 * `actions` 是逐条 JSON；`text` 含 codegen 头行，没有 `name` 的行会跳过。
 */
export function parseJsonlSource(source: { text?: string; actions?: string[] }): unknown[] {
  if (source.actions?.length) {
    return source.actions.map((line, index) => parseJsonlLine(line, index))
  }
  if (!source.text?.trim()) return []
  return source.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseJsonlLine(line, index))
    .filter((row) => isActionRow(row))
}

function parseJsonlLine(line: string, index: number): unknown {
  try {
    return JSON.parse(line) as unknown
  } catch {
    throw new RecordingNormalizationError('RECORDING_FORBIDDEN_PAYLOAD', `第 ${index + 1} 行不是合法 JSON`)
  }
}

function isActionRow(row: unknown): row is Record<string, unknown> {
  return Boolean(row && typeof row === 'object' && typeof (row as { name?: unknown }).name === 'string')
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export function assertRecordingPayloadSize(body: unknown): void {
  const bytes = JSON.stringify(body).length
  if (bytes > MAX_RECORDING_JSON_BYTES) {
    throw new RecordingNormalizationError(
      'RECORDING_TOO_LARGE',
      `录制上传不能超过 ${MAX_RECORDING_JSON_BYTES} 字节`,
    )
  }
}

export function normalizeRecording(
  rawEvents: readonly unknown[],
  options: { sourceVersion?: string } = {},
): NormalizeRecordingResult {
  if (rawEvents.length === 0) {
    throw new RecordingNormalizationError('RECORDING_EMPTY', '没有可保存的录制操作')
  }
  if (rawEvents.length > MAX_RECORDING_EVENTS) {
    throw new RecordingNormalizationError(
      'RECORDING_EMPTY',
      `一次最多上传 ${MAX_RECORDING_EVENTS} 条操作`,
    )
  }

  const parsed = rawEvents.map((event, index) => {
    assertNoForbiddenKeys(event, index)
    const result = recordingEventSchema.safeParse(event)
    if (!result.success) {
      throw new RecordingNormalizationError(
        'RECORDING_FORBIDDEN_PAYLOAD',
        `第 ${index + 1} 条操作无法识别`,
      )
    }
    return result.data
  })

  const merged = mergeConsecutiveFills(parsed)
  const diagnostics: string[] = []
  if (options.sourceVersion && options.sourceVersion !== RECORDER_SOURCE_VERSION) {
    diagnostics.push(`来源版本是 ${options.sourceVersion}，映射按 ${RECORDER_SOURCE_VERSION} 解释`)
  }

  const items: RecordingItem[] = []
  const events: RecordingEvent[] = []

  for (const entry of merged) {
    const sanitized = sanitizeEvent(entry.event)
    events.push(sanitized)
    const item = mapEvent(sanitized, entry.sourceIndexes, items.length)
    if (item) items.push(item)
  }

  if (items.length === 0) {
    throw new RecordingNormalizationError('RECORDING_EMPTY', '录制只有空页面打开，没有可保存的业务操作')
  }

  const unresolvedCount = items.filter((item) => item.status === 'unresolved').length
  return {
    events,
    items: items.map((item, index) => ({ ...item, index })),
    diagnostics,
    eventCount: events.length,
    unresolvedCount,
  }
}

function assertNoForbiddenKeys(event: unknown, index: number): void {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new RecordingNormalizationError('RECORDING_FORBIDDEN_PAYLOAD', `第 ${index + 1} 条操作不是对象`)
  }
  const keys = Object.keys(event)
  const hit = keys.find((key) => FORBIDDEN_EVENT_KEYS.includes(key))
  if (hit) {
    throw new RecordingNormalizationError('RECORDING_FORBIDDEN_PAYLOAD', '不能上传 storage state、Cookie 或本地存储')
  }
}

function mergeConsecutiveFills(events: RecordingEvent[]): { event: RecordingEvent; sourceIndexes: number[] }[] {
  const result: { event: RecordingEvent; sourceIndexes: number[] }[] = []
  for (const [index, event] of events.entries()) {
    const previous = result.at(-1)
    if (
      event.name === 'fill' &&
      previous?.event.name === 'fill' &&
      sameTarget(previous.event, event)
    ) {
      previous.event = { ...event, text: event.text }
      previous.sourceIndexes.push(index)
      continue
    }
    result.push({ event, sourceIndexes: [index] })
  }
  return result
}

function sameTarget(left: RecordingEvent, right: RecordingEvent): boolean {
  return (
    (left.selector ?? '') === (right.selector ?? '') &&
    (left.pageAlias ?? '') === (right.pageAlias ?? '') &&
    JSON.stringify(left.framePath ?? []) === JSON.stringify(right.framePath ?? [])
  )
}

function sanitizeEvent(event: RecordingEvent): RecordingEvent {
  const picked: RecordingEvent = {
    name: event.name,
    signals: event.signals,
    selector: event.selector,
    url: event.url,
    text: event.text,
    button: event.button,
    clickCount: event.clickCount,
    modifiers: event.modifiers,
    key: event.key,
    options: event.options,
    files: event.files,
    substring: event.substring,
    value: event.value,
    checked: event.checked,
    pageAlias: event.pageAlias,
    framePath: event.framePath,
    locator: event.locator,
  }
  if (isSensitiveFill(picked)) {
    return { ...picked, text: undefined, value: undefined }
  }
  return picked
}

function isSensitiveFill(event: RecordingEvent): boolean {
  if (event.name !== 'fill') return false
  const hay = [event.selector ?? '', locatorHaystack(event.locator)].join(' ')
  return SENSITIVE_LOCATOR.test(hay)
}

function locatorHaystack(locator: RecordingEvent['locator']): string {
  if (!locator) return ''
  const body = typeof locator.body === 'string' ? locator.body : ''
  const name = typeof locator.options?.name === 'string' ? locator.options.name : ''
  const next = locator.next && typeof locator.next === 'object' ? locatorHaystack(locator.next as RecordingEvent['locator']) : ''
  return `${locator.kind} ${body} ${name} ${next}`
}

function mapEvent(event: RecordingEvent, sourceIndexes: number[], index: number): RecordingItem | null {
  if (event.name === 'openPage') {
    const url = event.url?.trim() ?? ''
    if (!url || url === 'about:blank') return null
    return navigateItem(event, sourceIndexes, index, url)
  }
  if (event.name === 'navigate') {
    const url = event.url?.trim() ?? ''
    if (!url) {
      return unresolved(event, sourceIndexes, index, '导航', ['导航缺少 URL'])
    }
    return navigateItem(event, sourceIndexes, index, url)
  }
  if (event.name === 'click' || event.name === 'check' || event.name === 'uncheck') {
    return actionWithTarget(event, sourceIndexes, index, 'click', clickName(event), event.name === 'click' ? [] : ['勾选按点击处理，发布前请确认'])
  }
  if (event.name === 'fill') {
    return fillItem(event, sourceIndexes, index)
  }
  if (event.name === 'assertVisible' || event.name === 'assertText') {
    return assertItem(event, sourceIndexes, index)
  }
  return unresolved(event, sourceIndexes, index, unresolvedName(event.name), [
    capabilityMessage(event.name),
  ])
}

function navigateItem(
  event: RecordingEvent,
  sourceIndexes: number[],
  index: number,
  url: string,
): RecordingItem {
  return {
    index,
    sourceIndexes,
    status: 'mapped',
    sourceAction: event.name,
    name: `打开 ${shortUrl(url)}`,
    candidateStepType: 'navigate',
    input: asJson({ url }),
    pageAlias: event.pageAlias,
    framePath: event.framePath,
    diagnostics: signalDiagnostics(event),
  }
}

function fillItem(event: RecordingEvent, sourceIndexes: number[], index: number): RecordingItem {
  const sensitive = isSensitiveFill(event)
  const target = targetFromEvent(event)
  const diagnostics = [...signalDiagnostics(event)]
  if (!target) {
    return unresolved(event, sourceIndexes, index, '填写', ['填写目标无法映射为平台定位'])
  }
  if (sensitive) {
    diagnostics.push('敏感输入已排除，需在编辑器补参数')
    return {
      index,
      sourceIndexes,
      status: 'parameterized',
      sourceAction: 'fill',
      name: '填写敏感字段',
      candidateStepType: 'fill',
      input: asJson({ target, sensitive: true }),
      pageAlias: event.pageAlias,
      framePath: event.framePath,
      diagnostics,
      sensitive: true,
    }
  }
  return {
    index,
    sourceIndexes,
    status: 'mapped',
    sourceAction: 'fill',
    name: '填写',
    candidateStepType: 'fill',
    input: asJson({ target, value: event.text ?? '' }),
    pageAlias: event.pageAlias,
    framePath: event.framePath,
    diagnostics,
  }
}

function assertItem(event: RecordingEvent, sourceIndexes: number[], index: number): RecordingItem {
  const target = targetFromEvent(event)
  const diagnostics = [...signalDiagnostics(event)]
  if (!target) diagnostics.push('断言目标需在编辑器确认')
  if (event.name === 'assertVisible') {
    return {
      index,
      sourceIndexes,
      status: target ? 'mapped' : 'unresolved',
      sourceAction: event.name,
      name: '断言可见',
      candidateStepType: 'assert',
      input: asJson({ target, expect: { kind: 'visible' } }),
      pageAlias: event.pageAlias,
      framePath: event.framePath,
      diagnostics,
    }
  }
  const text = event.text?.trim() ?? ''
  if (!text) {
    return unresolved(event, sourceIndexes, index, '断言文本', ['断言缺少期望文本'])
  }
  return {
    index,
    sourceIndexes,
    status: target ? 'mapped' : 'unresolved',
    sourceAction: event.name,
    name: '断言文本',
    candidateStepType: 'assert',
    input: asJson({
      target,
      expect: event.substring ? { kind: 'text_contains', value: text } : { kind: 'text_equals', value: text },
    }),
    pageAlias: event.pageAlias,
    framePath: event.framePath,
    diagnostics,
  }
}

function actionWithTarget(
  event: RecordingEvent,
  sourceIndexes: number[],
  index: number,
  stepType: RecordingCandidateStepType,
  name: string,
  extraDiagnostics: string[],
): RecordingItem {
  const target = targetFromEvent(event)
  const diagnostics = [...signalDiagnostics(event), ...extraDiagnostics]
  if (!target) {
    return unresolved(event, sourceIndexes, index, name, ['定位无法映射为平台 TargetDescriptor'])
  }
  return {
    index,
    sourceIndexes,
    status: 'mapped',
    sourceAction: event.name,
    name,
    candidateStepType: stepType,
    input: asJson({ target }),
    pageAlias: event.pageAlias,
    framePath: event.framePath,
    diagnostics,
  }
}

function unresolved(
  event: RecordingEvent,
  sourceIndexes: number[],
  index: number,
  name: string,
  diagnostics: string[],
): RecordingItem {
  return {
    index,
    sourceIndexes,
    status: 'unresolved',
    sourceAction: event.name,
    name,
    pageAlias: event.pageAlias,
    framePath: event.framePath,
    diagnostics: [...signalDiagnostics(event), ...diagnostics],
  }
}

function targetFromEvent(event: RecordingEvent): TargetDescriptor | undefined {
  const candidates = locatorToCandidates(event.locator, event.selector)
  if (!candidates) return undefined
  const framePath = (event.framePath ?? [])
    .slice(0, MAX_FRAME_DEPTH)
    .map((selector) => selector.trim())
    .filter(Boolean)
    .map((selector) => ({ selector }))
  const parsed = z
    .object({
      framePath: z.array(z.object({ selector: z.string().min(1).max(512) })).max(MAX_FRAME_DEPTH),
      candidates: z.array(locatorCandidateSchema).min(1).max(MAX_LOCATOR_CANDIDATES),
    })
    .safeParse({ framePath, candidates })
  return parsed.success ? parsed.data : undefined
}

function locatorToCandidates(
  locator: RecordingEvent['locator'],
  selector: string | undefined,
): LocatorCandidate[] | undefined {
  const found: LocatorCandidate[] = []
  let node: RecordingEvent['locator'] | undefined = locator
  while (node && found.length < MAX_LOCATOR_CANDIDATES) {
    const mapped = mapLocatorNode(node)
    if (mapped) found.push(mapped)
    node = isLocatorNode(node.next) ? node.next : undefined
  }
  if (found.length === 0 && selector && isCssLike(selector)) {
    found.push({ by: 'css', value: selector.slice(0, 512) })
  }
  const rest = found.filter((item) => item.by !== 'css')
  const css = found.filter((item) => item.by === 'css').at(-1)
  const ordered = css ? [...rest, css] : rest
  return ordered.length > 0 ? ordered.slice(0, MAX_LOCATOR_CANDIDATES) : undefined
}

function isLocatorNode(value: unknown): value is NonNullable<RecordingEvent['locator']> {
  return Boolean(value && typeof value === 'object' && 'kind' in value)
}

function mapLocatorNode(node: NonNullable<RecordingEvent['locator']>): LocatorCandidate | undefined {
  const body = typeof node.body === 'string' ? node.body.trim() : ''
  if (!body || body.length > 512) return undefined
  const name = typeof node.options?.name === 'string' ? node.options.name.trim() : undefined
  switch (node.kind) {
    case 'role':
      return name ? { by: 'role', value: body, name } : { by: 'role', value: body }
    case 'label':
    case 'placeholder':
      return { by: 'label', value: body }
    case 'text':
    case 'alt':
      return { by: 'text', value: body }
    case 'title':
      return { by: 'title', value: body }
    case 'test-id':
      return { by: 'testId', value: body }
    case 'default':
      return { by: 'css', value: body }
    default:
      return undefined
  }
}

function isCssLike(selector: string): boolean {
  return !selector.startsWith('internal:') && /^[a-zA-Z.#\[*]/.test(selector)
}

function signalDiagnostics(event: RecordingEvent): string[] {
  const signals = Array.isArray(event.signals) ? event.signals : []
  return signals.flatMap((signal) => {
    if (!signal || typeof signal !== 'object' || !('name' in signal)) return []
    if (signal.name === 'popup') return ['打开了新窗口，后续步骤的页面交接需在编辑器确认']
    if (signal.name === 'download') return ['触发了下载，平台步骤暂不覆盖']
    if (signal.name === 'dialog') return ['弹出了对话框，平台步骤暂不覆盖']
    return []
  })
}

function clickName(event: RecordingEvent): string {
  if (event.name === 'check') return '勾选'
  if (event.name === 'uncheck') return '取消勾选'
  return '点击'
}

function unresolvedName(action: string): string {
  switch (action) {
    case 'press':
      return '按键'
    case 'select':
      return '选择'
    case 'setInputFiles':
      return '上传文件'
    case 'closePage':
      return '关闭页面'
    case 'assertValue':
      return '断言值'
    case 'assertChecked':
      return '断言勾选'
    case 'assertSnapshot':
      return '断言快照'
    default:
      return action
  }
}

function capabilityMessage(action: string): string {
  switch (action) {
    case 'press':
      return '按键尚无对应 Step Type，保留为待处理项'
    case 'select':
      return '下拉选择尚无对应 Step Type，保留为待处理项'
    case 'setInputFiles':
      return '文件上传尚无对应 Step Type，保留为待处理项'
    case 'closePage':
      return '关闭页面不生成步骤，页面交接需在编辑器确认'
    case 'assertValue':
    case 'assertChecked':
    case 'assertSnapshot':
      return `${unresolvedName(action)}尚不能映射到现有断言种类`
    default:
      return `操作 ${action} 不能映射为平台步骤`
  }
}

function shortUrl(url: string): string {
  const withoutProtocol = url.replace(/^https?:\/\//i, '')
  const cut = withoutProtocol.search(/[/?#]/)
  if (cut === -1) return withoutProtocol.slice(0, 48)
  const host = withoutProtocol.slice(0, cut)
  const path = withoutProtocol.slice(cut).split(/[?#]/)[0] ?? '/'
  const label = path === '/' ? host : `${host}${path}`
  return label.slice(0, 48)
}
