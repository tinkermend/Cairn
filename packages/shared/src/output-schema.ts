import { z } from 'zod'
import { jsonValueSchema, type JsonValue } from './wire.js'

/**
 * Output Schema / fromField 的字段名。
 * 不复用 contextKey：作者按业务命名，允许中文；仍拒绝空串、过长和对象保留名。
 */
export const FORBIDDEN_OUTPUT_FIELD_NAMES = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
] as const

export const OUTPUT_FIELD_TYPES = ['string', 'number', 'boolean'] as const
export type OutputFieldType = (typeof OUTPUT_FIELD_TYPES)[number]
export const outputFieldTypeSchema = z.enum(OUTPUT_FIELD_TYPES)

export const outputFieldNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (name) => !(FORBIDDEN_OUTPUT_FIELD_NAMES as readonly string[]).includes(name),
    '字段名不得使用对象保留名',
  )
export type OutputFieldName = z.infer<typeof outputFieldNameSchema>

export const aiOutputFieldSchema = z.strictObject({
  name: outputFieldNameSchema,
  type: outputFieldTypeSchema,
  required: z.boolean().optional(),
})
export type AiOutputField = z.infer<typeof aiOutputFieldSchema>

export const aiScalarOutputSchema = z.strictObject({
  kind: z.literal('scalar'),
  type: outputFieldTypeSchema,
})
export const aiObjectOutputSchema = z.strictObject({
  kind: z.literal('object'),
  fields: z.array(aiOutputFieldSchema).min(1).max(32),
})
export const aiOutputSchemaSchema = z.discriminatedUnion('kind', [
  aiScalarOutputSchema,
  aiObjectOutputSchema,
])
export type AiOutputSchema = z.infer<typeof aiOutputSchemaSchema>

export type OutputShape =
  | { kind: 'unknown' }
  | { kind: 'scalar'; type: OutputFieldType | 'json' }
  | { kind: 'object'; fields: readonly { name: string; type: OutputFieldType; required: boolean }[] }

export function fieldsOfOutputSchema(schema: AiOutputSchema): readonly AiOutputField[] {
  return schema.kind === 'object' ? schema.fields : []
}

export function parseAiOutput(
  raw: unknown,
  schema: AiOutputSchema,
): { ok: true; value: JsonValue } | { ok: false; code: 'AI_OUTPUT_INVALID'; message: string } {
  if (schema.kind === 'scalar') {
    const parsed = parseScalar(raw, schema.type)
    if (!parsed.ok) return parsed
    return { ok: true, value: parsed.value }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'AI_OUTPUT_INVALID', message: '提取结果必须是对象' }
  }
  const source = raw as Record<string, unknown>
  const extra = Object.getOwnPropertyNames(source).filter(
    (key) => !schema.fields.some((field) => field.name === key),
  )
  if (extra.length > 0) {
    return { ok: false, code: 'AI_OUTPUT_INVALID', message: `提取结果含未声明字段：${extra.join(', ')}` }
  }
  const out: Record<string, JsonValue> = {}
  for (const field of schema.fields) {
    const required = field.required !== false
    if (!Object.hasOwn(source, field.name)) {
      if (required) {
        return { ok: false, code: 'AI_OUTPUT_INVALID', message: `缺少必填字段 ${field.name}` }
      }
      continue
    }
    const parsed = parseScalar(source[field.name], field.type)
    if (!parsed.ok) {
      return { ok: false, code: 'AI_OUTPUT_INVALID', message: `字段 ${field.name} ${parsed.message}` }
    }
    // 页面还在加载时模型倾向于回空串而不是报错。必填字段放行空值会把这个错误
    // 顺着 context 传给后续步骤，失败点离原因很远，也拿不到本步的重试机会。
    if (required && typeof parsed.value === 'string' && parsed.value.trim() === '') {
      return { ok: false, code: 'AI_OUTPUT_INVALID', message: `必填字段 ${field.name} 取到空值` }
    }
    out[field.name] = parsed.value
  }
  return { ok: true, value: jsonValueSchema.parse(out) }
}

function parseScalar(
  raw: unknown,
  type: OutputFieldType,
): { ok: true; value: JsonValue } | { ok: false; code: 'AI_OUTPUT_INVALID'; message: string } {
  if (type === 'string') {
    if (typeof raw !== 'string') return { ok: false, code: 'AI_OUTPUT_INVALID', message: '须为字符串' }
    return { ok: true, value: raw }
  }
  if (type === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { ok: false, code: 'AI_OUTPUT_INVALID', message: '须为有限数字' }
    }
    return { ok: true, value: raw }
  }
  if (typeof raw !== 'boolean') return { ok: false, code: 'AI_OUTPUT_INVALID', message: '须为布尔值' }
  return { ok: true, value: raw }
}

export function scalarToFillText(value: JsonValue): { ok: true; text: string } | { ok: false; message: string } {
  if (typeof value === 'string') return { ok: true, text: value }
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, text: String(value) }
  if (typeof value === 'boolean') return { ok: true, text: value ? 'true' : 'false' }
  return { ok: false, message: '对象不能被隐式序列化后写入输入框' }
}

export function readContextValue(
  context: Record<string, JsonValue>,
  from: string,
  fromField?: string,
): { ok: true; value: JsonValue } | { ok: false; code: 'UNRESOLVED_REF'; message: string } {
  if (!Object.hasOwn(context, from)) {
    return { ok: false, code: 'UNRESOLVED_REF', message: `context 中不存在 ${from}` }
  }
  const value = context[from]
  if (value === undefined) {
    return { ok: false, code: 'UNRESOLVED_REF', message: `context 中不存在 ${from}` }
  }
  if (!fromField) return { ok: true, value }
  return readOwnField(value, fromField)
}

/**
 * fill 取值。有 fromField 时只接受标量；没有 fromField 时保留历史
 * `JSON.stringify`，不得用当前编译规则重解释旧快照。
 */
export function fillTextFromContext(
  context: Record<string, JsonValue>,
  from: string,
  fromField?: string,
): { ok: true; text: string } | { ok: false; code: 'UNRESOLVED_REF' | 'AI_OUTPUT_INVALID'; message: string } {
  const resolved = readContextValue(context, from, fromField)
  if (!resolved.ok) return resolved
  if (fromField) {
    const text = scalarToFillText(resolved.value)
    if (!text.ok) return { ok: false, code: 'AI_OUTPUT_INVALID', message: text.message }
    return { ok: true, text: text.text }
  }
  if (typeof resolved.value === 'string') return { ok: true, text: resolved.value }
  return { ok: true, text: JSON.stringify(resolved.value) }
}

export function readOwnField(
  value: JsonValue,
  field: string,
): { ok: true; value: JsonValue } | { ok: false; code: 'UNRESOLVED_REF'; message: string } {
  if ((FORBIDDEN_OUTPUT_FIELD_NAMES as readonly string[]).includes(field)) {
    return { ok: false, code: 'UNRESOLVED_REF', message: `字段名 ${field} 为保留属性` }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'UNRESOLVED_REF', message: '来源不是对象，无法读取字段' }
  }
  if (!Object.hasOwn(value, field)) {
    return { ok: false, code: 'UNRESOLVED_REF', message: `来源对象没有字段 ${field}` }
  }
  return { ok: true, value: jsonValueSchema.parse((value as Record<string, JsonValue>)[field]) }
}
