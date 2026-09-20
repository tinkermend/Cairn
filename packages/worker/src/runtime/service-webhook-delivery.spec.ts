import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { randomUUID } from 'node:crypto'
import type { ServiceWebhookJob } from '@cairn/db'
import { resolveNotificationDestination } from './notification-delivery.js'
import {
  sanitizeServiceWebhookResponse,
  sendServiceWebhook,
  serviceWebhookSignature,
  verifyServiceWebhookSignature,
} from './service-webhook-delivery.js'

function job(url: string): ServiceWebhookJob {
  const deliveryId = randomUUID()
  const callerId = randomUUID()
  const runId = randomUUID()
  return {
    deliveryId,
    workerId: 'webhook-worker',
    instanceId: randomUUID(),
    epoch: 1,
    delivery: {
      id: deliveryId,
      webhookId: randomUUID(),
      callerId,
      runId,
      eventType: 'run.completed',
      payload: {
        id: deliveryId,
        event: 'run.completed',
        timestamp: '2026-09-19T08:00:00.000Z',
        callerId,
        data: {
          runId,
          idempotencyKey: 'webhook-test-001',
          status: 'COMPLETED',
          scenarioId: randomUUID(),
          scenarioVersionId: randomUUID(),
          targetId: randomUUID(),
          targetAccountId: null,
          startedAt: '2026-09-19T07:59:30.000Z',
          finishedAt: '2026-09-19T08:00:00.000Z',
          durationSeconds: 30,
          outputs: [{ stepName: '读取订单', payload: { status: 'SHIPPED' } }],
          evidenceSummary: { status: 'COMPLETE', availableCount: 1 },
        },
      },
      status: 'sending',
      attempts: 1,
      maxAttempts: 5,
      replayCount: 0,
      nextRetryAt: null,
      lastResponseCode: null,
      lastResponseBody: null,
      lastError: null,
      claimOwner: 'webhook-worker',
      claimInstance: randomUUID(),
      claimEpoch: 1,
      claimExpiresAt: new Date('2026-09-19T08:01:00.000Z'),
      submittedAt: new Date('2026-09-19T08:00:00.000Z'),
      createdAt: new Date('2026-09-19T08:00:00.000Z'),
      updatedAt: new Date('2026-09-19T08:00:00.000Z'),
    },
    webhook: {
      id: randomUUID(),
      callerId,
      url,
      secretId: randomUUID(),
      events: ['run.completed'],
      status: 'active',
      enabledAt: new Date('2026-09-19T07:00:00.000Z'),
      createdAt: new Date('2026-09-19T07:00:00.000Z'),
      updatedAt: new Date('2026-09-19T07:00:00.000Z'),
    },
  } as ServiceWebhookJob
}

