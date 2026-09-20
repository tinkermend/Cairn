import { createHmac } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'
import nodemailer from 'nodemailer'
import {
  beginNotificationSubmission,
  claimNotificationDeliveries,
  finishNotificationDelivery,
  loadSecretCiphertext,
  prepareNotificationEvents,
  repairNotificationIntents,
  importLegacyNotificationNotices,
  reconcileNotificationSuppressions,
  purgeNotificationHistory,
  type DbHandle,
  type NotificationJob,
} from '@cairn/db'
import type { LocalSecretProvider } from '@cairn/secret'
import {
  LOCAL_SECRET_PROVIDER,
  NOTIFICATION_PROTOCOL,
  alertNoticeSchema,
  alertWebhookSecretPayloadSchema,
  isBlockedAlertWebhookHost,
  isBlockedAlertWebhookUrl,
  notificationChannelSecretSchema,
  notificationSmtpSecretSchema,
} from '@cairn/shared'

type Result = {
  outcome: 'accepted' | 'retryable' | 'failed' | 'unknown'
  errorCode?: string
  responseCode?: number
}
type Destination = { address: string; family: number }
const fail = (code: string) => Object.assign(new Error(code), { code })

/** DNS itself does not accept AbortSignal. Bound the wait and detach the listener on either outcome. */
export async function withNotificationDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw fail('send_aborted')
  let abort: () => void = () => undefined
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(fail('send_aborted'))
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([work, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export async function resolveNotificationDestination(
  url: string,
  blockedHosts: readonly string[] = [],
): Promise<Destination[]> {
  const destination = new URL(url)
  if (
    destination.protocol !== 'https:' ||
    destination.username ||
    destination.password ||
    destination.hash ||
    isBlockedAlertWebhookUrl(url, blockedHosts)
  )
    throw fail('destination_blocked')
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true })
  if (
    !addresses.length ||
    addresses.some((v) => isBlockedAlertWebhookHost(v.address, blockedHosts))
  )
    throw fail('destination_blocked')
  return addresses
}

export function notificationWebhookBody(job: NotificationJob): string {
  const payload = job.event.payload!
  if (job.delivery.binding.channel.format === 'legacy_alert@1' && payload.alert) {
    const { occurredAt, ...alert } = payload.alert
    return JSON.stringify(alertNoticeSchema.parse({ ...alert, at: occurredAt }))
  }
  const body = JSON.stringify({
    protocol: NOTIFICATION_PROTOCOL,
    eventId: job.event.id,
    deliveryId: job.deliveryId,
    type: job.event.type,
    occurredAt: job.event.occurredAt.toISOString(),
    observedAt: job.event.observedAt?.toISOString() ?? null,
    runId: job.event.runId,
    targetId: job.event.targetId,
    scenarioId: job.event.scenarioId,
    consoleUrl: job.event.consoleUrl,
    data: payload,
  })
  if (Buffer.byteLength(body) > 32 * 1024) throw fail('notification_payload_too_large')
  return body
}

