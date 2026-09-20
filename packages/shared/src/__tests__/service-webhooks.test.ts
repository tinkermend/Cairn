import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SERVICE_WEBHOOK_MAX_ATTEMPTS,
  SERVICE_WEBHOOK_DELIVERY_PROTOCOL,
  servicePlaygroundRunBodySchema,
  serviceWebhookRetryDelayMs,
  serviceWebhookSchema,
  serviceWebhookWriteSchema,
} from '../service-webhooks.js'

const id = '11111111-1111-4111-8111-111111111111'

describe('服务 Webhook 共享契约', () => {
  it('只接受可公开访问的 HTTPS 配置、去重事件和写入时的签名密钥', () => {
    const good = serviceWebhookWriteSchema.parse({
      url: 'https://hooks.example.test/cairn',
      events: ['run.completed', 'run.failed'],
      enabled: true,
      secret: 'whsec_test',
    })
    expect(good).toMatchObject({ enabled: true, secret: 'whsec_test' })
    for (const url of [
      'http://hooks.example.test/cairn',
      'https://127.0.0.1/cairn',
      'https://user:password@hooks.example.test/cairn',
      'https://hooks.example.test/cairn#fragment',
    ])
      expect(
        serviceWebhookWriteSchema.safeParse({
          url,
          events: ['run.completed'],
        }).success,
      ).toBe(false)
    expect(
      serviceWebhookWriteSchema.safeParse({
        url: 'https://hooks.example.test/cairn',
        events: ['run.completed', 'run.completed'],
      }).success,
    ).toBe(false)
  })

  it('公开读取 DTO 不含密钥，固定投递上限和退避阶梯', () => {
    const dto = serviceWebhookSchema.parse({
      id,
      callerId: id,
      url: 'https://hooks.example.test/cairn',
      host: 'hooks.example.test',
      events: ['run.completed'],
      status: 'active',
      secretConfigured: true,
      createdAt: '2026-09-19T08:00:00.000Z',
      updatedAt: '2026-09-19T08:00:00.000Z',
    })
    expect(dto).not.toHaveProperty('secret')
    expect(DEFAULT_SERVICE_WEBHOOK_MAX_ATTEMPTS).toBe(5)
    expect([1, 2, 3, 4].map(serviceWebhookRetryDelayMs)).toEqual([
      10_000,
      30_000,
      120_000,
      600_000,
    ])
    expect(SERVICE_WEBHOOK_DELIVERY_PROTOCOL).toBe('service-webhook-delivery@1')
  })

  it('把 Playground 凭据与开放 API 的运行请求组合成闭合契约', () => {
    expect(
      servicePlaygroundRunBodySchema.parse({
        credentialId: id,
        scenarioId: id,
        scenarioVersionId: id,
        targetAccountId: id,
        input: { orderId: 'PO-1001' },
        idempotencyKey: 'playground-order-1001',
      }),
    ).toMatchObject({ credentialId: id, input: { orderId: 'PO-1001' } })
    expect(
      servicePlaygroundRunBodySchema.safeParse({
        credentialId: id,
        scenarioId: id,
        scenarioVersionId: id,
        idempotencyKey: 'short',
      }).success,
    ).toBe(false)
  })
})