describe('服务 Webhook 真实 HTTPS 投递与签名', () => {
  let dir: string
  let key: Buffer
  let cert: Buffer
  let originalCAs: string[]
  const servers: Server[] = []

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cairn-service-webhook-tls-'))
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=service-webhook.test',
        '-addext',
        'subjectAltName=DNS:service-webhook.test,IP:127.0.0.1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    )
    key = readFileSync(join(dir, 'key.pem'))
    cert = readFileSync(join(dir, 'cert.pem'))
    originalCAs = getCACertificates()
    setDefaultCACertificates([...originalCAs, cert.toString()])
  })

  afterAll(async () => {
    for (const server of servers)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    setDefaultCACertificates(originalCAs)
    rmSync(dir, { recursive: true, force: true })
  })

  async function receiver(
    handler: Parameters<typeof createServer>[1],
  ): Promise<{ url: string }> {
    const server = createServer({ key, cert }, handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    return { url: `https://service-webhook.test:${port}/callbacks/cairn` }
  }

  it('uses the raw body, immutable delivery id and t/v1 HMAC headers over a DNS-pinned HTTPS connection', async () => {
    const received: Array<{ body: string; headers: Record<string, string | string[] | undefined> }> = []
    const endpoint = await receiver((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: request.headers })
        response.writeHead(204)
        response.end()
      })
    })
    const work = job(endpoint.url)
    const result = await sendServiceWebhook({
      job: work,
      secret: 'whsec_test',
      addresses: [{ address: '127.0.0.1', family: 4 }],
      signal: AbortSignal.timeout(5_000),
      now: new Date('2023-11-14T22:13:20.000Z'),
    })
    expect(result).toMatchObject({ ok: true, responseCode: 204 })
    expect(received).toHaveLength(1)
    const request = received[0]!
    expect(request.headers['x-cairn-event']).toBe('run.completed')
    expect(request.headers['x-cairn-delivery']).toBe(work.delivery.id)
    expect(request.headers['x-cairn-timestamp']).toBe('1700000000')
    expect(request.headers['x-cairn-signature']).toBe(
      `t=1700000000,v1=${serviceWebhookSignature('whsec_test', '1700000000', request.body)}`,
    )
    expect(
      verifyServiceWebhookSignature({
        secret: 'whsec_test',
        timestamp: '1700000000',
        signature: String(request.headers['x-cairn-signature']),
        body: request.body,
        nowMs: 1_700_000_000_000,
      }),
    ).toBe(true)
    expect(JSON.parse(request.body).data).not.toHaveProperty('input')
  })

  it('provides a fixed HMAC test vector, rejects stale or altered packets, preserves retryable server failures, and blocks local destinations', async () => {
    expect(serviceWebhookSignature('whsec_test', '1700000000', '{}')).toBe(
      '35495024f4ef3f94e5a93e22221544c4b75e9a42300cd965ab81cb85cd994e91',
    )
    expect(
      verifyServiceWebhookSignature({
        secret: 'whsec_test',
        timestamp: '1700000000',
        signature:
          't=1700000000,v1=35495024f4ef3f94e5a93e22221544c4b75e9a42300cd965ab81cb85cd994e91',
        body: '{}',
        nowMs: 1_700_000_300_000,
      }),
    ).toBe(false)
    expect(
      verifyServiceWebhookSignature({
        secret: 'whsec_test',
        timestamp: '1700000000',
        signature:
          't=1700000000,v1=35495024f4ef3f94e5a93e22221544c4b75e9a42300cd965ab81cb85cd994e91',
        body: '{"changed":true}',
        nowMs: 1_700_000_000_000,
      }),
    ).toBe(false)
    const endpoint = await receiver((request, response) => {
      request.resume()
      request.on('end', () => {
        response.writeHead(503, { 'Content-Type': 'application/json' })
        response.end('{"token":"must-not-be-retained"}')
      })
    })
    expect(
      await sendServiceWebhook({
        job: job(endpoint.url),
        secret: 'whsec_test',
        addresses: [{ address: '127.0.0.1', family: 4 }],
        signal: AbortSignal.timeout(5_000),
      }),
    ).toMatchObject({
      ok: false,
      retryable: true,
      responseCode: 503,
      responseBody: '{"token":"[REDACTED]"}',
    })
    await expect(resolveNotificationDestination('https://127.0.0.1/callback')).rejects.toMatchObject({
      code: 'destination_blocked',
    })
  })

  it('keeps only a bounded, redacted text or JSON response preview', () => {
    expect(
      sanitizeServiceWebhookResponse('{"token":"secret","nested":{"password":"hidden"}}', 'application/json'),
    ).toBe('{"token":"[REDACTED]","nested":{"password":"[REDACTED]"}}')
    expect(
      sanitizeServiceWebhookResponse('Bearer abc.def', 'text/plain; charset=utf-8'),
    ).toBe('Bearer [REDACTED]')
    expect(sanitizeServiceWebhookResponse('binary', 'application/octet-stream')).toBeNull()
  })
})
