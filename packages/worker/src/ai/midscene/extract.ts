import type { AiOutputSchema } from '@cairn/shared'

/**
 * Midscene 用第一个参数 `dataDemand` 约束模型输出形状，options 里没有 schema 这一档。
 * 字段名必须由作者声明的 Output Schema 决定并原样送进提示，否则模型会照 instruction
 * 的措辞自造键名，之后必然被平台的 Schema 校验判为「含未声明字段」。
 */
export function buildDataDemand(instruction: string, schema: AiOutputSchema | undefined): string {
  if (!schema) return instruction
  if (schema.kind === 'scalar') return `${schema.type}, ${instruction}`
  const shape = schema.fields
    .map((field) => `${field.name}${field.required === false ? '?' : ''}: ${field.type}`)
    .join(', ')
  return `{${shape}}，只返回这些键，键名原样使用。${instruction}`
}

export type StringField =
  | { ok: true; value: string }
  | { ok: false; reason: 'missing' | 'not_string' | 'empty' }

/** AI 输出必须先取出字符串字段再进 context。整包对象交给 fill.from 会 JSON.stringify。 */
export function takeStringField(output: unknown, field: string): StringField {
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    return { ok: false, reason: 'missing' }
  }
  if (!Object.hasOwn(output, field)) return { ok: false, reason: 'missing' }
  const value = (output as Record<string, unknown>)[field]
  if (typeof value !== 'string') return { ok: false, reason: 'not_string' }
  if (value.trim() === '') return { ok: false, reason: 'empty' }
  return { ok: true, value }
}

export function detectFabrication(pageText: string, value: string): boolean {
  return !pageText.includes(value)
}
