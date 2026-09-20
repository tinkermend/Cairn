/** 官方 ddddocr README 的 set_ranges 整数表，不是新模块里按 charset 切片。 */
export const DDDDOCR_RANGE_PRESETS = {
  0: '0123456789',
  1: 'abcdefghijklmnopqrstuvwxyz',
  2: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  3: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  4: 'abcdefghijklmnopqrstuvwxyz0123456789',
  5: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  6: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
} as const

export type CharsetRange = number | string

export function resolveCharsetChars(range?: CharsetRange | null): Set<string> | null {
  if (range == null) return null
  if (typeof range === 'number') {
    if (range === 7) return null
    const preset = DDDDOCR_RANGE_PRESETS[range as keyof typeof DDDDOCR_RANGE_PRESETS]
    if (!preset) return null
    return new Set(preset)
  }
  const trimmed = range.replace(/\s+/g, '')
  if (!trimmed) return null
  return new Set(trimmed)
}

export function allowedCharsetIndices(charsets: readonly string[], range?: CharsetRange | null): Set<number> | null {
  const allowed = resolveCharsetChars(range)
  if (!allowed) return null
  const indices = new Set<number>()
  for (let i = 0; i < charsets.length; i += 1) {
    const ch = charsets[i]
    if (ch && allowed.has(ch)) indices.add(i)
  }
  return indices
}

export function expectedPatternFor(input: {
  charsetRange?: CharsetRange | null
  expectedLength?: number | null
}): RegExp | undefined {
  const length = input.expectedLength
  if (!length || length < 1) return undefined
  const allowed = resolveCharsetChars(input.charsetRange)
  if (!allowed || allowed.size === 0) {
    return new RegExp(`^.{${length}}$`)
  }
  const escaped = [...allowed].map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
  return new RegExp(`^[${escaped}]{${length}}$`)
}
