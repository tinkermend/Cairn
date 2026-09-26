import type { BrowserContext, Page, Route, Dialog } from 'playwright'
import {
  isUrlInExploreAllowlist,
  type ExplorationAllowlistEntry,
  type ExploreEntryRequestProfile,
  type RequestPattern,
} from '@cairn/shared'

export type ExploreGuardOptions = {
  allowlist: readonly ExplorationAllowlistEntry[]
  allowedOrigins: string[]
  entryProfile?: ExploreEntryRequestProfile
  stepEnvelope?: readonly RequestPattern[]
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

    // 2. Navigation / Document requests: must pass allowlist and origins
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
        if (options.allowlist.length > 0 && !isUrlInExploreAllowlist(url, options.allowlist)) {
          blockedRequests.push({
            url,
            method,
            resourceType,
            reason: `导航地址 ${url} 未在探索 allowlist 范围内`,
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
      let matchReason = ''

      // Check stepEnvelope first if present
      if (options.stepEnvelope) {
        const matched = options.stepEnvelope.some((rule: RequestPattern) => {
          if (rule.method && rule.method.toUpperCase() !== method) return false
          if (rule.origin) {
            try {
              if (new URL(url).origin !== rule.origin) return false
            } catch {
              return false
            }
          }
          if (rule.path) {
            try {
              const pathname = new URL(url).pathname
              const regex = new RegExp(rule.path)
              if (!regex.test(pathname)) return false
            } catch {
              return false
            }
          }
          return true
        })
        if (matched) {
          allowed = true
          matchReason = 'stepEnvelope'
        }
      }

      // Check entryProfile
      if (!allowed && options.entryProfile) {
        const matched = options.entryProfile.initialDataRequests.some((rule: RequestPattern) => {
          if (rule.method && rule.method.toUpperCase() !== method) return false
          if (rule.origin) {
            try {
              if (new URL(url).origin !== rule.origin) return false
            } catch {
              return false
            }
          }
          if (rule.path) {
            try {
              const pathname = new URL(url).pathname
              const regex = new RegExp(rule.path)
              if (!regex.test(pathname)) return false
            } catch {
              return false
            }
          }
          return true
        })
        if (matched) {
          allowed = true
          matchReason = 'entryProfile'
        }
      }

      // If no envelope or profile is configured, allow read-only GET data requests to allowed origins
      if (!allowed && !options.stepEnvelope && !options.entryProfile) {
        try {
          const parsed = new URL(url)
          if (options.allowedOrigins.includes(parsed.origin) && method === 'GET') {
            allowed = true
            matchReason = 'default_readonly_origin_get'
          }
        } catch {}
      }

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
