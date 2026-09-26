import { randomUUID } from 'node:crypto'
import type { ElementHandle } from 'playwright'
import type {
  AssertExpect,
  BrowserCommand,
  BrowserCommandEvidence,
  BrowserCommandResult,
  JsonValue,
  ResolverDiagnostics,
  TargetDescriptor,
} from '@cairn/shared'
import type { Locator, Page } from './runtime'
import {
  BrowserCapabilityMissingError,
  SurfaceLostError,
  clickLocator,
  countCandidateNow,
  detectCapabilityGap,
  fillLocator,
  isLocatorVisible,
  locatorForCandidate,
  navigateInScope,
  pageClosed,
  pressKeys,
  readLocator,
  readLocatorMany,
  resolveFramePath,
  scopeForAnchor,
  screenshotPage,
  selectLocator,
  uploadToLocator,
  waitForPopup,
  waitOnPage,
} from './runtime'
import { candidateTries, errorForOutcome, pickResolvedCandidate } from './resolver'
import { safeDownloadFileName, sanitizeAriaSnapshot } from '@cairn/shared'
import { matchAriaSnapshot } from './aria-match.js'

export type SurfacePage = Page

const DEFAULT_LOCATE_MS = 8_000
// Opaque handles stay within the managed browser and never enter a Run snapshot.
const locatedTargets = new WeakMap<Page, Map<string, { handle: ElementHandle; expiresAt: number }>>()

async function rememberTarget(page: Page, locator: Locator): Promise<string | undefined> {
  const handles = await locator.elementHandles()
  if (handles.length !== 1) {
    await Promise.all(handles.map(handle => handle.dispose()))
    return undefined
  }
  const entries = locatedTargets.get(page) ?? new Map()
  for (const [key, value] of entries) {
    if (entries.size >= 5 || value.expiresAt <= Date.now()) {
      entries.delete(key)
      await value.handle.dispose().catch(() => undefined)
    }
  }
  const token = randomUUID()
  entries.set(token, { handle: handles[0]!, expiresAt: Date.now() + 5_000 })
  locatedTargets.set(page, entries)
  return token
}

