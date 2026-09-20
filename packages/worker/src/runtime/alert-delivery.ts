import { resolve4, resolve6 } from 'node:dns/promises'
import { isIP } from 'node:net'
import {
  claimDueAlertDeliveries,
  findAlertChannel,
  finishAlertDelivery,
  getOrCreatePlatformConfig,
  loadSecretCiphertext,
  resolveAlerting,
  type AlertDeliveryJob,
  type DbHandle,
} from '@cairn/db'
import type { LocalSecretProvider } from '@cairn/secret'
import {
  DEFAULT_ALERT_DELIVERY_TIMEOUT_MS,
  LOCAL_SECRET_PROVIDER,
  alertWebhookSecretPayloadSchema,
  isBlockedAlertWebhookHost,
  isBlockedAlertWebhookUrl,
} from '@cairn/shared'

export type AlertDeliveryDeps = {
  db: DbHandle
  secrets?: LocalSecretProvider
  fetchImpl?: typeof fetch
  timeoutMs?: number
  blockedHosts?: string[]
  resolveHosts?: (hostname: string) => Promise<string[]>
  allowPrivateWebhook?: boolean
}

export async function deliverDueAlertNotices(input: AlertDeliveryDeps): Promise<{
  claimed: number
  sent: number
  failed: number
  suppressed: number
}> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = input.timeoutMs ?? DEFAULT_ALERT_DELIVERY_TIMEOUT_MS
  const jobs = await claimDueAlertDeliveries(input.db)
  const stats = { claimed: jobs.length, sent: 0, failed: 0, suppressed: 0 }
  if (jobs.length === 0) return stats
  const current = await getOrCreatePlatformConfig(input.db)
  const alerting = resolveAlerting(current.document)

  for (const job of jobs) {
    if (job.silenced) {
      await finishAlertDelivery(input.db, { alertId: job.alertId, status: 'suppressed' })
      stats.suppressed += 1
      continue
    }
    const outcome = await deliverJob(job, {
      db: input.db,
      secrets: input.secrets,
      fetchImpl,
      timeoutMs,
      alerting,
      blockedHosts: input.blockedHosts ?? [],
      resolveHosts: input.resolveHosts ?? resolveWebhookAddresses,
      allowPrivateWebhook: input.allowPrivateWebhook === true,
    })
    if (outcome === 'sent') stats.sent += 1
    else stats.failed += 1
  }
  return stats
}

async function deliverJob(
  job: AlertDeliveryJob,
  input: {
    db: DbHandle
    secrets?: LocalSecretProvider
    fetchImpl: typeof fetch
    timeoutMs: number
    alerting: ReturnType<typeof resolveAlerting>
    blockedHosts: string[]
    resolveHosts: (hostname: string) => Promise<string[]>
    allowPrivateWebhook: boolean
  },
): Promise<'sent' | 'failed'> {
  const channels = job.channelIds
    .map((id) => findAlertChannel(input.alerting, id))
    .filter((channel): channel is NonNullable<typeof channel> => Boolean(channel?.enabled))
  if (channels.length === 0) {
    await finishAlertDelivery(input.db, { alertId: job.alertId, status: 'sent' })
    return 'sent'
  }
  if (!input.secrets) {
    await finishAlertDelivery(input.db, {
      alertId: job.alertId,
      status: 'failed',
      errorClass: 'secret_provider_missing',
    })
    return 'failed'
  }
  try {
    for (const channel of channels) {
      if (channel.secretRef.provider !== LOCAL_SECRET_PROVIDER) {
        throw Object.assign(new Error('unsupported_secret_provider'), { code: 'unsupported_secret_provider' })
      }
      const row = await loadSecretCiphertext(input.db, channel.secretRef.secretId)
      if (!row) throw Object.assign(new Error('secret_missing'), { code: 'secret_missing' })
      const payload = alertWebhookSecretPayloadSchema.parse(
        JSON.parse(input.secrets.decrypt(row.id, row.ciphertext)),
      )
      await assertSafeWebhookDestination(payload.url, {
        blockedHosts: input.blockedHosts,
        resolveHosts: input.resolveHosts,
        allowPrivateWebhook: input.allowPrivateWebhook,
      })
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (payload.token) headers.authorization = `Bearer ${payload.token}`
      const response = await input.fetchImpl(payload.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(job.notice),
        redirect: 'error',
        signal: AbortSignal.timeout(input.timeoutMs),
      })
      if (response.status < 200 || response.status >= 300) {
        throw Object.assign(new Error('webhook_http'), { code: `webhook_http_${response.status}` })
      }
    }
    await finishAlertDelivery(input.db, { alertId: job.alertId, status: 'sent' })
    return 'sent'
  } catch (error) {
    await finishAlertDelivery(input.db, {
      alertId: job.alertId,
      status: 'failed',
      errorClass: classifyDeliveryError(error),
    })
    return 'failed'
  }
}

function classifyDeliveryError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code.slice(0, 64)
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'webhook_timeout'
    if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|fetch failed|network/i.test(error.message)) {
      return 'webhook_unreachable'
    }
  }
  return 'delivery_failed'
}

async function resolveWebhookAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname]
  const [v4, v6] = await Promise.allSettled([resolve4(hostname), resolve6(hostname)])
  const addresses: string[] = []
  if (v4.status === 'fulfilled') addresses.push(...v4.value)
  if (v6.status === 'fulfilled') addresses.push(...v6.value)
  if (addresses.length === 0) {
    throw Object.assign(new Error('webhook_unreachable'), { code: 'webhook_unreachable' })
  }
  return addresses
}

async function assertSafeWebhookDestination(
  url: string,
  input: {
    blockedHosts: readonly string[]
    resolveHosts: (hostname: string) => Promise<string[]>
    allowPrivateWebhook: boolean
  },
): Promise<void> {
  if (input.allowPrivateWebhook) return
  if (isBlockedAlertWebhookUrl(url, input.blockedHosts)) {
    throw Object.assign(new Error('webhook_blocked'), { code: 'webhook_blocked' })
  }
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '')
  const addresses = await input.resolveHosts(hostname)
  for (const address of addresses) {
    if (isBlockedAlertWebhookHost(address, input.blockedHosts)) {
      throw Object.assign(new Error('webhook_blocked'), { code: 'webhook_blocked' })
    }
  }
}
