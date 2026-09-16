import { randomUUID } from 'node:crypto'
import type { ElementHandle } from 'playwright'
import type {
  BrowserCommand,
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
  countCandidate,
  detectCapabilityGap,
  fillLocator,
  isLocatorVisible,
  locatorForCandidate,
  navigateInScope,
  pageClosed,
  pressKeys,
  readLocator,
  resolveFramePath,
  scopeForAnchor,
  screenshotPage,
  selectLocator,
  waitForPopup,
  waitOnPage,
} from './runtime'
import { candidateTries, decideResolverOutcome, errorForOutcome } from './resolver'

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

export async function executeOnPage(
  page: Page,
  command: BrowserCommand,
  signal?: AbortSignal,
): Promise<BrowserCommandResult & { screenshotBytes?: Buffer }> {
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

    if (command.type === 'assert' && !command.target) {
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

    const target = 'target' in command ? command.target : undefined
    if (!target) {
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

    const located = await locate(page, target, command.type === 'locate' ? command.timeoutMs : undefined, signal)
    signal?.throwIfAborted()
    if (located.kind !== 'found') {
      return failOutcome(located.outcome, located.diagnostics)
    }

    if (command.type === 'locate') {
      const resolvedTargetToken = await rememberTarget(page, located.locator)
      signal?.throwIfAborted()
      if (!resolvedTargetToken) return failOutcome('SURFACE_LOST', located.diagnostics)
      return { ok: true, output: {}, diagnostics: located.diagnostics, resolvedTargetToken }
    }

    if ((command.type === 'extract' || command.type === 'assert') && command.expectedTargetToken) {
      return { ...await readRememberedTarget(page, located.locator, command, signal), diagnostics: located.diagnostics }
    }

    if (command.type === 'click') {
      const popup = await waitForPopup(page, () =>
        clickLocator(located.locator, {
          button: command.button,
          clickCount: command.clickCount,
          modifiers: command.modifiers,
        }),
      )
      if (popup) {
        // P5：点击可以打开 popup，但不把新窗收成后续步骤的当前 Surface。
        await popup.waitForLoadState('domcontentloaded').catch(() => undefined)
      }
      return { ok: true, output: {}, diagnostics: located.diagnostics }
    }

    if (command.type === 'fill') {
      await fillLocator(located.locator, command.value)
      return { ok: true, output: {}, diagnostics: located.diagnostics }
    }

    if (command.type === 'extract') {
      const value = await readLocator(located.locator, command.as, command.attribute)
      return { ok: true, output: { value }, diagnostics: located.diagnostics }
    }

    if (command.type === 'select') {
      await selectLocator(located.locator, { by: command.by, value: command.value, index: command.index })
      return { ok: true, output: {}, diagnostics: located.diagnostics }
    }

    if (command.type === 'keyboard') {
      await pressKeys(page, command.keys, located.locator)
      return { ok: true, output: {}, diagnostics: located.diagnostics }
    }

    if (command.type === 'wait') {
      await waitOnPage(
        page,
        {
          kind: command.kind,
          locator: located.locator,
          text: command.text,
          timeoutMs: command.timeoutMs,
        },
        signal,
      )
      return { ok: true, output: {}, diagnostics: located.diagnostics }
    }

    const assertion = await evaluateAssert(located.locator, command.expect)
    if (!assertion.passed) {
      return {
        ok: false,
        error: {
          code: 'ASSERT_FAILED',
          category: 'EXECUTOR',
          retryable: false,
          safeMessage: '断言不成立',
        },
        output: assertion,
        diagnostics: located.diagnostics,
      }
    }
    return { ok: true, output: assertion, diagnostics: located.diagnostics }
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: { code: 'CANCELLED', category: 'CANCELLED', retryable: false, safeMessage: '步骤已取消' } }
    if (error instanceof BrowserCapabilityMissingError) {
      return failOutcome('CAPABILITY_MISSING', { outcome: 'CAPABILITY_MISSING', candidatesTried: [] })
    }
    if (error instanceof SurfaceLostError || isClosedMessage(error)) {
      return failOutcome('SURFACE_LOST', { outcome: 'SURFACE_LOST', candidatesTried: [] })
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

export async function locate(page: Page, target: TargetDescriptor, timeoutMs?: number, signal?: AbortSignal): Promise<LocateOk | LocateFail> {
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
    const matches: number[] = []
    let found: Locator | undefined
    for (const candidate of target.candidates) {
      signal?.throwIfAborted()
      const n = await countCandidate(scoped, candidate, remaining(), signal)
      matches.push(n)
      if (n === 1) {
        found = locatorForCandidate(scoped, candidate)
        break
      }
    }
    const tried = candidateTries(target.candidates, matches)
    if (found) {
      return {
        kind: 'found',
        locator: found,
        diagnostics: { outcome: 'FOUND', candidatesTried: tried, framePathResolved: trail },
      }
    }
    const outcome = decideResolverOutcome(matches.map((n) => ({ matches: n })))
    return {
      kind: 'miss',
      outcome,
      diagnostics: { outcome, candidatesTried: tried, framePathResolved: trail },
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
  expect: Extract<BrowserCommand, { type: 'assert' }>['expect'],
): Promise<{ passed: boolean; expected: JsonValue; actual: JsonValue }> {
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
