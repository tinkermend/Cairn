export type HttpByteRange = { start: number; end: number }

export function parseHttpRange(
  header: string | undefined,
  size: number,
): HttpByteRange | 'unsatisfiable' | null {
  if (!header || !Number.isFinite(size) || size <= 0) return header ? 'unsatisfiable' : null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim())
  if (!match) return 'unsatisfiable'
  const rawStart = match[1]
  const rawEnd = match[2]
  if (!rawStart && !rawEnd) return 'unsatisfiable'
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (!Number.isInteger(suffix) || suffix <= 0) return 'unsatisfiable'
    const start = Math.max(0, size - suffix)
    return { start, end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd ? Number(rawEnd) : size - 1
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    return 'unsatisfiable'
  }
  return { start, end: Math.min(end, size - 1) }
}

export function contentRangeHeader(range: HttpByteRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`
}
