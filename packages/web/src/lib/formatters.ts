/**
 * 平台通用格式化工具函数库
 * 统一前端各业务模块（监控、节点、运行、场景集、会话）中分散的日期、相对时间与耗时格式化逻辑
 */

/**
 * 格式化 ISO 日期时间为本地展示格式（例如：2026/9/28 20:00:00）
 * 保持 24 小时制，全平台统一
 */
export function formatAsOf(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : '—'
  return date.toLocaleString('zh-CN', { hour12: false })
}

/**
 * 格式化时间为时分秒纯时间文本（例如：20:15:30）
 */
export function formatClock(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * 格式化相对时间（例如：刚刚、5分钟前、2小时前、3天前）
 */
export function formatRelativeTime(value: string | Date | null | undefined): string {
  if (!value) return ''
  const date = typeof value === 'string' ? new Date(value) : value
  const diffMs = Date.now() - date.getTime()
  if (Number.isNaN(diffMs)) return ''
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return '刚刚'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}小时前`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay < 30) return `${diffDay}天前`
  return date.toLocaleDateString('zh-CN')
}

/**
 * 计算两个时间戳之间的运行历时并格式化
 * < 1s => `${ms} ms`
 * < 10s => `${(ms / 1000).toFixed(1)} s`
 * >= 10s => `${Math.round(ms / 1000)} s`
 */
export function formatDuration(
  startedAt: string | null | undefined,
  finishedAt: string | null | undefined,
): string | null {
  if (!startedAt || !finishedAt) return null
  const ms = Date.parse(finishedAt) - Date.parse(startedAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 1000) return `${ms} ms`
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 1000)} s`
}

/**
 * 格式化毫秒耗时为友好中文文本
 * 例如：500 => '< 1秒'，3500 => '4秒'，75000 => '1分15秒'
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return '< 1秒'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}秒`
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}
