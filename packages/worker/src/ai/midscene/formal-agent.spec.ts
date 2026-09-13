import { describe, expect, it } from 'vitest'
import { midsceneModelConfig, validateBrowserAiModelFamily } from './formal-agent.js'

describe('正式适配层与 SDK 的接缝', () => {
  it('模型族按 SDK 枚举校验，拼写错误在启动期就失败', async () => {
    await expect(validateBrowserAiModelFamily('doubao-seed')).resolves.toBeUndefined()
    await expect(validateBrowserAiModelFamily('doubao-seed-2-1-turbo')).rejects.toThrow(
      /模型族枚举|validateModelFamily/,
    )
  })

  it('平台配置映射成 SDK 键，且不写进程环境', () => {
    const config = midsceneModelConfig({
      config: {
        adapter: 'midscene',
        adapterVersion: '1.12.6',
        sdkVersion: '1.12.6',
        routeId: 'test-route',
        policyVersion: '1',
        configVersion: '1',
        modelBaseUrl: 'https://ark.example/api/v3',
        modelName: 'doubao-seed-2-1-turbo-260628',
        modelFamily: 'doubao-seed',
        promptVersion: '1',
        requestTimeoutMs: 15_000,
        hangWaitMs: 5_000,
        maxCalls: 20,
        maxOutputTokens: 2048,
      },
      apiKey: 'sk-test',
    })
    expect(config).toEqual({
      MIDSCENE_MODEL_NAME: 'doubao-seed-2-1-turbo-260628',
      MIDSCENE_MODEL_FAMILY: 'doubao-seed',
      MIDSCENE_MODEL_API_KEY: 'sk-test',
      MIDSCENE_MODEL_BASE_URL: 'https://ark.example/api/v3',
    })
    expect(process.env.MIDSCENE_MODEL_API_KEY).toBeUndefined()
    expect(process.env.MIDSCENE_MODEL_NAME).toBeUndefined()
  })
})
