import { createHmac, timingSafeEqual } from 'node:crypto'
import { request } from 'node:https'
import {
  beginServiceWebhookSubmission,
  claimServiceWebhookDeliveries,
  enqueueServiceWebhookDeliveries,
  finishServiceWebhookDelivery,
  loadSecretCiphertext,
  type DbHandle,
  type ServiceWebhookJob,
} from '@cairn/db'
import type { LocalSecretProvider } from '@cairn/secret'
import {
  LOCAL_SECRET_PROVIDER,
  SERVICE_WEBHOOK_RESPONSE_PREVIEW_BYTES,
  SERVICE_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  SERVICE_WEBHOOK_TIMEOUT_MS,
} from '@cairn/shared'
import { resolveNotificationDestination } from './notification-delivery'

type Destination = Awaited<ReturnType<typeof resolveNotificationDestination>>[number]
type SendResult = {
  ok: boolean
  retryable?: boolean
  responseCode?: number
  responseBody?: string | null
  errorCode?: string
}

const fail = (code: string) => Object.assign(new Error(code), { code })

export function serviceWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex')
}

/** Receiver-side helper used by integration guides and fixed test vectors. */
export function verifyServiceWebhookSignature(input: {
  secret: string
  timestamp: string
  signature: string
  body: string
  nowMs?: number
}): boolean {
  if (!/^[0-9]{1,16}$/.test(input.timestamp)) return false
  const seconds = Number(input.timestamp)
  if (!Number.isSafeInteger(seconds)) return false
  const now = input.nowMs ?? Date.now()
  if (
    Math.abs(now - seconds * 1000) >=
    SERVICE_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS * 1000
  )
    return false
  const version = input.signature
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.startsWith('v1='))
    ?.slice(3)
  if (!version || !/^[a-f0-9]{64}$/i.test(version)) return false
  const expected = Buffer.from(
    serviceWebhookSignature(input.secret, input.timestamp, input.body),
    'hex',
  )
  const actual = Buffer.from(version, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function redactResponseValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactResponseValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /(?:authorization|cookie|password|secret|token|api[-_]?key)/i.test(key)
        ? '[REDACTED]'
        : redactResponseValue(item),
    ]),
  )
}

export function sanitizeServiceWebhookResponse(
  body: string,
  contentType?: string,
): string | null {
  const clipped = Buffer.from(body).subarray(0, SERVICE_WEBHOOK_RESPONSE_PREVIEW_BYTES).toString('utf8')
  if (!clipped || !/^(?:application\/(?:json|problem\+json)|text\/)/i.test(contentType ?? ''))
    return null
  try {
    return JSON.stringify(redactResponseValue(JSON.parse(clipped))).slice(
      0,
      SERVICE_WEBHOOK_RESPONSE_PREVIEW_BYTES,
    )
  } catch {
    return clipped
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(password|secret|token|api[_-]?key)=([^\s&]+)/gi, '$1=[REDACTED]')
      .slice(0, SERVICE_WEBHOOK_RESPONSE_PREVIEW_BYTES)
  }
}