/** Pure formatting. No template expression evaluation and no untrusted HTML. */
export function notificationEmailText(job: NotificationJob): string {
  const p = job.event.payload!
  return [
    p.title,
    p.scenarioName && `场景：${p.scenarioName}`,
    p.targetName && `目标：${p.targetName}`,
    p.status &&
      `执行状态：${{ SUCCEEDED: '执行完成', FAILED: '执行失败', CANCELLED: '执行已取消' }[p.status]}`,
    p.outcomeStatus &&
      `业务结果：${{ PASS: '业务通过', WARN: '业务告警', FAIL: '业务异常', UNKNOWN: '业务未知', NOT_EVALUATED: '未评价业务结果' }[p.outcomeStatus]}`,
    p.evidenceStatus &&
      `证据状态：${{ PENDING: '证据收集中', COMPLETE: '证据完整', INCOMPLETE: '证据不完整' }[p.evidenceStatus]}`,
    p.summaryStage === 'evidence_pending' && '证据仍在收集中，本摘要不会因补齐而重新发送。',
    p.finishedAt && `结束时间：${p.finishedAt}`,
    p.durationMs != null && `执行耗时：${(p.durationMs / 1000).toFixed(1)} 秒`,
    p.alert &&
      `告警：${p.alert.ruleName}（${{ firing: '触发', resolved: '恢复', interrupted: '判断依据中断' }[p.alert.kind]} / ${p.alert.severity === 'critical' ? '严重' : '警告'}）`,
    job.event.runId && `运行编号：${job.event.runId}`,
    job.event.consoleUrl,
    `通知编号：${job.deliveryId}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export async function sendNotificationWebhook(input: {
  url: string
  token?: string
  signingKey?: string
  body: string
  deliveryId: string
  addresses: Destination[]
  signal: AbortSignal
  receiverDeduplicates?: boolean
}): Promise<Result> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(input.body)),
    'X-Cairn-Delivery-Id': input.deliveryId,
  }
  if (input.token) headers.Authorization = `Bearer ${input.token}`
  if (input.signingKey) {
    const timestamp = Math.floor(Date.now() / 1000).toString()
    headers['X-Cairn-Timestamp'] = timestamp
    headers['X-Cairn-Signature'] =
      `v1=${createHmac('sha256', input.signingKey).update(`${timestamp}.${input.body}`).digest('hex')}`
  }
  // Validated addresses are used by the actual connection. Never resolve again after the SSRF check.
  return new Promise((resolve) => {
    let connected = false,
      settled = false
    const finish = (result: Result) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }
    const req = request(
      input.url,
      {
        method: 'POST',
        headers,
        signal: input.signal,
        lookup: (_hostname, options, callback) => {
          const requested = typeof options === 'number' ? options : options.family
          const candidates = input.addresses.filter((a) => !requested || a.family === requested)
          const chosen = candidates[0]
          if (!chosen) {
            callback(fail('destination_unreachable'), '', 4)
            return
          }
          if (typeof options === 'object' && options.all) callback(null, candidates as never)
          else callback(null, chosen.address, chosen.family)
        },
      },
      (res) => {
        const code = res.statusCode ?? 0
        // Response bodies are deliberately neither persisted nor logged. Redirects are never followed.
        res.destroy()
        finish(
          code >= 200 && code < 300
            ? { outcome: 'accepted', responseCode: code }
            : {
                outcome:
                  code === 429 || code >= 500
                    ? input.receiverDeduplicates
                      ? 'retryable'
                      : 'unknown'
                    : 'failed',
                errorCode: 'webhook_rejected',
                responseCode: code,
              },
        )
      },
    )
    req.on('socket', (socket) =>
      socket.once('secureConnect', () => {
        connected = true
      }),
    )
    req.once('error', () =>
      finish({
        outcome: connected ? 'unknown' : 'retryable',
        errorCode: connected ? 'webhook_receipt_unknown' : 'webhook_connect_failed',
      }),
    )
    req.end(input.body)
  })
}

export async function sendNotificationEmail(input: {
  smtp: ReturnType<typeof notificationSmtpSecretSchema.parse>
  recipient: string
  job: NotificationJob
  signal: AbortSignal
}): Promise<Result> {
  const s = input.smtp
  const text = notificationEmailText(input.job)
  const html = `<div style="white-space:pre-wrap">${text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)}</div>`
  if (Buffer.byteLength(text) + Buffer.byteLength(html) > 128 * 1024)
    return { outcome: 'failed', errorCode: 'notification_payload_too_large' }
  let dataStarted = false
  // Nodemailer can label a post-DATA socket close as CONN. Track the protocol boundary,
  // consuming diagnostic events only as a boolean: never forward or retain their contents.
  const discard = () => undefined
  const phaseObserver = {
    trace: discard,
    info: discard,
    warn: discard,
    error: discard,
    fatal: discard,
    debug(data: { tnx?: string }, message: string) {
      if (data.tnx === 'client' && message === 'DATA') dataStarted = true
    },
  }
  const transport = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.tls === 'tls',
    requireTLS: true,
    auth: { user: s.username, pass: s.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: phaseObserver,
    debug: false,
    transactionLog: true,
  })
  const abort = () => transport.close()
  input.signal.addEventListener('abort', abort, { once: true })
  try {
    if (input.signal.aborted)
      return { outcome: 'retryable', errorCode: 'send_aborted_before_submission' }
    const result = await transport.sendMail({
      from: s.from,
      to: input.recipient,
      subject: input.job.event.payload!.title.replace(/[\r\n]/g, ' '),
      text,
      html,
      messageId: `<${input.job.deliveryId}@cairn.notification>`,
      date: input.job.event.occurredAt,
      headers: { 'X-Cairn-Delivery-Id': input.job.deliveryId },
      disableFileAccess: true,
      disableUrlAccess: true,
    })
    return result.accepted.length === 1
      ? { outcome: 'accepted' }
      : { outcome: 'failed', errorCode: 'smtp_recipient_rejected' }
  } catch (error) {
    const e = error as { responseCode?: number; command?: string; code?: string }
    if (e.responseCode)
      return {
        outcome: e.responseCode >= 400 && e.responseCode < 500 ? 'retryable' : 'failed',
        errorCode: 'smtp_rejected',
        responseCode: e.responseCode,
      }
    const preSubmission = !dataStarted
    return {
      outcome: preSubmission ? 'retryable' : 'unknown',
      errorCode: preSubmission ? 'smtp_connect_failed' : 'smtp_receipt_unknown',
    }
  } finally {
    input.signal.removeEventListener('abort', abort)
    transport.close()
  }
}

export type NotificationDeliveryDeps = {
  db: DbHandle
  workerId: string
  instanceId: string
  secrets?: LocalSecretProvider
  signal?: AbortSignal
  blockedHosts?: string[]
  smtpDestinations: string[]
  /** Transport fixture injection; runtime assembly always uses the pinned public resolver. */
  resolveDestination?: typeof resolveNotificationDestination
}
export async function deliverNotifications(input: NotificationDeliveryDeps): Promise<number> {
  await importLegacyNotificationNotices(input.db)
  await repairNotificationIntents(input.db)
  await prepareNotificationEvents(input.db)
  await reconcileNotificationSuppressions(input.db)
  await purgeNotificationHistory(input.db)
  const jobs = await claimNotificationDeliveries(input.db, input)
  await Promise.all(
    jobs.map(async (job) => {
      let result: Result
      try {
        const decrypt = async (ref: { provider: string; secretId: string }) => {
          if (!input.secrets || ref.provider !== LOCAL_SECRET_PROVIDER)
            throw fail('secret_provider_unavailable')
          const secret = await loadSecretCiphertext(input.db, ref.secretId)
          if (!secret) throw fail('secret_missing')
          return JSON.parse(input.secrets.decrypt(secret.id, secret.ciphertext)) as unknown
        }
        const raw = await decrypt(job.delivery.binding.channel.secretRef)
        // Upgraded alert channels keep their original encrypted payload and reference.
        const legacy =
          raw && typeof raw === 'object' && !('kind' in raw)
            ? alertWebhookSecretPayloadSchema.parse(raw)
            : undefined
        const channel = notificationChannelSecretSchema.parse(
          legacy ? { kind: 'webhook', url: legacy.url, token: legacy.token } : raw,
        )
        const signal = AbortSignal.any([
          AbortSignal.timeout(channel.kind === 'webhook' ? 10_000 : 60_000),
          ...(input.signal ? [input.signal] : []),
        ])
        if (channel.kind === 'webhook') {
          const addresses = await withNotificationDeadline(
            (input.resolveDestination ?? resolveNotificationDestination)(
              channel.url,
              input.blockedHosts,
            ),
            signal,
          )
          if (signal.aborted) throw fail('send_aborted')
          if (!(await beginNotificationSubmission(input.db, job))) return
          result = await sendNotificationWebhook({
            ...channel,
            body: notificationWebhookBody(job),
            deliveryId: job.deliveryId,
            addresses,
            signal,
            receiverDeduplicates: job.delivery.binding.channel.replay === 'receiver_deduplicates',
          })
        } else {
          const smtpRef = job.delivery.binding.smtp?.secretRef
          if (!smtpRef) throw fail('smtp_missing')
          const smtp = notificationSmtpSecretSchema.parse(await decrypt(smtpRef))
          if (!input.smtpDestinations.includes(`${smtp.host.toLowerCase()}:${smtp.port}`))
            throw fail('smtp_destination_not_approved')
          const recipient = channel.recipients.find((r) => r.id === job.delivery.recipientKey)
          if (!recipient) throw fail('recipient_missing')
          if (signal.aborted) throw fail('send_aborted')
          if (!(await beginNotificationSubmission(input.db, job))) return
          result = await sendNotificationEmail({ smtp, recipient: recipient.email, job, signal })
        }
      } catch (error) {
        // Never store exception messages: providers and parsers can embed secrets or recipients.
        const code = (error as { code?: string })?.code
        result = {
          outcome:
            code === 'send_aborted' || ['EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT'].includes(code ?? '')
              ? 'retryable'
              : 'failed',
          errorCode: [
            'secret_provider_unavailable',
            'secret_missing',
            'destination_blocked',
            'smtp_missing',
            'smtp_destination_not_approved',
            'recipient_missing',
            'send_aborted',
          ].includes(code ?? '')
            ? code
            : 'notification_preparation_failed',
        }
      }
      await finishNotificationDelivery(input.db, job, result)
    }),
  )
  return jobs.length
}
