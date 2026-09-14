import type { RecordingItem } from '@cairn/shared'

type Candidate = { by: string; value: string; name?: string }

const MAX_LABEL = 40

function truncate(value: string): string {
  const text = value.trim()
  return text.length > MAX_LABEL ? `${text.slice(0, MAX_LABEL)}…` : text
}

function readCandidates(item: RecordingItem): Candidate[] {
  const input = item.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const target = (input as { target?: unknown }).target
  if (!target || typeof target !== 'object' || Array.isArray(target)) return []
  const list = (target as { candidates?: unknown }).candidates
  if (!Array.isArray(list)) return []
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const { by, value, name } = entry as Record<string, unknown>
    if (typeof by !== 'string' || typeof value !== 'string') return []
    return [{ by, value, name: typeof name === 'string' ? name : undefined }]
  })
}

/**
 * 一行读得懂的定位说明。列表里连着 8 个「点击」时，用户要靠这行分辨录到了哪个元素。
 * 优先用语义定位；只有没有语义定位时才退回 CSS。
 */
export function describeStepTarget(item: RecordingItem): string | null {
  const candidates = readCandidates(item)
  if (candidates.length === 0) return null
  const preferred = candidates.find((candidate) => candidate.by !== 'css') ?? candidates[0]!
  const value = truncate(preferred.value)
  switch (preferred.by) {
    case 'role':
      return preferred.name ? `${value}「${truncate(preferred.name)}」` : value
    case 'label':
      return `标签「${value}」`
    case 'text':
      return `文本「${value}」`
    case 'title':
      return `标题「${value}」`
    case 'testId':
      return `data-testid=${value}`
    default:
      return value
  }
}

/** 展开时给出的原始事实，与控制台草稿详情同一套字段。 */
export function stepDetail(item: RecordingItem): Record<string, unknown> {
  return {
    sourceAction: item.sourceAction,
    status: item.status,
    candidateStepType: item.candidateStepType ?? null,
    pageAlias: item.pageAlias ?? null,
    framePath: item.framePath ?? [],
    input: item.input ?? null,
  }
}

export function stepDetailJson(item: RecordingItem): string {
  return JSON.stringify(stepDetail(item), null, 2)
}
