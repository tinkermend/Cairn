import type { JsonValue } from './wire.js'

export const REDACTED = '[redacted]' as const

/**
 * 值级脱敏。不猜字段名：只替换 `secrets` 里出现过的明文。
 * 更长的秘密优先，避免短串先替换把长串拆碎。
 */
export function redactJson(payload: JsonValue, secrets: readonly string[]): JsonValue {
  const needles = [...new Set(secrets.filter((item) => item.length > 0))].sort(
    (a, b) => b.length - a.length,
  )
  if (needles.length === 0) return payload
  return walk(payload, needles)
}

function walk(value: JsonValue, needles: readonly string[]): JsonValue {
  if (typeof value === 'string') return redactString(value, needles)
  if (Array.isArray(value)) return value.map((item) => walk(item, needles))
  if (value && typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = walk(item, needles)
    }
    return out
  }
  return value
}

function redactString(value: string, needles: readonly string[]): string {
  let out = value
  for (const secret of needles) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED)
  }
  return out
}
