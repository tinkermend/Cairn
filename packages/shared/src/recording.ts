import { z } from 'zod'
import { nextCursorSchema } from './rbac.js'
import { resourceDeletedBySchema } from './resource-lifecycle.js'
import { keyComboSchema, stepSchema, type Step } from './step.js'
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
import { SENSITIVE_AUTOCOMPLETE, SENSITIVE_LOCATOR } from './sensitive-fill.js'

/** 当前识途录制器壳对应的来源版本。导入路径只接受这一版。 */
export const RECORDER_SOURCE_VERSION = 'playwright-crx@0.15.0'
/** 可执行转换规则版本。预览/回填必须带上并重跑。 */
export const RECORDING_NORMALIZER_VERSION = 'recording-normalizer@3'

export const MAX_RECORDING_EVENTS = 200
export const MAX_RECORDING_JSON_BYTES = 256_000

export const RECORDING_ERROR_CODES = [
  'RECORDING_NOT_FOUND',
  'RECORDING_IDEMPOTENCY_CONFLICT',
  'RESOURCE_DELETED',
  'RECORDING_EMPTY',
  'RECORDING_TOO_LARGE',
  'RECORDING_TOO_MANY_EVENTS',
  'RECORDING_FORBIDDEN_PAYLOAD',
  'RECORDING_BINDING_NOT_FOUND',
  'RECORDING_BINDING_EXPIRED',
  'RECORDING_BINDING_CLOSED',
  'RECORDING_BINDING_CLAIMED',
  'RECORDING_BINDING_ORIGIN_MISMATCH',
  'RECORDING_BINDING_FORBIDDEN',
  'RECORDING_IMPORT_INCOMPLETE',
  'RECORDING_IMPORT_CAPACITY',
  'RECORDING_IMPORT_STALE',
  'RECORDING_IMPORT_CONFLICT',
  'RECORDING_SOURCE_UNSUPPORTED',
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

export const RECORDING_CANDIDATE_STEP_TYPES = [
  'navigate',
  'click',
  'fill',
  'assert',
  'select',
  'keyboard',
] as const
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
    modifiers: z.union([z.number().int(), z.array(z.string())]).optional(),
    key: z.string().max(64).optional(),
    options: z.array(z.string().max(512)).max(32).optional(),
    files: z.array(z.string().max(512)).max(16).optional(),
    substring: z.boolean().optional(),
    value: z.string().max(16_384).optional(),
    label: z.string().max(512).optional(),
    checked: z.boolean().optional(),
    snapshot: z.string().max(16_384).optional(),
    pageAlias: z.string().max(64).optional(),
    framePath: z.array(z.string().max(512)).max(8).optional(),
    locator: recordingLocatorSchema.optional(),
    inputType: z.string().max(64).optional(),
    autocomplete: z.string().max(128).optional(),
    markedSensitive: z.boolean().optional(),
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
  bindingId: entityIdSchema.optional(),
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
  imported: z.boolean().optional(),
  importedScenarioId: entityIdSchema.optional(),
  deletedAt: utcInstantSchema.nullable().optional(),
  deletedBy: resourceDeletedBySchema.nullable().optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
})
export type RecordingDraftDto = z.infer<typeof recordingDraftSchema>

export const renameRecordingBodySchema = z.strictObject({
  name: scenarioNameSchema,
})
export type RenameRecordingBody = z.infer<typeof renameRecordingBodySchema>

export const recordingDraftDetailSchema = recordingDraftSchema.extend({
  items: z.array(recordingItemSchema),
  diagnostics: z.array(z.string()),
  events: z.array(recordingEventSchema),
})
export type RecordingDraftDetailDto = z.infer<typeof recordingDraftDetailSchema>

export const recordingDraftListQuerySchema = z.object({
  search: z.string().trim().optional(),
  targetId: entityIdSchema.optional(),
  hasPending: z.coerce.boolean().optional(),
  imported: z.coerce.boolean().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
})
export type RecordingDraftListQuery = z.input<typeof recordingDraftListQuerySchema>

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
  sourceDigestEvents: RecordingEvent[]
}

