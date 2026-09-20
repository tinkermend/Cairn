import { createServer, type IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEV_CREDENTIAL_KEY, type AlertNotice } from '@cairn/shared'
import { credentialKeyFromEnv, LocalSecretProvider } from '@cairn/secret'
import { deliverDueAlertNotices } from './alert-delivery.js'

vi.mock('@cairn/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cairn/db')>()
  return {
    ...actual,
    claimDueAlertDeliveries: vi.fn(),
    finishAlertDelivery: vi.fn(async () => undefined),
    getOrCreatePlatformConfig: vi.fn(),
    loadSecretCiphertext: vi.fn(),
  }
})

const {
  claimDueAlertDeliveries,
  finishAlertDelivery,
  getOrCreatePlatformConfig,
  loadSecretCiphertext,
} = await import('@cairn/db')

const here = dirname(fileURLToPath(import.meta.url))

const notice: AlertNotice = {
  kind: 'firing',
  alertId: '00000000-0000-4000-8000-000000000031',
  ruleId: 'factory.worker.lost',
  ruleName: '执行节点失联',
  metricKey: 'worker.status.lost',
  source: null,
  scope: 'platform',
  scopeId: 'platform',
  value: 1,
  threshold: 1,
  comparator: 'gte',
  severity: 'critical',
  at: '2026-09-18T13:00:00.000Z',
  consolePath: '/monitoring',
}

function listen(handler: (req: IncomingMessage, body: string) => { status: number }): Promise<{
  url: string
  received: Array<{ headers: IncomingMessage['headers']; body: string }>
  close: () => Promise<void>
}> {
  const received: Array<{ headers: IncomingMessage['headers']; body: string }> = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk as Buffer))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      received.push({ headers: req.headers, body })
      const result = handler(req, body)
      res.statusCode = result.status
      res.end()
    })
  })
  return new Promise((resolveListen, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no address'))
        return
      }
      resolveListen({
        url: `http://127.0.0.1:${address.port}/hook`,
        received,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) => (error ? rejectClose(error) : resolveClose()))
          }),
      })
    })
  })
}

