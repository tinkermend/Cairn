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
