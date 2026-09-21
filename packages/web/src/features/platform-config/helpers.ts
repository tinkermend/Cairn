import {
  FACTORY_RESOLUTION_CEILING,
  FACTORY_RESOLUTION_DEFAULT,
  type PlatformConfigDocument,
} from '@cairn/shared'

export function cloneDocument(
  document: PlatformConfigDocument
): PlatformConfigDocument {
  const next = structuredClone(document)
  next.browserAi.resolutionCeiling ||= FACTORY_RESOLUTION_CEILING
  next.browserAi.defaultResolution ||= FACTORY_RESOLUTION_DEFAULT
  if (!next.platformAi.provider) delete next.platformAi.provider
  return next
}

export function formatTime(value: string) {
  return new Date(value).toLocaleString('zh-CN')
}
