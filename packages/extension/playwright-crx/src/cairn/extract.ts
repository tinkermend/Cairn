import { parseJsonlSource } from '@cairn/shared'
import type { Source } from '@recorder/recorderTypes'

export function extractRecordingEvents(sources: readonly Source[]): unknown[] {
  const source = sources.find((item) => item.id === 'jsonl')
  if (!source) return []
  return parseJsonlSource({ text: source.text, actions: source.actions })
}
