import { RECORDER_SOURCE_VERSION, normalizeRecording, type NormalizeRecordingResult } from '@cairn/shared'
import type { Source } from '@recorder/recorderTypes'
import { extractRecordingEvents } from './extract'

export type RecordingPreview = NormalizeRecordingResult & {
  /** items[i] 对应的原始 JSONL 行下标。删除按原始下标做：步骤编号会随删除重排。 */
  sourceRows: number[][]
  /** items[i] 在被录页面上的 selector，用于高亮；navigate 这类没有就是 null。 */
  selectors: (string | null)[]
}

export type RecordingPreviewResult = RecordingPreview | { error: string } | null

function selectorOf(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null
  const selector = (row as { selector?: unknown }).selector
  return typeof selector === 'string' && selector ? selector : null
}

/**
 * 排除发生在归一化之前：连续 `fill` 合并、`about:blank` 丢弃这些规则会随保留下来的行变化，
 * 只在界面上隐藏会让列表和上传包对不上。
 */
export function previewRecording(
  sources: readonly Source[],
  excluded: readonly number[] = [],
): RecordingPreviewResult {
  const rows = extractRecordingEvents(sources)
  if (!rows.length) return null

  const keptRows: number[] = []
  const kept: unknown[] = []
  rows.forEach((row, index) => {
    if (excluded.includes(index)) return
    kept.push(row)
    keptRows.push(index)
  })
  if (!kept.length) return { error: '这段操作都删掉了，撤销或重新录制' }

  const result = normalizeRecording(kept, { sourceVersion: RECORDER_SOURCE_VERSION })
  const sourceRows = result.items.map((item) => item.sourceIndexes.map((index) => keptRows[index]!))
  const selectors = sourceRows.map((indexes) => selectorOf(rows[indexes[0]!]))
  return { ...result, sourceRows, selectors }
}