async function readRememberedTarget(page: Page, locator: Locator,
  command: Extract<BrowserCommand, { type: 'extract' | 'assert' }>, signal?: AbortSignal,
): Promise<BrowserCommandResult> {
  const entries = locatedTargets.get(page)
  const receipt = entries?.get(command.expectedTargetToken!)
  entries?.delete(command.expectedTargetToken!)
  if (!receipt || receipt.expiresAt <= Date.now()) {
    await receipt?.handle.dispose().catch(() => undefined)
    return failOutcome('SURFACE_LOST', { outcome: 'SURFACE_LOST', candidatesTried: [] })
  }
  try {
    const handles = await locator.elementHandles()
    try {
      signal?.throwIfAborted()
      if (handles.length !== 1) return failOutcome('AMBIGUOUS', { outcome: 'AMBIGUOUS', candidatesTried: [] })
      // Node identity, connectedness and the read happen in one browser task. A dynamic
      // Locator must not retarget a replacement node between comparison and extraction.
      const sample = await receipt.handle.evaluate((node, args) => {
        if (!node.isConnected || node !== args.current) return null
        const element = node as unknown as { innerText: string; value?: string; offsetWidth: number; offsetHeight: number;
          getAttribute(name: string): string | null; getClientRects(): { length: number };
          ownerDocument: { defaultView: { getComputedStyle(element: unknown): { visibility: string } } } }
        return {
          text: element.innerText,
          value: typeof element.value === 'string' ? element.value : null,
          attribute: args.attribute ? element.getAttribute(args.attribute) ?? '' : '',
          visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length) && element.ownerDocument.defaultView.getComputedStyle(element).visibility === 'visible',
        }
      }, { current: handles[0]!, attribute: command.type === 'extract' ? command.attribute : undefined })
      signal?.throwIfAborted()
      if (!sample) return failOutcome('SURFACE_LOST', { outcome: 'SURFACE_LOST', candidatesTried: [] })
      if (command.type === 'extract') {
        const value = sample[command.as]
        if (typeof value !== 'string') throw new Error('目标元素不支持请求的提取方式')
        return { ok: true, output: { value } }
      }
      if (typeof sample.text !== 'string' && command.expect.kind !== 'exists' && command.expect.kind !== 'visible') throw new Error('目标元素不支持文本断言')
      const expected = command.expect
      if (expected.kind === 'aria_snapshot') {
        throw new Error('aria_snapshot 断言不支持通过 remembered target token 执行')
      }
      const actual = expected.kind === 'exists' ? 1 : expected.kind === 'visible' ? sample.visible :
        expected.kind === 'number_compare' ? Number(sample.text.replace(/[^\d.-]/g, '')) : sample.text
      const passed = expected.kind === 'exists' ? true : expected.kind === 'visible' ? sample.visible :
        expected.kind === 'text_equals' ? actual === expected.value : expected.kind === 'text_contains' ? sample.text.includes(expected.value) :
        typeof actual === 'number' && Number.isFinite(actual) && compareNumber(actual, expected.op, expected.value)
      const output = { passed, expected: expected.kind === 'exists' ? 1 : expected.kind === 'visible' ? true :
        expected.kind === 'number_compare' ? { op: expected.op, value: expected.value } : expected.value,
        actual: typeof actual === 'number' && !Number.isFinite(actual) ? sample.text : actual }
      return passed ? { ok: true, output } : { ok: false, output,
        error: { code: 'ASSERT_FAILED', category: 'EXECUTOR', retryable: false, safeMessage: '断言不成立' } }
    } finally { await Promise.all(handles.map(handle => handle.dispose().catch(() => undefined))) }
  } finally { await receipt.handle.dispose().catch(() => undefined) }
}

export { safeDownloadFileName }

