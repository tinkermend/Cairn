import type { Locator } from 'playwright'
import { BrowserCapabilityMissingError } from './runtime.js'

export type AriaMatchResult =
  | { kind: 'matched' }
  | { kind: 'mismatch'; received: string; message: string }
  | { kind: 'template_invalid'; message: string }
  | { kind: 'error'; error: unknown }

type LocatorWithExpect = Locator & {
  _expect(
    matcherName: string,
    options: {
      expectedValue?: unknown
      isNot?: boolean
      timeout?: number
      signal?: AbortSignal
    },
  ): Promise<{
    matches: boolean
    received?: { value?: { raw?: string; regex?: string } | string } | unknown
    log?: string[]
    timedOut?: boolean
    errorMessage?: string
  }>
}

/**
 * 使用 Playwright 内部同一匹配引擎执行 aria 模板比对。
 * 仅本文件允许调用 `_expect('to.match.aria')`。
 */
export async function matchAriaSnapshot(
  locator: Locator,
  template: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AriaMatchResult> {
  signal?.throwIfAborted()
  const loc = locator as LocatorWithExpect
  if (typeof loc._expect !== 'function') {
    return {
      kind: 'error',
      error: new BrowserCapabilityMissingError('当前 Playwright 版本不支持 _expect (to.match.aria)'),
    }
  }
  try {
    const raw = await loc._expect('to.match.aria', {
      expectedValue: template,
      isNot: false,
      timeout: timeoutMs,
      signal,
    })

    if (raw.matches) {
      return { kind: 'matched' }
    }

    // 模板非法：Playwright 立即返回 matches: false，无 timedOut，带 errorMessage
    if (!raw.timedOut && raw.errorMessage) {
      return {
        kind: 'template_invalid',
        message: raw.errorMessage.slice(0, 1024),
      }
    }

    // 匹配超时/不匹配
    let receivedVal = ''
    if (raw.received && typeof raw.received === 'object') {
      const v = (raw.received as { value?: unknown }).value
      if (v && typeof v === 'object' && 'raw' in v && typeof (v as { raw: unknown }).raw === 'string') {
        receivedVal = (v as { raw: string }).raw
      } else if (typeof v === 'string') {
        receivedVal = v
      }
    }

    return {
      kind: 'mismatch',
      received: receivedVal,
      message: raw.errorMessage ? raw.errorMessage.slice(0, 1024) : 'Aria snapshot mismatch',
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    return {
      kind: 'template_invalid',
      message: message.slice(0, 1024),
    }
  }
}
