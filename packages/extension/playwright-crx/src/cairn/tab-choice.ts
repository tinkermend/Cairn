export type RecordableTab = {
  id?: number
  url?: string
  active?: boolean
}

/** 扩展页、chrome:// 与 edge:// 都挂不上，也不该被当成用户要录的页面。 */
export function canRecordTab(tab: RecordableTab | undefined): boolean {
  if (!tab?.id) return false
  const url = tab.url ?? ''
  if (!url) return false
  return !url.startsWith('chrome') && !url.startsWith('edge://')
}

function isBlank(tab: RecordableTab): boolean {
  return (tab.url ?? '').startsWith('about:')
}

/**
 * 用户点「录制」时想录的是自己正看的那一页。
 * 侧栏不抢标签页焦点，所以活动标签页优先；活动页是扩展页或 chrome:// 时才退回记住的那个。
 */
export function chooseRecordingTab<T extends RecordableTab>(
  tabs: readonly T[],
  remembered?: T,
): T | undefined {
  const attachable = tabs.filter((tab) => canRecordTab(tab))
  const active = attachable.find((tab) => tab.active)
  if (active) return active
  if (remembered && canRecordTab(remembered)) return remembered
  return attachable.find((tab) => !isBlank(tab)) ?? attachable[0]
}