export async function executeOnPage(
  page: Page,
  command: BrowserCommand,
  signal?: AbortSignal,
  evidence?: BrowserCommandEvidence,
): Promise<BrowserCommandResult & { screenshotBytes?: Buffer; downloadPath?: string }> {
  if (signal?.aborted) {
    return {
      ok: false,
      error: {
        code: 'CANCELLED',
        category: 'CANCELLED',
        retryable: false,
        safeMessage: '步骤已取消',
      },
    }
  }
  if (pageClosed(page)) {
    return failOutcome('SURFACE_LOST', { outcome: 'SURFACE_LOST', candidatesTried: [] })
  }

  let diagnostics: ResolverDiagnostics = { outcome: 'FOUND', candidatesTried: [] }
  try {
    if (command.type === 'navigate') {
      const result = await navigateInScope(page, command.url, command.allowedOrigins)
      if ('outOfScope' in result) {
        return {
          ok: false,
          error: {
            code: 'NAVIGATE_OUT_OF_SCOPE',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: `导航目标不在 Target 授权范围：${result.href}`,
          },
        }
      }
      return { ok: true, output: { url: result.href } }
    }

    if (command.type === 'wait' && command.kind === 'time') {
      await waitOnPage(page, { kind: 'time', durationMs: command.durationMs }, signal)
      return { ok: true, output: { waitedMs: command.durationMs ?? 0 } }
    }
    if (command.type === 'wait' && command.kind === 'url') {
      await waitOnPage(page, { kind: 'url', urlPattern: command.urlPattern, timeoutMs: command.timeoutMs }, signal)
      return { ok: true, output: { url: page.url() } }
    }
    if (command.type === 'keyboard' && !command.target) {
      await pressKeys(page, command.keys)
      return { ok: true, output: {} }
    }

    if (command.type === 'assert' && !command.target && command.expect.kind !== 'aria_snapshot') {
      return {
        ok: false,
        error: {
          code: 'TARGET_NOT_FOUND',
          category: 'VALIDATION',
          retryable: false,
          safeMessage: 'assert 缺少 target，无法取值',
        },
      }
    }

    if (command.type === 'probe') {
      const probeFailed = (error: unknown): BrowserCommandResult => {
        if (isAbortError(error)) throw error
        if (error instanceof SurfaceLostError || isClosedMessage(error)) {
          return failOutcome('SURFACE_LOST', { outcome: 'SURFACE_LOST', candidatesTried: [] })
        }
        return {
          ok: false,
          error: {
            code: 'PROBE_FAILED',
            category: 'INFRASTRUCTURE',
            retryable: true,
            safeMessage: '页面检查时页面不可用',
          },
        }
      }

      if (command.probeKind === 'url') {
        const waitMs = command.waitMs ?? 1000
        const pattern = command.urlPattern ?? ''
        const matches = (u: string) => {
          if (!pattern) return false
          try {
            return new RegExp(pattern).test(u)
          } catch {
            return false
          }
        }
        try {
          let currentUrl = page.url()
          if (matches(currentUrl)) {
            return { ok: true, output: { matched: true, url: currentUrl } }
          }
          const start = Date.now()
          while (Date.now() - start < waitMs) {
            signal?.throwIfAborted()
            await page.waitForTimeout(Math.min(100, Math.max(1, waitMs - (Date.now() - start))))
            currentUrl = page.url()
            if (matches(currentUrl)) {
              return { ok: true, output: { matched: true, url: currentUrl } }
            }
          }
          return { ok: true, output: { matched: false, url: currentUrl } }
        } catch (error) {
          return probeFailed(error)
        }
      }

      if (command.probeKind === 'text') {
        const waitMs = command.waitMs ?? 1000
        const text = command.text ?? ''
        const start = Date.now()
        while (true) {
          signal?.throwIfAborted()
          try {
            let loc: Locator | undefined
            if (command.target) {
              const located = await locate(page, command.target, 200, signal, true)
              if (located.kind === 'miss') {
                if (located.outcome !== 'NOT_FOUND') {
                  return failOutcome(located.outcome, located.diagnostics)
                }
              } else {
                loc = located.locator.getByText(text)
              }
            } else {
              loc = page.getByText(text)
            }
            if (loc) {
              const count = await loc.count()
              if (count > 0) return { ok: true, output: { matched: true, count } }
            }
          } catch (error) {
            return probeFailed(error)
          }
          if (Date.now() - start >= waitMs) break
          await page.waitForTimeout(Math.min(100, Math.max(1, waitMs - (Date.now() - start))))
        }
        return { ok: true, output: { matched: false, count: 0 } }
      }

      if (command.probeKind === 'element') {
        const waitMs = command.waitMs ?? 1000
        const state = command.state ?? 'visible'
        if (!command.target) {
          return {
            ok: false,
            error: {
              code: 'PROBE_FAILED',
              category: 'VALIDATION',
              retryable: false,
              safeMessage: '元素检查缺少定位目标',
            },
          }
        }
        const start = Date.now()
        while (true) {
          signal?.throwIfAborted()
          try {
            const located = await locate(page, command.target, Math.min(waitMs, 500), signal, true)
            if (located.kind === 'miss') {
              if (located.outcome !== 'NOT_FOUND') {
                return failOutcome(located.outcome, located.diagnostics)
              }
            } else {
              const count = await located.locator.count()
              if (count > 0) {
                if (state === 'present') {
                  return { ok: true, output: { matched: true, count } }
                }
                let visibleCount = 0
                for (let i = 0; i < count; i++) {
                  if (await located.locator.nth(i).isVisible()) visibleCount++
                }
                if (visibleCount > 0) {
                  return { ok: true, output: { matched: true, count: visibleCount } }
                }
              }
            }
          } catch (error) {
            return probeFailed(error)
          }
          if (Date.now() - start >= waitMs) break
          await page.waitForTimeout(Math.min(100, Math.max(1, waitMs - (Date.now() - start))))
        }
        return { ok: true, output: { matched: false, count: 0 } }
      }

      return { ok: true, output: { matched: false } }
    }

    const target = 'target' in command ? command.target : undefined
    let locatedLocator: Locator

    if (!target) {
      if (command.type === 'assert' && command.expect.kind === 'aria_snapshot') {
        locatedLocator = page.locator('body')
      } else {
        return {
          ok: false,
          error: {
            code: 'TARGET_NOT_FOUND',
            category: 'VALIDATION',
            retryable: false,
            safeMessage: '步骤缺少 target',
          },
        }
      }
    } else {
      const allowMultiple = command.type === 'extract' && Boolean(command.many)
      const timeoutMs = (command.type === 'locate' || command.type === 'extract') ? command.timeoutMs : undefined
      const located = await locate(page, target, timeoutMs, signal, allowMultiple)
      signal?.throwIfAborted()
      if (located.kind !== 'found') {
        return failOutcome(located.outcome, located.diagnostics)
      }
      locatedLocator = located.locator
      diagnostics = located.diagnostics
    }

    if (command.type === 'locate') {
      const resolvedTargetToken = await rememberTarget(page, locatedLocator)
      signal?.throwIfAborted()
      if (!resolvedTargetToken) return failOutcome('SURFACE_LOST', diagnostics)
      return { ok: true, output: {}, diagnostics, resolvedTargetToken }
    }

    if ((command.type === 'extract' || command.type === 'assert') && command.expectedTargetToken) {
      return { ...await readRememberedTarget(page, locatedLocator, command, signal), diagnostics }
    }

    if (command.type === 'click') {
      const popup = await waitForPopup(page, () =>
        clickLocator(locatedLocator, {
          button: command.button,
          clickCount: command.clickCount,
          modifiers: command.modifiers,
        }),
      )
      if (popup) {
        // P5：点击可以打开 popup，但不把新窗收成后续步骤的当前 Surface。
        await popup.waitForLoadState('domcontentloaded').catch(() => undefined)
      }
      return { ok: true, output: {}, diagnostics }
    }

    if (command.type === 'fill') {
      await fillLocator(locatedLocator, command.value)
      return { ok: true, output: {}, diagnostics }
    }

    if (command.type === 'extract') {
      if (command.many) {
        const count = await locatedLocator.count()
        if (count > command.many.maxItems) {
          return {
            ok: false,
            error: {
              code: 'EXTRACT_TOO_MANY',
              category: 'EXECUTOR',
              retryable: false,
              safeMessage: `提取匹配项超过上限 ${command.many.maxItems}（实际匹配 ${count} 项）`,
            },
            output: {},
            diagnostics,
          }
        }
        if (command.many.minItems !== undefined && count < command.many.minItems) {
          return {
            ok: false,
            error: {
              code: 'EXTRACT_TOO_FEW',
              category: 'EXECUTOR',
              retryable: false,
              safeMessage: `提取匹配项少于下限 ${command.many.minItems}（实际匹配 ${count} 项）`,
            },
            output: {},
            diagnostics,
          }
        }
        const value = await readLocatorMany(locatedLocator, command.as, command.attribute)
        return { ok: true, output: { value, count: value.length }, diagnostics }
      }
      const value = await readLocator(locatedLocator, command.as, command.attribute)
      return { ok: true, output: { value }, diagnostics }
    }

    if (command.type === 'select') {
      await selectLocator(locatedLocator, { by: command.by, value: command.value, index: command.index })
      return { ok: true, output: {}, diagnostics }
    }

    if (command.type === 'keyboard') {
      await pressKeys(page, command.keys, locatedLocator)
      return { ok: true, output: {}, diagnostics }
    }

    if (command.type === 'wait') {
      await waitOnPage(
        page,
        {
          kind: command.kind,
          locator: locatedLocator,
          text: command.text,
          timeoutMs: command.timeoutMs,
        },
        signal,
      )
      return { ok: true, output: {}, diagnostics }
    }

    if (command.type === 'upload') {
      const filesForUpload = command.files.map((f) => ({
        ...f,
        sha256: (f as any).sha256 ?? (f as any).digest ?? '',
      }))
      const uploadRes = await uploadToLocator(page, locatedLocator, filesForUpload)
      const output = {
        files: command.files.map((f) => ({
          name: f.name,
          byteSize: f.byteSize,
          mimeType: f.mimeType,
          digest: (f as any).digest ?? (f as any).sha256 ?? '',
        })),
        method: uploadRes.method,
        uploadedAt: new Date().toISOString(),
      }
      return { ok: true, output, diagnostics }
    }

    if (command.type === 'download') {
      if (page) {
        ;(page as any).__cairnDownloadPending = true
      }
      try {
        const waiter = page.waitForEvent('download', { timeout: command.waitMs })
        if (locatedLocator) {
          await locatedLocator.click({ timeout: 5_000 })
        }
        let download: any
        try {
          download = await waiter
        } catch {
          return {
            ok: false,
            error: {
              code: 'DOWNLOAD_TIMEOUT',
              category: 'TIMEOUT',
              retryable: true,
              safeMessage: `等待下载事件超时（${command.waitMs}ms）`,
            },
            diagnostics,
          }
        }

        const failure = await download.failure()
        if (failure) {
          return {
            ok: false,
            error: {
              code: 'DOWNLOAD_FAILED',
              category: 'EXECUTOR',
              retryable: true,
              safeMessage: `浏览器下载失败: ${failure}`,
            },
            diagnostics,
          }
        }

        const rawName = download.suggestedFilename()
        const safeName = safeDownloadFileName(rawName)
        const targetDir = command.saveDir
        const { mkdir } = await import('node:fs/promises')
        const { join } = await import('node:path')
        await mkdir(targetDir, { recursive: true })
        const localPath = join(targetDir, `${randomUUID().slice(0, 8)}-${safeName}`)
        await download.saveAs(localPath)

        return {
          ok: true,
          output: {},
          diagnostics,
          downloadPath: localPath,
        }
      } finally {
        if (page) {
          ;(page as any).__cairnDownloadPending = false
        }
      }
    }

    const assertion = await evaluateAssert(
      locatedLocator,
      command.expect,
      command.timeoutMs,
      signal,
      (evidence?.sensitiveSelectors?.length ?? 0) > 0,
    )
    if (!assertion.passed) {
      if (assertion.error?.code === 'ASSERT_TEMPLATE_INVALID') {
        return {
          ok: false,
          error: {
            code: 'ASSERT_TEMPLATE_INVALID',
            category: 'EXECUTOR',
            retryable: false,
            safeMessage: assertion.error.message || 'Aria 模板非法',
          },
          output: assertion,
          diagnostics,
        }
      }
      return {
        ok: false,
        error: {
          code: 'ASSERT_FAILED',
          category: 'EXECUTOR',
          retryable: false,
          safeMessage: '断言不成立',
        },
        output: assertion,
        diagnostics,
      }
    }
    return { ok: true, output: assertion, diagnostics }
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: { code: 'CANCELLED', category: 'CANCELLED', retryable: false, safeMessage: '步骤已取消' } }
    if (error instanceof BrowserCapabilityMissingError) {
      return {
        ok: false,
        error: {
          code: 'BROWSER_CAPABILITY_MISSING',
          category: 'EXECUTOR',
          retryable: false,
          safeMessage: error.message || '浏览器能力缺失',
        },
        diagnostics: { outcome: 'CAPABILITY_MISSING', candidatesTried: [] },
      }
    }
    if (error instanceof SurfaceLostError || isClosedMessage(error)) {
      return failOutcome('SURFACE_LOST', { outcome: 'SURFACE_LOST', candidatesTried: [] })
    }
    const message = error instanceof Error ? error.message : String(error)
    for (const code of [
      'UPLOAD_NO_FILE_INPUT',
      'UPLOAD_TARGET_SINGLE_ONLY',
      'UPLOAD_PRECONDITION_FAILED',
      'UPLOAD_FILE_CHOOSER_TIMEOUT',
      'UPLOAD_TARGET_NOT_FILE_INPUT',
    ] as const) {
      if (message.includes(code)) {
        return {
          ok: false,
          error: {
            code,
            category: 'EXECUTOR',
            retryable: true,
            safeMessage: message.replace(`${code}: `, ''),
          },
          diagnostics,
        }
      }
    }
    return {
      ok: false,
      error: {
        code: 'EXECUTOR_ERROR',
        category: 'EXECUTOR',
        retryable: true,
        safeMessage: error instanceof Error ? error.message.slice(0, 512) : '浏览器命令失败',
      },
    }
  }
}

