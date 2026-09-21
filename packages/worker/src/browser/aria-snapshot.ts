import type { Frame, Locator, Page } from 'playwright'
import { sanitizeAriaSnapshot } from '@cairn/shared'

export const DEFAULT_ARIA_SNAPSHOT_MAX_LENGTH = 12_000

export interface GetAriaSnapshotOptions {
  timeoutMs: number
  depth?: number
  mode?: 'default' | 'ai'
  signal?: AbortSignal
  maxLength?: number
}

export interface GetAriaSnapshotResult {
  text: string
  truncated: boolean
}

/**
 * 在受管页面/定位器上提取无障碍树快照，并进行长度截断和敏感数据脱敏。
 * 必须在受管会话内调用。
 */
export async function getAriaSnapshot(
  scope: Page | Frame | Locator,
  options: GetAriaSnapshotOptions,
): Promise<GetAriaSnapshotResult> {
  options.signal?.throwIfAborted()

  // 阶段 A 固定 mode: 'default'，确保产出稳定不带临时 ref 的快照文本
  const raw = await (scope as Locator).ariaSnapshot({
    timeout: options.timeoutMs,
    depth: options.depth,
  })

  options.signal?.throwIfAborted()

  const maxLen = options.maxLength ?? DEFAULT_ARIA_SNAPSHOT_MAX_LENGTH
  let truncated = false
  let text = raw

  if (text.length > maxLen) {
    text = text.slice(0, maxLen)
    truncated = true
  }

  const sanitized = sanitizeAriaSnapshot(text)
  return {
    text: sanitized,
    truncated,
  }
}
