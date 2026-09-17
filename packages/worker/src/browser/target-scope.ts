import {
  compileAccessScopeFromOrigins,
  urlAllowedByCompiledScope,
  type CompiledAccessScope,
} from '@cairn/shared'
import type { BrowserContext, Page } from 'playwright'

export class TargetScopeError extends Error {
  readonly code = 'TARGET_SCOPE_DENIED'
  constructor() {
    super('页面超出目标系统授权范围')
  }
}
export type TargetScopeInput = readonly string[] | CompiledAccessScope
type Scope = { compiled: CompiledAccessScope; ready: Map<Page, Promise<void>>; failed: boolean }
const scopes = new WeakMap<BrowserContext, Scope>()

function asCompiled(input: TargetScopeInput): CompiledAccessScope {
  if ('rules' in input) return input
  return compileAccessScopeFromOrigins(input)
}

function allowed(scope: Scope, url: string): boolean {
  return urlAllowedByCompiledScope(url, scope.compiled)
}

export function hasTargetScope(context: BrowserContext) {
  return scopes.has(context)
}

export function installedCompiledScope(context: BrowserContext): CompiledAccessScope | undefined {
  return scopes.get(context)?.compiled
}

export function installedScopeAllows(context: BrowserContext, url: string): boolean | null {
  const scope = scopes.get(context)
  if (!scope) return null
  return allowed(scope, url)
}

export async function installTargetScope(context: BrowserContext, input: TargetScopeInput) {
  const compiled = asCompiled(input)
  const previous = scopes.get(context)
  if (previous) {
    if (previous.failed) throw new TargetScopeError()
    previous.compiled = compiled
    return
  }
  const scope: Scope = { compiled, ready: new Map(), failed: false }
  scopes.set(context, scope)
  const ensure = (page: Page) => {
    if (!scope.ready.has(page)) {
      const ready = (async () => {
        const cdp = await context.newCDPSession(page)
        cdp.on('Fetch.requestPaused', (event) => {
          const command = allowed(scope, event.request.url)
            ? 'Fetch.continueRequest'
            : 'Fetch.failRequest'
          void cdp
            .send(
              command,
              command === 'Fetch.failRequest'
                ? { requestId: event.requestId, errorReason: 'BlockedByClient' }
                : { requestId: event.requestId },
            )
            .catch(() => {
              if (!page.isClosed()) scope.failed = true
            })
        })
        // Native interception sees every redirect hop, unlike Playwright route.continue.
        await cdp.send('Fetch.enable', {
          patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
        })
      })()
      scope.ready.set(page, ready)
      page.once('close', () => scope.ready.delete(page))
    }
    return scope.ready.get(page)!
  }
  context.on('page', (page) => {
    void ensure(page).catch(() => {
      scope.failed = true
      void page.close().catch(() => {})
    })
  })
  await context.route('**/*', async (route) => {
    const request = route.request()
    if (!request.isNavigationRequest()) {
      await route.continue()
      return
    }
    if (!allowed(scope, request.url()) || scope.failed) {
      await route.abort('blockedbyclient')
      return
    }
    let page: Page | undefined
    try {
      page = request.frame().page()
    } catch {
      /* initial popup has no Frame yet */
    }
    if (page) {
      try {
        await ensure(page)
        await route.continue()
      } catch {
        await route.abort('blockedbyclient').catch(() => {})
      }
      return
    }
    // ponytail: first popup response has no attachable Page. Reject redirects here;
    // support redirecting popup entry points only after a browser-wide interception implementation is verified.
    try {
      const response = await route.fetch({ maxRedirects: 0 })
      if (response.status() >= 300 && response.status() < 400) await route.abort('blockedbyclient')
      else await route.fulfill({ response })
      await response.dispose()
    } catch {
      await route.abort('blockedbyclient').catch(() => {})
    }
  })
  await Promise.all(context.pages().map(ensure))
}
export async function targetScopeReady(page: Page) {
  await scopes.get(page.context())?.ready.get(page)
}
export function assertPageTargetScope(page: Page) {
  const scope = scopes.get(page.context())
  if (!scope) return
  if (scope.failed) throw new TargetScopeError()
  for (const frame of page.frames()) {
    const url = frame.url()
    // Blank/srcdoc frames inherit their parent origin. Network navigations are intercepted.
    if (!url || url === 'about:blank' || url === 'about:srcdoc') continue
    if (!allowed(scope, url)) throw new TargetScopeError()
  }
}