export async function captureFailureScreenshot(page: Page): Promise<Buffer | undefined> {
  try {
    if (pageClosed(page)) return undefined
    return await screenshotPage(page)
  } catch {
    return undefined
  }
}

type LocateOk = {
  kind: 'found'
  locator: Locator
  diagnostics: ResolverDiagnostics
}
type LocateFail = {
  kind: 'miss'
  outcome: 'NOT_FOUND' | 'AMBIGUOUS' | 'SURFACE_LOST' | 'CAPABILITY_MISSING'
  diagnostics: ResolverDiagnostics
}

export async function locate(
  page: Page,
  target: TargetDescriptor,
  timeoutMs?: number,
  signal?: AbortSignal,
  allowMultiple?: boolean,
): Promise<LocateOk | LocateFail> {
  const deadline = Date.now() + (timeoutMs ?? DEFAULT_LOCATE_MS)
  // Baseline keeps its existing per-locator wait; map probes share one bounded budget.
  const remaining = () => timeoutMs === undefined ? DEFAULT_LOCATE_MS : Math.max(1, deadline - Date.now())
  try {
    signal?.throwIfAborted()
    const { frame, trail } = await resolveFramePath(page, target.framePath, remaining())
    signal?.throwIfAborted()
    const gap = await detectCapabilityGap(frame, target)
    if (gap) {
      return {
        kind: 'miss',
        outcome: 'CAPABILITY_MISSING',
        diagnostics: { outcome: 'CAPABILITY_MISSING', candidatesTried: [], framePathResolved: trail },
      }
    }
    const scoped = scopeForAnchor(frame, target.anchor)
    const countNow = async () => {
      const next: number[] = []
      for (const candidate of target.candidates) {
        signal?.throwIfAborted()
        next.push(await countCandidateNow(scoped, candidate, signal))
      }
      return next
    }
    let matches = await countNow()
    let picked = pickResolvedCandidate(matches, allowMultiple)
    if (picked.kind === 'miss' && picked.outcome === 'NOT_FOUND') {
      while (Date.now() <= deadline) {
        signal?.throwIfAborted()
        await new Promise((resolve) => setTimeout(resolve, 50))
        matches = await countNow()
        picked = pickResolvedCandidate(matches, allowMultiple)
        if (picked.kind === 'found' || picked.outcome === 'AMBIGUOUS') break
      }
    }
    if (picked.kind === 'miss' && picked.outcome === 'NOT_FOUND' && allowMultiple && target.candidates.length > 0) {
      picked = { kind: 'found', index: 0 }
    }
    const tried = candidateTries(target.candidates, matches)
    if (picked.kind === 'found') {
      return {
        kind: 'found',
        locator: locatorForCandidate(scoped, target.candidates[picked.index]!),
        diagnostics: { outcome: 'FOUND', candidatesTried: tried, framePathResolved: trail },
      }
    }
    return {
      kind: 'miss',
      outcome: picked.outcome,
      diagnostics: { outcome: picked.outcome, candidatesTried: tried, framePathResolved: trail },
    }
  } catch (error) {
    if (error instanceof SurfaceLostError || isClosedMessage(error)) {
      return {
        kind: 'miss',
        outcome: 'SURFACE_LOST',
        diagnostics: { outcome: 'SURFACE_LOST', candidatesTried: [] },
      }
    }
    throw error
  }
}

