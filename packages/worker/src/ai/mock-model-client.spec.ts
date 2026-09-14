import { describe, expect, it } from 'vitest'
import {
  buildChatCompletionResponse,
  MockModelClient,
  ModelClientError,
} from './mock-model-client.js'

describe('MockModelClient', () => {
  it('支持默认响应与队列响应', async () => {
    const client = new MockModelClient()
    client.enqueueTextResponse('response-1')
    client.enqueueJsonResponse({ foo: 'bar' })

    const res1 = (await client.chat.completions.create({ prompt: 'p1' })) as any
    expect(res1.choices[0].message.content).toBe('response-1')

    const res2 = (await client.chat.completions.create({ prompt: 'p2' })) as any
    expect(JSON.parse(res2.choices[0].message.content)).toEqual({ foo: 'bar' })

    const res3 = (await client.chat.completions.create({ prompt: 'p3' })) as any
    expect(JSON.parse(res3.choices[0].message.content)).toEqual({ ok: true })

    expect(client.callCount).toBe(3)
    expect(client.calls[0]?.params).toEqual({ prompt: 'p1' })
  })

  it('支持自定义 handler 编排', async () => {
    const client = new MockModelClient({
      handler: (params, n) => buildChatCompletionResponse(`custom-${n}`),
    })
    const res1 = (await client.chat.completions.create({})) as any
    expect(res1.choices[0].message.content).toBe('custom-1')
    const res2 = (await client.chat.completions.create({})) as any
    expect(res2.choices[0].message.content).toBe('custom-2')
  })

  describe('Chaos 故障注入', () => {
    it('模拟超时 (timeout) 故障', async () => {
      const client = new MockModelClient({
        chaos: { timeout: true },
      })
      await expect(client.chat.completions.create({})).rejects.toThrow('Model request timed out')
    })

    it('模拟 AbortSignal 协作取消', async () => {
      const client = new MockModelClient({
        chaos: { delayMs: 100 },
      })
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 10)
      await expect(client.chat.completions.create({}, { signal: controller.signal })).rejects.toThrow(
        'AbortError',
      )
    })

    it('模拟 429 限流与 Retry-After', async () => {
      const client = new MockModelClient({
        chaos: { rateLimit: { retryAfterSeconds: 5, message: 'Too Many Requests' } },
      })
      try {
        await client.chat.completions.create({})
        expect.unreachable('Should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(ModelClientError)
        const modelErr = err as ModelClientError
        expect(modelErr.status).toBe(429)
        expect(modelErr.retryAfterSeconds).toBe(5)
        expect(modelErr.message).toBe('Too Many Requests')
      }
    })

    it('模拟损坏的 JSON 响应', async () => {
      const client = new MockModelClient({
        chaos: { malformedJson: true },
      })
      const res = (await client.chat.completions.create({})) as any
      const content = res.choices[0].message.content
      expect(() => JSON.parse(content)).toThrow()
    })

    it('模拟幻觉 (不存在的选择器 / 非法 Schema)', async () => {
      const client = new MockModelClient({
        chaos: { hallucination: { kind: 'non_existent_element' } },
      })
      const res = (await client.chat.completions.create({})) as any
      const parsed = JSON.parse(res.choices[0].message.content)
      expect(parsed.target.selector).toBe('#ghost-element-never-exists')

      client.setChaos({
        chaos: undefined,
        hallucination: {
          kind: 'invalid_schema',
          details: { unexpected: true, number: 'not-a-number' },
        },
      } as any)
      const res2 = (await client.chat.completions.create({})) as any
      const parsed2 = JSON.parse(res2.choices[0].message.content)
      expect(parsed2.unexpected).toBe(true)
    })

    it('支持 once 模式：初次注入故障，重试自动恢复', async () => {
      const client = new MockModelClient({
        chaos: { timeout: true, once: true },
        defaultResponse: buildChatCompletionResponse('recovered'),
      })

      // 第一次调用失败
      await expect(client.chat.completions.create({})).rejects.toThrow('Model request timed out')

      // 第二次重试调用成功
      const res = (await client.chat.completions.create({})) as any
      expect(res.choices[0].message.content).toBe('recovered')
      expect(client.callCount).toBe(2)
    })
  })
})