const SECRET_QUERY_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'otp',
  'pin',
])
const FORBIDDEN_EVENT_KEYS = ['storageState', 'cookies', 'localStorage', 'sessionStorage']
const KNOWN_SIGNAL_NAMES = new Set(['popup', 'download', 'dialog', 'navigation'])

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
  const rows = source.actions?.length
    ? source.actions.map((line, index) => parseJsonlLine(line, index))
    : source.text?.trim()
      ? source.text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line, index) => parseJsonlLine(line, index))
          .filter((row) => isActionRow(row))
      : []
  return rows.map((row) => enrichRecordingCollectorFields(row))
}

/**
 * 采集端补字段：只根据已有定位推断 password，不把缺字段的 click 猜成左键。
 */
export function enrichRecordingCollectorFields(row: unknown): unknown {
  if (!row || typeof row !== 'object') return row
  const event = { ...(row as Record<string, unknown>) }
  if (event.name === 'fill' && typeof event.inputType !== 'string') {
    const hay = [typeof event.selector === 'string' ? event.selector : '', locatorHaystack(event.locator as RecordingEvent['locator'])].join(' ')
    if (SENSITIVE_LOCATOR.test(hay)) event.inputType = 'password'
  }
  return event
}

export function targetDescriptorFromInspectSelector(selector: string): TargetDescriptor | undefined {
  const trimmed = selector.trim()
  if (!trimmed) return undefined
  const role = trimmed.match(/^internal:role=([^\s[]+)(?:\[name=["']([^"']+)["']i?\])?/i)
  if (role?.[1]) {
    return {
      framePath: [],
      candidates: role[2] ? [{ by: 'role', value: role[1], name: role[2] }] : [{ by: 'role', value: role[1] }],
    }
  }
  const label = trimmed.match(/^internal:label=["']([^"']+)["']/i)
  if (label?.[1]) return { framePath: [], candidates: [{ by: 'label', value: label[1] }] }
  const text = trimmed.match(/^internal:text=["']([^"']+)["']/i)
  if (text?.[1]) return { framePath: [], candidates: [{ by: 'text', value: text[1] }] }
  const testId = trimmed.match(/^internal:(?:test-id|testid)=([^\s]+)/i)
  if (testId?.[1]) return { framePath: [], candidates: [{ by: 'testId', value: testId[1] }] }
  return targetFromEvent({ name: 'click', selector: trimmed })
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

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function assertRecordingPayloadSize(body: unknown): void {
  const bytes = utf8ByteLength(JSON.stringify(body))
  if (bytes > MAX_RECORDING_JSON_BYTES) {
    throw new RecordingNormalizationError(
      'RECORDING_TOO_LARGE',
      `录制上传不能超过 ${MAX_RECORDING_JSON_BYTES} 字节`,
    )
  }
}

export function normalizeRecording(
  rawEvents: readonly unknown[],
  options: { sourceVersion?: string; forImport?: boolean } = {},
): NormalizeRecordingResult {
  if (rawEvents.length === 0) {
    throw new RecordingNormalizationError('RECORDING_EMPTY', '没有可保存的录制操作')
  }
  if (rawEvents.length > MAX_RECORDING_EVENTS) {
    throw new RecordingNormalizationError(
      'RECORDING_TOO_MANY_EVENTS',
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
  const sourceUnsupported = Boolean(
    options.forImport && options.sourceVersion && options.sourceVersion !== RECORDER_SOURCE_VERSION,
  )
  if (options.sourceVersion && options.sourceVersion !== RECORDER_SOURCE_VERSION) {
    diagnostics.push(`来源版本是 ${options.sourceVersion}，不能按 ${RECORDER_SOURCE_VERSION} 做可执行转换`)
  }

  const items: RecordingItem[] = []
  const events: RecordingEvent[] = []

  for (const entry of merged) {
    const sanitized = sanitizeEvent(entry.event)
    events.push(sanitized)
    const item = mapEvent(sanitized, entry.sourceIndexes, items.length)
    if (item) items.push(sourceUnsupported ? forceUnresolved(item, '来源版本不受支持，不能自动转换') : item)
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
    sourceDigestEvents: events,
  }
}

export function candidateStepFromItem(item: RecordingItem, id: string): Step | undefined {
  if (item.status !== 'mapped' || !item.candidateStepType || item.input === undefined) return undefined
  const effectType = item.candidateStepType === 'assert' ? 'READ_ONLY' : 'SIDE_EFFECT'
  const parsed = stepSchema.safeParse({
    id,
    name: item.name,
    type: item.candidateStepType,
    effectType,
    input: item.input,
  })
  return parsed.success ? parsed.data : undefined
}

export function recordingItemReady(item: RecordingItem): boolean {
  return Boolean(candidateStepFromItem(item, '00000000-0000-4000-8000-000000000000'))
}

function assertNoForbiddenKeys(event: unknown, index: number, path = `第 ${index + 1} 条操作`): void {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new RecordingNormalizationError('RECORDING_FORBIDDEN_PAYLOAD', `${path}不是对象`)
  }
  const record = event as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_EVENT_KEYS.includes(key)) {
      throw new RecordingNormalizationError('RECORDING_FORBIDDEN_PAYLOAD', '不能上传 storage state、Cookie 或本地存储')
    }
    const value = record[key]
    if (value && typeof value === 'object') {
      if (Array.isArray(value)) {
        value.forEach((item, itemIndex) => {
          if (item && typeof item === 'object') assertNoForbiddenKeys(item, index, `${path}.${key}[${itemIndex}]`)
        })
      } else {
        assertNoForbiddenKeys(value, index, `${path}.${key}`)
      }
    }
  }
}

function mergeConsecutiveFills(events: RecordingEvent[]): { event: RecordingEvent; sourceIndexes: number[] }[] {
  const result: { event: RecordingEvent; sourceIndexes: number[] }[] = []
  for (const [index, event] of events.entries()) {
    const previous = result.at(-1)
    if (event.name === 'fill' && previous?.event.name === 'fill' && sameTarget(previous.event, event)) {
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
    JSON.stringify(left.framePath ?? []) === JSON.stringify(right.framePath ?? []) &&
    locatorIdentity(left.locator) === locatorIdentity(right.locator)
  )
}

function locatorIdentity(locator: RecordingEvent['locator']): string {
  if (!locator) return ''
  const body = typeof locator.body === 'string' ? locator.body : ''
  const name = typeof locator.options?.name === 'string' ? locator.options.name : ''
  return `${locator.kind}:${body}:${name}`
}

function sanitizeEvent(event: RecordingEvent): RecordingEvent {
  const picked: RecordingEvent = {
    name: event.name,
    signals: sanitizeSignals(event.signals),
    selector: event.selector,
    url: stripSecretQuery(event.url),
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
    locator: sanitizeLocator(event.locator),
    inputType: event.inputType,
    autocomplete: event.autocomplete,
    markedSensitive: event.markedSensitive,
  }
  if (isSensitiveFill(picked) || isSensitiveAssert(picked)) {
    return { ...picked, text: undefined, value: undefined }
  }
  return picked
}

function sanitizeSignals(signals: RecordingEvent['signals']): RecordingEvent['signals'] {
  if (!Array.isArray(signals)) return undefined
  return signals.flatMap((signal) => {
    if (!signal || typeof signal !== 'object' || !('name' in signal)) return []
    const name = String((signal as { name: unknown }).name)
    if (!KNOWN_SIGNAL_NAMES.has(name)) return []
    return [{ name }]
  })
}

function sanitizeLocator(locator: RecordingEvent['locator']): RecordingEvent['locator'] {
  if (!locator) return undefined
  const name = typeof locator.options?.name === 'string' ? locator.options.name : undefined
  const next = isLocatorNode(locator.next) ? sanitizeLocator(locator.next) : undefined
  return {
    kind: locator.kind,
    body: typeof locator.body === 'string' ? locator.body : undefined,
    options: name ? { name } : undefined,
    next,
  }
}

function stripSecretQuery(url: string | undefined): string | undefined {
  if (!url) return url
  try {
    const parsed = new URL(url)
    let changed = false
    for (const key of [...parsed.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key)
        changed = true
      }
    }
    return changed ? parsed.toString() : url
  } catch {
    return url
  }
}

export function isSensitiveFill(event: RecordingEvent): boolean {
  if (event.name !== 'fill') return false
  if (event.markedSensitive) return true
  if ((event.inputType ?? '').toLowerCase() === 'password') return true
  if (SENSITIVE_AUTOCOMPLETE.has((event.autocomplete ?? '').toLowerCase())) return true
  const hay = [event.selector ?? '', locatorHaystack(event.locator)].join(' ')
  return SENSITIVE_LOCATOR.test(hay)
}

function isSensitiveAssert(event: RecordingEvent): boolean {
  if (event.name !== 'assertText' && event.name !== 'assertValue') return false
  return SENSITIVE_LOCATOR.test(`${event.text ?? ''} ${event.value ?? ''}`)
}

function locatorHaystack(locator: RecordingEvent['locator']): string {
  if (!locator) return ''
  const body = typeof locator.body === 'string' ? locator.body : ''
  const name = typeof locator.options?.name === 'string' ? locator.options.name : ''
  const next =
    locator.next && typeof locator.next === 'object'
      ? locatorHaystack(locator.next as RecordingEvent['locator'])
      : ''
  return `${locator.kind} ${body} ${name} ${next}`
}

function parseModifiers(
  modifiers: number | string[] | undefined,
): ('Alt' | 'Control' | 'Meta' | 'Shift')[] | undefined {
  if (!modifiers) return undefined
  if (Array.isArray(modifiers)) {
    const valid = modifiers.filter((m): m is 'Alt' | 'Control' | 'Meta' | 'Shift' =>
      ['Alt', 'Control', 'Meta', 'Shift'].includes(m),
    )
    return valid.length > 0 ? valid : undefined
  }
  if (typeof modifiers === 'number') {
    const res: ('Alt' | 'Control' | 'Meta' | 'Shift')[] = []
    if (modifiers & 1) res.push('Alt')
    if (modifiers & 2) res.push('Control')
    if (modifiers & 4) res.push('Meta')
    if (modifiers & 8) res.push('Shift')
    return res.length > 0 ? res : undefined
  }
  return undefined
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
  if (event.name === 'check' || event.name === 'uncheck') {
    return checkItem(event, sourceIndexes, index, event.name === 'check' ? '勾选' : '取消勾选')
  }
  if (event.name === 'click') {
    return clickItem(event, sourceIndexes, index)
  }
  if (event.name === 'fill') {
    return fillItem(event, sourceIndexes, index)
  }
  if (event.name === 'press') {
    return pressItem(event, sourceIndexes, index)
  }
  if (event.name === 'select') {
    return selectItem(event, sourceIndexes, index)
  }
  if (event.name === 'assertVisible' || event.name === 'assertText') {
    return assertItem(event, sourceIndexes, index)
  }
  return unresolved(event, sourceIndexes, index, unresolvedName(event.name), [capabilityMessage(event.name)])
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

function checkItem(event: RecordingEvent, sourceIndexes: number[], index: number, name: string): RecordingItem {
  const target = targetFromEvent(event)
  if (!target) {
    return unresolved(event, sourceIndexes, index, name, targetDiagnostics(event))
  }
  return {
    index,
    sourceIndexes,
    status: 'mapped',
    sourceAction: event.name as RecordingActionName,
    name,
    candidateStepType: 'click',
    input: asJson({ target }),
    pageAlias: event.pageAlias,
    framePath: event.framePath,
    diagnostics: signalDiagnostics(event),
  }
}

function clickItem(event: RecordingEvent, sourceIndexes: number[], index: number): RecordingItem {
  const popups = popupSignals(event)
  if (popups > 1) {
    return unresolved(event, sourceIndexes, index, '点击', ['多个弹出窗口，无法确定页面交接'])
  }
  const target = targetFromEvent(event)
  if (!target) {
    return unresolved(event, sourceIndexes, index, '点击', targetDiagnostics(event))
  }
  if (event.button === undefined || event.clickCount === undefined || event.modifiers === undefined) {
    return unresolved(event, sourceIndexes, index, '点击', ['缺少 button / clickCount / modifiers，不能猜测为普通左键'])
  }
  const button = event.button === 'right' || event.button === 'middle' ? event.button : undefined
  const clickCount = event.clickCount === 2 ? 2 : undefined
  const modifiers = parseModifiers(event.modifiers)
  const input: Record<string, unknown> = { target }
  if (popups === 1) input.pageAfter = 'popup'
  if (button) input.button = button
  if (clickCount) input.clickCount = clickCount
  if (modifiers) input.modifiers = modifiers

  let name = '点击'
  if (button === 'right') name = '右键点击'
  else if (button === 'middle') name = '中键点击'
  else if (clickCount === 2) name = '双击'
  else if (modifiers && modifiers.length > 0) name = `${modifiers.join('+')}+点击`

  const diagnostics = signalDiagnostics(event)
  if (popups === 1) diagnostics.push('将交接至弹出页')
  return {
    index,
    sourceIndexes,
    status: 'mapped',
    sourceAction: 'click',
    name,
    candidateStepType: 'click',
    input: asJson(input),
    pageAlias: event.pageAlias,
    framePath: event.framePath,
    diagnostics,
  }
}

function pressItem(event: RecordingEvent, sourceIndexes: number[], index: number): RecordingItem {
  const key = event.key?.trim()
  if (!key) {
    return unresolved(event, sourceIndexes, index, '按键', ['缺少按键键名'])
  }
  if (!keyComboSchema.safeParse(key).success) {
    return unresolved(event, sourceIndexes, index, `按键 ${key}`, [`按键 ${key} 暂未开放`])
  }
  const target = targetFromEvent(event)
  return {
    index,
    sourceIndexes,
    status: 'mapped',
    sourceAction: 'press',
    name: `按键 ${key}`,
    candidateStepType: 'keyboard',
    input: asJson({
      ...(target ? { target } : {}),
      keys: [key],
    }),
    pageAlias: event.pageAlias,
    framePath: event.framePath,
    diagnostics: signalDiagnostics(event),
  }
}

function selectItem(event: RecordingEvent, sourceIndexes: number[], index: number): RecordingItem {
  const target = targetFromEvent(event)
  if (!target) {
    return unresolved(event, sourceIndexes, index, '下拉选择', targetDiagnostics(event))
  }
  const label = event.label?.trim()
  const firstOption = Array.isArray(event.options) && event.options[0] ? event.options[0].trim() : undefined
  const value = (event.value ?? firstOption)?.trim()
  if (label) {
    return {
      index,
      sourceIndexes,
      status: 'mapped',
      sourceAction: 'select',
      name: `选择 ${label}`,
      candidateStepType: 'select',
      input: asJson({ target, by: 'label', value: label }),
      pageAlias: event.pageAlias,
      framePath: event.framePath,
      diagnostics: signalDiagnostics(event),
    }
  }
  if (value !== undefined && value.length > 0) {
    return {
      index,
      sourceIndexes,
      status: 'mapped',
      sourceAction: 'select',
      name: `选择 ${value}`,
      candidateStepType: 'select',
      input: asJson({ target, by: 'value', value }),
      pageAlias: event.pageAlias,
      framePath: event.framePath,
      diagnostics: signalDiagnostics(event),
    }
  }
  return unresolved(event, sourceIndexes, index, '下拉选择', ['未捕获有效选项'])
}

function fillItem(event: RecordingEvent, sourceIndexes: number[], index: number): RecordingItem {
  const sensitive = isSensitiveFill(event)
  const target = targetFromEvent(event)
  const diagnostics = [...signalDiagnostics(event)]
  if (!target) {
    return unresolved(event, sourceIndexes, index, '填写', targetDiagnostics(event))
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
  if (isSensitiveAssert(event)) {
    return unresolved(event, sourceIndexes, index, '断言文本', ['断言文本含敏感值，已排除，需人工重建'])
  }
  if (!target) diagnostics.push(...targetDiagnostics(event))
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

function forceUnresolved(item: RecordingItem, reason: string): RecordingItem {
  return {
    ...item,
    status: 'unresolved',
    candidateStepType: undefined,
    input: undefined,
    diagnostics: [...item.diagnostics, reason].slice(0, 16),
  }
}

function targetFromEvent(event: RecordingEvent): TargetDescriptor | undefined {
  const frames = (event.framePath ?? []).map((selector) => selector.trim()).filter(Boolean)
  if (frames.length > MAX_FRAME_DEPTH) return undefined
  const candidates = locatorToCandidates(event.locator, event.selector)
  if (!candidates) return undefined
  const parsed = z
    .object({
      framePath: z.array(z.object({ selector: z.string().min(1).max(512) })).max(MAX_FRAME_DEPTH),
      candidates: z.array(locatorCandidateSchema).min(1).max(MAX_LOCATOR_CANDIDATES),
    })
    .safeParse({
      framePath: frames.map((selector) => ({ selector })),
      candidates,
    })
  return parsed.success ? parsed.data : undefined
}

function targetDiagnostics(event: RecordingEvent): string[] {
  const frames = (event.framePath ?? []).map((selector) => selector.trim()).filter(Boolean)
  if (frames.length > MAX_FRAME_DEPTH) return [`iframe 深度 ${frames.length} 超过 ${MAX_FRAME_DEPTH}，不能截断后执行`]
  if (event.locator && isLocatorNode(event.locator.next)) return ['链式定位不能摊平为候选列表']
  const kind = event.locator?.kind
  if (kind === 'placeholder' || kind === 'alt') return [`${kind} 不能改写成平台 locator`]
  return ['定位无法映射为平台 TargetDescriptor']
}

function locatorToCandidates(
  locator: RecordingEvent['locator'],
  selector: string | undefined,
): LocatorCandidate[] | undefined {
  if (locator && isLocatorNode(locator.next)) return undefined
  const mapped = locator ? mapLocatorNode(locator) : undefined
  if (mapped) return [mapped]
  if (selector && isCssLike(selector)) return [{ by: 'css', value: selector.slice(0, 512) }]
  return undefined
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
      return { by: 'label', value: body }
    case 'text':
      return { by: 'text', value: body }
    case 'title':
      return { by: 'title', value: body }
    case 'test-id':
      return { by: 'testId', value: body }
    case 'default':
      return { by: 'css', value: body }
    case 'placeholder':
    case 'alt':
      return undefined
    default:
      return undefined
  }
}

function isCssLike(selector: string): boolean {
  return !selector.startsWith('internal:') && /^[a-zA-Z.#\[*]/.test(selector)
}

function popupSignals(event: RecordingEvent): number {
  const signals = Array.isArray(event.signals) ? event.signals : []
  return signals.filter((signal) => signal && typeof signal === 'object' && 'name' in signal && signal.name === 'popup')
    .length
}

function signalDiagnostics(event: RecordingEvent): string[] {
  const signals = Array.isArray(event.signals) ? event.signals : []
  return signals.flatMap((signal) => {
    if (!signal || typeof signal !== 'object' || !('name' in signal)) return []
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
