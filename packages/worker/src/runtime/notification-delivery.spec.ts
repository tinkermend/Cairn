import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:https'
import { createHmac, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCACertificates, setDefaultCACertificates } from 'node:tls'
import { SMTPServer } from 'smtp-server'
import type { NotificationJob } from '@cairn/db'
import {
  notificationEmailText,
  notificationWebhookBody,
  resolveNotificationDestination,
  sendNotificationEmail,
  sendNotificationWebhook,
  withNotificationDeadline,
} from './notification-delivery'

const fixedDate = new Date('2026-09-19T08:00:00.000Z')
function job(): NotificationJob {
  return {
    deliveryId: randomUUID(),
    event: {
      id: randomUUID(),
      type: 'run.finished',
      occurredAt: fixedDate,
      observedAt: fixedDate,
      runId: randomUUID(),
      targetId: randomUUID(),
      scenarioId: randomUUID(),
      consoleUrl: 'https://console.example.com/runs/abc',
      payload: {
        title: '运行结果：订单检查',
        scenarioName: '<img src=x onerror=alert(1)>',
        status: 'SUCCEEDED',
        outcomeStatus: 'NOT_EVALUATED',
        evidenceStatus: 'PENDING',
        summaryStage: 'evidence_pending',
      },
    },
    delivery: { binding: { channel: { format: 'cairn.notification@1' } } },
  } as unknown as NotificationJob
}
describe('通知真实 HTTPS / SMTP 协议与外部副作用', () => {
  let dir: string, key: Buffer, cert: Buffer, originalCAs: string[]
  const servers: Array<Server | SMTPServer> = []
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cairn-notification-tls-'))
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
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,DNS:notification.test,IP:127.0.0.1',
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
  async function httpsReceiver(handler: Parameters<typeof createServer>[1]) {
    const server = createServer({ key, cert }, handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    return { url: `https://notification.test:${port}/notify`, port }
  }
  const addresses = [{ address: '127.0.0.1', family: 4 }]
  it('无响应 DNS 等待可被停止，不占住维护任务', async () => {
    const controller = new AbortController()
    const work = withNotificationDeadline(new Promise(() => undefined), controller.signal)
    controller.abort()
    await expect(work).rejects.toMatchObject({ code: 'send_aborted' })
  })
  it('实际接收字节与 HMAC 一致，投递编号稳定，不发生第二次 DNS 解析', async () => {
    const received: { body: string; signature: string; timestamp: string; delivery: string }[] = []
    const { url } = await httpsReceiver((req, res) => {
      let body = ''
      req.on('data', (c) => {
        body += c.toString()
      })
      req.on('end', () => {
        received.push({
          body,
          signature: String(req.headers['x-cairn-signature']),
          timestamp: String(req.headers['x-cairn-timestamp']),
          delivery: String(req.headers['x-cairn-delivery-id']),
        })
        res.writeHead(204)
        res.end()
      })
    })
    const j = job(),
      body = notificationWebhookBody(j)
    expect(
      await sendNotificationWebhook({
        url,
        addresses,
        body,
        deliveryId: j.deliveryId,
        signingKey: 'test-only-key',
        signal: AbortSignal.timeout(5000),
      }),
    ).toMatchObject({ outcome: 'accepted', responseCode: 204 })
    expect(received).toHaveLength(1)
    expect(received[0]?.body).toBe(body)
    expect(received[0]?.signature).toBe(
      `v1=${createHmac('sha256', 'test-only-key').update(`${received[0]!.timestamp}.${body}`).digest('hex')}`,
    )
    expect(received[0]?.delivery).toBe(j.deliveryId)
    expect(JSON.parse(body).data).not.toHaveProperty('input')
  })
  it('禁止公网策略中的私有/元数据地址，重定向不跟随', async () => {
    for (const url of [
      'https://127.0.0.1/n',
      'https://[::1]/n',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.1/n',
      'http://example.com/n',
    ])
      await expect(resolveNotificationDestination(url)).rejects.toMatchObject({
        code: 'destination_blocked',
      })
    let redirected = 0
    const target = await httpsReceiver((_req, res) => {
      redirected++
      res.end()
    })
    const redirect = await httpsReceiver((_req, res) => {
      res.writeHead(302, { Location: target.url })
      res.end()
    })
    expect(
      await sendNotificationWebhook({
        url: redirect.url,
        addresses,
        body: '{}',
        deliveryId: randomUUID(),
        signal: AbortSignal.timeout(5000),
      }),
    ).toMatchObject({ outcome: 'failed', responseCode: 302 })
    expect(redirected).toBe(0)
  })
  it('HTTP 5xx 不能证明未接收；已提交后断连或超时是 unknown', async () => {
    let submissions = 0
    const failure = await httpsReceiver((req, res) => {
      req.resume()
      req.on('end', () => {
        submissions++
        res.writeHead(503)
        res.end()
      })
    })
    const input = {
      url: failure.url,
      addresses,
      body: '{}',
      deliveryId: randomUUID(),
      signal: AbortSignal.timeout(5000),
    }
    expect(await sendNotificationWebhook(input)).toMatchObject({
      outcome: 'unknown',
      responseCode: 503,
    })
    expect(await sendNotificationWebhook({ ...input, receiverDeduplicates: true })).toMatchObject({
      outcome: 'retryable',
    })
    const broken = await httpsReceiver((req, res) => {
      req.resume()
      req.on('end', () => {
        submissions++
        res.socket?.destroy()
      })
    })
    expect(await sendNotificationWebhook({ ...input, url: broken.url })).toMatchObject({
      outcome: 'unknown',
    })
    const slow = await httpsReceiver((req) => {
      req.resume()
      req.on('end', () => {
        submissions++
      })
    })
    expect(
      await sendNotificationWebhook({ ...input, url: slow.url, signal: AbortSignal.timeout(100) }),
    ).toMatchObject({ outcome: 'unknown' })
    expect(submissions).toBe(4)
  })
  it('旧告警格式保留 at，不加通知 envelope；新模板正确表达三轴', () => {
    const j = job()
    j.delivery.binding.channel.format = 'legacy_alert@1'
    j.event.payload = {
      title: '告警',
      alert: {
        kind: 'firing',
        alertId: randomUUID(),
        ruleId: 'factory.worker.lost',
        ruleName: 'Worker 失联',
        metricKey: 'worker.status.lost',
        source: null,
        scope: 'platform',
        scopeId: 'platform',
        value: 1,
        threshold: 0,
        comparator: 'gt',
        severity: 'critical',
        occurredAt: fixedDate.toISOString(),
        consolePath: '/monitoring',
      },
    }
    const body = JSON.parse(notificationWebhookBody(j))
    expect(body.at).toBe(fixedDate.toISOString())
    expect(body).not.toHaveProperty('protocol')
    expect(body).not.toHaveProperty('occurredAt')
    expect(notificationEmailText(job())).toContain('业务结果：未评价业务结果')
    expect(notificationEmailText(job())).toContain('证据仍在收集中')
  })
  async function smtpReceiver(
    secure: boolean,
    behavior: 'accept' | 'authfail' | 'temporary' | 'permanent' | 'disconnect' = 'accept',
  ) {
    const messages: string[] = [],
      envelopes: string[][] = []
    const server = new SMTPServer({
      secure,
      key,
      cert,
      logger: false,
      onAuth(_auth, _session, callback) {
        callback(behavior === 'authfail' ? new Error('bad credentials') : null, { user: 'fixture' })
      },
      onRcptTo(address, _session, callback) {
        callback(
          address.address.startsWith('reject')
            ? Object.assign(new Error('denied'), { responseCode: 550 })
            : undefined,
        )
      },
      onData(stream, session, callback) {
        let message = ''
        stream.on('data', (c) => {
          message += c.toString()
        })
        stream.on('end', () => {
          messages.push(message)
          envelopes.push(session.envelope.rcptTo.map((a) => a.address))
          if (behavior === 'disconnect') {
            for (const connection of (server as unknown as { connections: Set<{ close(): void }> })
              .connections ?? [])
              connection.close()
            return
          }
          if (behavior === 'temporary' || behavior === 'permanent')
            callback(
              Object.assign(new Error('fixture rejection'), {
                responseCode: behavior === 'temporary' ? 451 : 550,
              }),
            )
          else callback()
        })
      },
    })
    server.on('error', () => undefined)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.server.address() as { port: number }).port
    return {
      server,
      messages,
      envelopes,
      smtp: {
        host: 'localhost',
        port,
        tls: secure ? ('tls' as const) : ('starttls' as const),
        username: 'fixture',
        password: 'test-only-password',
        from: 'sender@example.test',
      },
    }
  }
  it.each([true, false])(
    'SMTP secure=%s 验证 TLS/STARTTLS、独立收件人、稳定 Message-ID 与 HTML 转义',
    async (secure) => {
      const receiver = await smtpReceiver(secure),
        j = job()
      const result = await sendNotificationEmail({
        smtp: receiver.smtp,
        recipient: 'a@example.test',
        job: j,
        signal: AbortSignal.timeout(5000),
      })
      expect(result.outcome).toBe('accepted')
      expect(receiver.envelopes).toEqual([['a@example.test']])
      expect(receiver.messages[0]).toContain(`Message-ID: <${j.deliveryId}@cairn.notification>`)
      expect(receiver.messages[0]).toContain('text/html')
      expect(receiver.messages[0]).not.toContain('<img src=x')
      expect(
        (
          await sendNotificationEmail({
            smtp: receiver.smtp,
            recipient: 'reject@example.test',
            job: j,
            signal: AbortSignal.timeout(5000),
          })
        ).outcome,
      ).toBe('failed')
      expect(receiver.messages).toHaveLength(1)
    },
  )
  it('SMTP 4xx / 5xx 明确拒收和认证失败不记 accepted', async () => {
    for (const [behavior, expected] of [
      ['temporary', 'retryable'],
      ['permanent', 'failed'],
      ['authfail', 'failed'],
    ] as const) {
      const receiver = await smtpReceiver(true, behavior)
      expect(
        (
          await sendNotificationEmail({
            smtp: receiver.smtp,
            recipient: 'a@example.test',
            job: job(),
            signal: AbortSignal.timeout(5000),
          })
        ).outcome,
      ).toBe(expected)
      expect(receiver.messages.length).toBe(behavior === 'authfail' ? 0 : 1)
    }
  })
  it('证书验证失败无邮件提交', async () => {
    const receiver = await smtpReceiver(true)
    setDefaultCACertificates(originalCAs)
    try {
      expect(
        (
          await sendNotificationEmail({
            smtp: receiver.smtp,
            recipient: 'a@example.test',
            job: job(),
            signal: AbortSignal.timeout(5000),
          })
        ).outcome,
      ).not.toBe('accepted')
      expect(receiver.messages).toHaveLength(0)
    } finally {
      setDefaultCACertificates([...originalCAs, cert.toString()])
    }
  })
  it('SMTP 已接收 DATA 但回执前断连，保留 unknown 并核对实际接收次数', async () => {
    const receiver = await smtpReceiver(false, 'disconnect')
    expect(
      (
        await sendNotificationEmail({
          smtp: receiver.smtp,
          recipient: 'a@example.test',
          job: job(),
          signal: AbortSignal.timeout(5000),
        })
      ).outcome,
    ).toBe('unknown')
    expect(receiver.messages).toHaveLength(1)
  })
})