async function evaluateAssert(
  locator: Locator,
  expect: AssertExpect,
  timeoutMs?: number,
  signal?: AbortSignal,
  hasSensitiveSelectors?: boolean,
): Promise<{
  passed: boolean
  expected: JsonValue
  actual: JsonValue
  diff?: string
  error?: { code: 'ASSERT_TEMPLATE_INVALID'; message: string }
}> {
  if (expect.kind === 'aria_snapshot') {
    const matchRes = await matchAriaSnapshot(locator, expect.template, timeoutMs ?? 5_000, signal)
    if (matchRes.kind === 'matched') {
      return {
        passed: true,
        expected: sanitizeAriaSnapshot(expect.template),
        actual: 'matched',
      }
    }
    if (matchRes.kind === 'template_invalid') {
      return {
        passed: false,
        expected: sanitizeAriaSnapshot(expect.template),
        actual: 'template_invalid',
        error: { code: 'ASSERT_TEMPLATE_INVALID', message: matchRes.message },
      }
    }
    if (matchRes.kind === 'mismatch') {
      const sanitizedActual = sanitizeAriaSnapshot(matchRes.received)
      const sanitizedExpected = sanitizeAriaSnapshot(expect.template)
      let diff = generateLineDiff(sanitizedExpected, sanitizedActual)
      if (hasSensitiveSelectors) {
        diff = '# 已含敏感区，仅存脱敏结果\n' + diff
      }
      return {
        passed: false,
        expected: sanitizedExpected,
        actual: sanitizedActual,
        diff,
      }
    }
    throw matchRes.error
  }
  if (expect.kind === 'exists') {
    const n = await locator.count()
    return { passed: n === 1, expected: 1, actual: n }
  }
  if (expect.kind === 'visible') {
    const visible = await isLocatorVisible(locator)
    return { passed: visible, expected: true, actual: visible }
  }
  const text = await readLocator(locator, 'text')
  if (expect.kind === 'text_equals') {
    return { passed: text === expect.value, expected: expect.value, actual: text }
  }
  if (expect.kind === 'text_contains') {
    return { passed: text.includes(expect.value), expected: expect.value, actual: text }
  }
  const actual = Number(text.replace(/[^\d.-]/g, ''))
  if (!Number.isFinite(actual)) {
    return { passed: false, expected: expect.value, actual: text }
  }
  const passed = compareNumber(actual, expect.op, expect.value)
  return { passed, expected: { op: expect.op, value: expect.value }, actual }
}

