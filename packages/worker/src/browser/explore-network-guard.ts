import type { BrowserContext, Page, Route, Dialog } from 'playwright'

/** 只读采集守卫：导航与数据请求限定在授权 Origin 内，数据请求默认只放行 GET。 */
export type ExploreGuardOptions = {
  allowedOrigins: string[]
}

export type BlockedRequestRecord = {
  url: string
  method: string
  resourceType: string
  reason: string
  timestamp: string
}

export type DialogRecord = {
  type: string
  message: string
  timestamp: string
}

export interface ExploreGuardController {
  wasDialogEncountered(): boolean
  getDialogs(): readonly DialogRecord[]
  getBlockedRequests(): readonly BlockedRequestRecord[]
  uninstall(): Promise<void>
}

const STATIC_RESOURCE_TYPES = new Set([
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
])

export async function installExploreGuard(
  context: BrowserContext,
  options: ExploreGuardOptions,
): Promise<ExploreGuardController> {
  const blockedRequests: BlockedRequestRecord[] = []
  const dialogs: DialogRecord[] = []
  let dialogEncountered = false

  const onDialog = (dialog: Dialog) => {
    dialogEncountered = true
    dialogs.push({
      type: dialog.type(),
      message: dialog.message(),
      timestamp: new Date().toISOString(),
    })
    void dialog.dismiss().catch(() => {})
  }

  // Hook dialogs on existing pages and future pages
  for (const page of context.pages()) {
    page.on('dialog', onDialog)
  }
  const onPage = (page: Page) => {
    page.on('dialog', onDialog)
  }
  context.on('page', onPage)

  // Route interceptor for all network requests in context
  const routeHandler = async (route: Route) => {
    const request = route.request()
    const url = request.url()
    const method = request.method().toUpperCase()
    const resourceType = request.resourceType()

    // 1. Block websocket
    if (resourceType === 'websocket') {
      blockedRequests.push({
        url,
        method,
        resourceType,
        reason: '探索模式禁止建立 WebSocket 连接',
        timestamp: new Date().toISOString(),
      })
      await route.abort('blockedbyclient').catch(() => {})
      return
    }

    // 2. Navigation / Document requests: must stay within authorized origins
    if (request.isNavigationRequest() || resourceType === 'document') {
      try {
        const parsed = new URL(url)
        if (!options.allowedOrigins.includes(parsed.origin)) {
          blockedRequests.push({
            url,
            method,
            resourceType,
            reason: `导航地址 ${url} 超出目标系统授权源`,
            timestamp: new Date().toISOString(),
          })
          await route.abort('blockedbyclient').catch(() => {})
          return
        }
      } catch {
        blockedRequests.push({
          url,
          method,
          resourceType,
          reason: `非法导航 URL: ${url}`,
          timestamp: new Date().toISOString(),
        })
        await route.abort('blockedbyclient').catch(() => {})
        return
      }

      await route.continue().catch(() => {})
      return
    }

    // 3. Clear static resources are allowed
    if (STATIC_RESOURCE_TYPES.has(resourceType)) {
      await route.continue().catch(() => {})
      return
    }

    // 4. Data requests (xhr, fetch, ping, eventsource, other)
    if (['xhr', 'fetch', 'ping', 'eventsource', 'other'].includes(resourceType)) {
      let allowed = false
      try {
        const parsed = new URL(url)
        allowed = options.allowedOrigins.includes(parsed.origin) && (method === 'GET' || method === 'HEAD')
      } catch {}

      if (allowed) {
        await route.continue().catch(() => {})
        return
      }

      blockedRequests.push({
        url,
        method,
        resourceType,
        reason: `数据请求 ${method} ${url} 未通过安全信封核准`,
        timestamp: new Date().toISOString(),
      })
      await route.abort('blockedbyclient').catch(() => {})
      return
    }

    // Default: allow remaining harmless requests or block if unsure
    await route.continue().catch(() => {})
  }

  await context.route('**/*', routeHandler)

  return {
    wasDialogEncountered: () => dialogEncountered,
    getDialogs: () => dialogs,
    getBlockedRequests: () => blockedRequests,
    async uninstall() {
      context.off('page', onPage)
      for (const page of context.pages()) {
        page.off?.('dialog', onDialog)
      }
      await context.unroute('**/*', routeHandler).catch(() => {})
    },
  }
}
