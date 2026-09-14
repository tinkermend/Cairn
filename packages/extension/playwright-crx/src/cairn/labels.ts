import type { RecordingItem } from '@cairn/shared'

export const RECORDING_STATUS_LABEL: Record<RecordingItem['status'], string> = {
  mapped: '已映射',
  parameterized: '待补参数',
  unresolved: '待处理',
}

export function recordingItemMeta(item: RecordingItem): string {
  const parts = [RECORDING_STATUS_LABEL[item.status]]
  if (item.candidateStepType) parts.push(item.candidateStepType)
  if (item.sensitive) parts.push('敏感值已排除')
  if (item.framePath?.length) parts.push(`frame ${item.framePath.join(' > ')}`)
  return parts.join(' · ')
}