export async function sendServiceWebhook(input: {
  job: ServiceWebhookJob
  secret: string
  addresses: readonly Destination[]
  signal: AbortSignal
  now?: Date
}): Promise<SendResult> {
  const body = JSON.stringify(input.job.delivery.payload)
  if (Buffer.byteLength(body) > 64 * 1024)
    return { ok: false, errorCode: 'webhook_payload_too_large' }
  const timestamp = Math.floor((input.now?.getTime() ?? Date.now()) / 1000).toString()
  const signature = serviceWebhookSignature(input.secret, timestamp, body)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'X-Cairn-Event': input.job.delivery.eventType,
    'X-Cairn-Delivery': input.job.delivery.id,
    'X-Cairn-Timestamp': timestamp,
    'X-Cairn-Signature': `t=${timestamp},v1=${signature}`,
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: SendResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const req = request(
      input.job.webhook.url,
      {
        method: 'POST',
        headers,
        signal: input.signal,
        lookup: (_hostname, options, callback) => {
          const requested = typeof options === 'number' ? options : options.family
          const candidates = input.addresses.filter(
            (address) => !requested || address.family === requested,
          )
          const chosen = candidates[0]
          if (!chosen) {
            callback(fail('destination_unreachable'), '', 4)
            return
          }
          if (typeof options === 'object' && options.all)
            callback(null, candidates as never)
          else callback(null, chosen.address, chosen.family)
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          if (size >= SERVICE_WEBHOOK_RESPONSE_PREVIEW_BYTES) return
          const next = Buffer.from(chunk).subarray(
            0,
            SERVICE_WEBHOOK_RESPONSE_PREVIEW_BYTES - size,
          )
          chunks.push(next)
          size += next.length
        })
        response.once('end', () => {
          const responseCode = response.statusCode ?? 0
          const responseBody = sanitizeServiceWebhookResponse(
            Buffer.concat(chunks).toString('utf8'),
            typeof response.headers['content-type'] === 'string'
              ? response.headers['content-type']
              : undefined,
          )
          finish(
            responseCode >= 200 && responseCode < 300
              ? { ok: true, responseCode, responseBody }
              : {
                  ok: false,
                  retryable:
                    responseCode === 408 ||
                    responseCode === 425 ||
                    responseCode === 429 ||
                    responseCode >= 500,
                  responseCode,
                  responseBody,
                  errorCode: 'webhook_rejected',
                },
          )
        })
        response.once('error', () =>
          finish({ ok: false, retryable: true, errorCode: 'webhook_response_failed' }),
        )
      },
    )
    req.once('error', (error: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        retryable: true,
        errorCode: error.code === 'ABORT_ERR' ? 'webhook_timeout' : 'webhook_connect_failed',
      }),
    )
    req.end(body)
  })
}

export type ServiceWebhookDeliveryDeps = {
  db: DbHandle
  workerId: string
  instanceId: string
  secrets?: LocalSecretProvider
  signal?: AbortSignal
  blockedHosts?: readonly string[]
  /** Tests can pin resolver output; production always uses the DNS-guarded resolver. */
  resolveDestination?: typeof resolveNotificationDestination
}

export async function deliverServiceWebhooks(
  input: ServiceWebhookDeliveryDeps,
): Promise<number> {
  await enqueueServiceWebhookDeliveries(input.db)
  const jobs = await claimServiceWebhookDeliveries(input.db, input)
  await Promise.all(
    jobs.map(async (job) => {
      const submission = await beginServiceWebhookSubmission(input.db, job)
      if (!submission) return
      let result: SendResult
      try {
        if (!input.secrets) throw fail('secret_provider_unavailable')
        const stored = await loadSecretCiphertext(input.db, job.webhook.secretId)
        if (!stored || stored.provider !== LOCAL_SECRET_PROVIDER)
          throw fail('webhook_secret_missing')
        const secret = input.secrets.decrypt(stored.id, stored.ciphertext)
        if (!secret) throw fail('webhook_secret_missing')
        const signal = AbortSignal.any([
          AbortSignal.timeout(SERVICE_WEBHOOK_TIMEOUT_MS),
          ...(input.signal ? [input.signal] : []),
        ])
        const addresses = await (input.resolveDestination ?? resolveNotificationDestination)(
          job.webhook.url,
          input.blockedHosts,
        )
        result = await sendServiceWebhook({ job, secret, addresses, signal })
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : 'webhook_delivery_failed'
        result = {
          ok: false,
          retryable: ![
            'webhook_secret_missing',
            'secret_provider_unavailable',
            'destination_blocked',
          ].includes(code),
          errorCode: code.slice(0, 256),
        }
      }
      await finishServiceWebhookDelivery(input.db, job, result)
    }),
  )
  return jobs.length
}
