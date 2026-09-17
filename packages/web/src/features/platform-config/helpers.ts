import type { PlatformConfigDocument } from '@cairn/shared'

export function cloneDocument(
  document: PlatformConfigDocument
): PlatformConfigDocument {
  return structuredClone(document)
}

export function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN')
}
