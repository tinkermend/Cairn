import type {
  BrowserCommand,
  BrowserCommandResult,
  JsonValue,
  ResolverDiagnostics,
  TargetDescriptor,
} from '@cairn/shared'
import type { Locator, Page } from './runtime'
import {
  SurfaceLostError,
  clickLocator,
  countCandidate,
  detectCapabilityGap,
  fillLocator,
  isLocatorVisible,
  locatorForCandidate,
  navigateInScope,
  pageClosed,
  readLocator,
  resolveFramePath,
  scopeForAnchor,
  screenshotPage,
  waitForPopup,
} from './runtime'
import { candidateTries, decideResolverOutcome, errorForOutcome } from './resolver'

export type SurfacePage = Page

const DEFAULT_LOCATE_MS = 8_000

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

    const target = command.type === 'assert' ? command.target : command.target
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

    const located = await locate(page, target)
    if (located.kind !== 'found') {
      return failOutcome(located.outcome, located.diagnostics)
    }

    if (command.type === 'click') {
      const popup = await waitForPopup(page, () => clickLocator(located.locator))
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

async function locate(page: Page, target: TargetDescriptor): Promise<LocateOk | LocateFail> {
  try {
    const { frame, trail } = await resolveFramePath(page, target.framePath, DEFAULT_LOCATE_MS)
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
      const n = await countCandidate(scoped, candidate, DEFAULT_LOCATE_MS)
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