describe('告警 Webhook 投递', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('实现只用全局 fetch', () => {
    const src = readFileSync(resolve(here, 'alert-delivery.ts'), 'utf8')
    expect(src).toMatch(/globalThis\.fetch/)
    expect(src).not.toMatch(/axios|ky|got|superagent/)
  })

  it('RMD06/RMD07 非 2xx 记失败，正文不含 URL 与令牌', async () => {
    const secrets = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))
    const secretId = '00000000-0000-4000-8000-000000000041'
    const webhook = await listen(() => ({ status: 503 }))
    const ciphertext = secrets.encrypt(
      secretId,
      JSON.stringify({ v: 1, url: 'https://hooks.example.com/alert', token: 'hook-token' }),
    )
    vi.mocked(claimDueAlertDeliveries).mockResolvedValue([
      {
        alertId: notice.alertId,
        channelIds: ['00000000-0000-4000-8000-000000000042'],
        silenced: false,
        notice,
      },
    ])
    vi.mocked(getOrCreatePlatformConfig).mockResolvedValue({
      revision: 1,
      document: {
        alerting: {
          rules: [],
          channels: [
            {
              id: '00000000-0000-4000-8000-000000000042',
              name: '值班',
              kind: 'webhook',
              enabled: true,
              secretRef: { provider: 'local', secretId },
              urlHost: '127.0.0.1',
            },
          ],
        },
      },
    } as never)
    vi.mocked(loadSecretCiphertext).mockResolvedValue({ id: secretId, provider: 'local', ciphertext })

    const result = await deliverDueAlertNotices({
      db: {} as never,
      secrets,
      fetchImpl: async (url, init) => {
        const response = await fetch(webhook.url, init)
        void url
        return response
      },
      resolveHosts: async () => ['203.0.113.10'],
    })
    expect(result.failed).toBe(1)
    expect(finishAlertDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', errorClass: 'webhook_http_503' }),
    )
    expect(webhook.received[0]?.headers.authorization).toBe('Bearer hook-token')
    expect(webhook.received[0]?.body).toContain('"kind":"firing"')
    expect(webhook.received[0]?.body).not.toContain('hooks.example.com')
    expect(webhook.received[0]?.body).not.toContain('hook-token')
    await webhook.close()
  })

  it('渠道不可达记 webhook_unreachable，评估旁路不受影响', async () => {
    const secrets = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))
    const secretId = '00000000-0000-4000-8000-000000000043'
    const ciphertext = secrets.encrypt(
      secretId,
      JSON.stringify({ v: 1, url: 'https://hooks.example.com/alert' }),
    )
    vi.mocked(claimDueAlertDeliveries).mockResolvedValue([
      {
        alertId: notice.alertId,
        channelIds: ['00000000-0000-4000-8000-000000000044'],
        silenced: false,
        notice,
      },
    ])
    vi.mocked(getOrCreatePlatformConfig).mockResolvedValue({
      revision: 1,
      document: {
        alerting: {
          rules: [],
          channels: [
            {
              id: '00000000-0000-4000-8000-000000000044',
              name: '值班',
              kind: 'webhook',
              enabled: true,
              secretRef: { provider: 'local', secretId },
              urlHost: '127.0.0.1',
            },
          ],
        },
      },
    } as never)
    vi.mocked(loadSecretCiphertext).mockResolvedValue({ id: secretId, provider: 'local', ciphertext })
    const result = await deliverDueAlertNotices({
      db: {} as never,
      secrets,
      resolveHosts: async () => ['203.0.113.10'],
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED 203.0.113.10:443')
      },
    })
    expect(result.failed).toBe(1)
    expect(finishAlertDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', errorClass: 'webhook_unreachable' }),
    )
  })

  it('解析到内网地址记 webhook_blocked，不发请求', async () => {
    const secrets = new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY))
    const secretId = '00000000-0000-4000-8000-000000000045'
    const ciphertext = secrets.encrypt(
      secretId,
      JSON.stringify({ v: 1, url: 'https://hooks.example.com/alert' }),
    )
    const fetchImpl = vi.fn()
    vi.mocked(claimDueAlertDeliveries).mockResolvedValue([
      {
        alertId: notice.alertId,
        channelIds: ['00000000-0000-4000-8000-000000000046'],
        silenced: false,
        notice,
      },
    ])
    vi.mocked(getOrCreatePlatformConfig).mockResolvedValue({
      revision: 1,
      document: {
        alerting: {
          rules: [],
          channels: [
            {
              id: '00000000-0000-4000-8000-000000000046',
              name: '值班',
              kind: 'webhook',
              enabled: true,
              secretRef: { provider: 'local', secretId },
              urlHost: 'hooks.example.com',
            },
          ],
        },
      },
    } as never)
    vi.mocked(loadSecretCiphertext).mockResolvedValue({ id: secretId, provider: 'local', ciphertext })
    const result = await deliverDueAlertNotices({
      db: {} as never,
      secrets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveHosts: async () => ['10.0.0.8'],
    })
    expect(result.failed).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(finishAlertDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', errorClass: 'webhook_blocked' }),
    )
  })

  it('RMD08 静默投递记 suppressed 且不发请求', async () => {
    const fetchImpl = vi.fn()
    vi.mocked(claimDueAlertDeliveries).mockResolvedValue([
      { alertId: notice.alertId, channelIds: ['c1'], silenced: true, notice },
    ])
    vi.mocked(getOrCreatePlatformConfig).mockResolvedValue({
      revision: 1,
      document: { alerting: { rules: [], channels: [] } },
    } as never)
    const result = await deliverDueAlertNotices({
      db: {} as never,
      secrets: new LocalSecretProvider(credentialKeyFromEnv(DEV_CREDENTIAL_KEY)),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.suppressed).toBe(1)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(finishAlertDelivery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'suppressed' }),
    )
  })
})
