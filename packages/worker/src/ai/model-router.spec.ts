import { describe, expect, it } from 'vitest'
import { MockModelRouter } from './model-router.js'
import { MockModelClient, ModelClientError } from './mock-model-client.js'

describe('ModelRouter & Universal IModelClient SPI', () => {
  it('支持多路由绑定、配置读取与默认回退', async () => {
    const router = new MockModelRouter()
    const visionClient = new MockModelClient()
    const reasoningClient = new MockModelClient()
    const fallbackClient = new MockModelClient()

    router.setRoute('vlm-vision-fast', visionClient, {
      modelName: 'qwen-vl-max',
      provider: 'qwen',
    })
    router.setRoute('llm-reasoning', reasoningClient, {
      modelName: 'deepseek-r1',
      provider: 'deepseek',
    })
    router.setDefaultClient(fallbackClient)

    expect(router.getClient('vlm-vision-fast')).toBe(visionClient)
    expect(router.getClient('llm-reasoning')).toBe(reasoningClient)
    expect(router.getClient('unknown-route')).toBe(fallbackClient)

    const visionCfg = router.getRouteConfig('vlm-vision-fast')
    expect(visionCfg.modelName).toBe('qwen-vl-max')
    expect(visionCfg.provider).toBe('qwen')
  })

  it('未配置路由且无默认客户端时明确报错', () => {
    const router = new MockModelRouter()
    expect(() => router.getClient('ghost-route')).toThrowError(
      '未配置 routeKey 为 "ghost-route" 的模型客户端且无默认客户端',
    )
  })

  it('支持在多路由间独立注入 Chaos 混沌与降级模拟', async () => {
    const router = new MockModelRouter()

    // 路由 1: 正常视觉模型
    const visionClient = new MockModelClient()
    visionClient.enqueueJsonResponse({ box: [100, 200, 300, 400], label: 'Submit Button' })

    // 路由 2: 故障限流推理模型 (429 RateLimit)
    const reasoningClient = new MockModelClient({
      chaos: {
        rateLimit: {
          retryAfterSeconds: 5,
          message: 'Upstream rate limit exceeded',
        },
      },
    })

    router.setRoute('vision', visionClient)
    router.setRoute('reasoning', reasoningClient)

    // 调用视觉路由：正常返回
    const visionRes = await router.getClient('vision').complete([
      { role: 'user', content: 'Locate the button' },
    ])
    expect(JSON.parse(visionRes.content)).toEqual({
      box: [100, 200, 300, 400],
      label: 'Submit Button',
    })

    // 调用推理路由：按预期触发限流异常
    await expect(
      router.getClient('reasoning').complete([
        { role: 'user', content: 'Analyze the business rule' },
      ]),
    ).rejects.toThrow(ModelClientError)
  })

  it('IModelClient.complete 标准接口提取 content, model 与 usage', async () => {
    const client = new MockModelClient()
    client.enqueueTextResponse('{"decision":"APPROVE","confidence":0.99}')

    const result = await client.complete(
      [
        { role: 'system', content: 'You are an auditor' },
        { role: 'user', content: 'Check this invoice' },
      ],
      { model: 'cairn-fast-eval', temperature: 0 },
    )

    expect(result.content).toBe('{"decision":"APPROVE","confidence":0.99}')
    expect(result.model).toBe('cairn-mock-model')
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 30,
      totalTokens: 50,
    })
  })
})