function generateLineDiff(expected: string, actual: string): string {
  const expLines = expected.split('\n')
  const actLines = actual.split('\n')
  const lines: string[] = ['--- 预期模板', '+++ 实际快照']
  const max = Math.max(expLines.length, actLines.length)
  for (let i = 0; i < max; i++) {
    const exp = expLines[i]
    const act = actLines[i]
    if (exp === act) {
      if (exp !== undefined) lines.push(`  ${exp}`)
    } else {
      if (exp !== undefined) lines.push(`- ${exp}`)
      if (act !== undefined) lines.push(`+ ${act}`)
    }
  }
  return lines.join('\n')
}

function compareNumber(actual: number, op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte', expected: number): boolean {
  if (op === 'eq') return actual === expected
  if (op === 'gt') return actual > expected
  if (op === 'gte') return actual >= expected
  if (op === 'lt') return actual < expected
  return actual <= expected
}

function failOutcome(
  outcome: 'NOT_FOUND' | 'AMBIGUOUS' | 'SURFACE_LOST' | 'CAPABILITY_MISSING',
  diagnostics: ResolverDiagnostics,
): BrowserCommandResult {
  return { ok: false, error: errorForOutcome(outcome, diagnostics), diagnostics }
}

function isClosedMessage(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /has been closed|Target closed|Frame was detached|Execution context was destroyed/i.test(message)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
