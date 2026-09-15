import { describe, expect, it } from 'vitest'
import { ActionGate } from './action-gate.js'
import { midsceneModelConfig, validateBrowserAiModelFamily, wrapActionSpace } from './formal-agent.js'

describe('正式适配层与 SDK 的接缝', () => {
  it('只读步骤拒绝整条动作通道，SDK 新增的未知动作名也不例外', async () => {
    const gate = new ActionGate()
    let called = 0
    const actions = [
      { name: 'Tap', call: async () => void (called += 1) },
      { name: 'FutureAction', call: async () => void (called += 1) },
    ]
    for (const action of wrapActionSpace(actions, gate, true)) {
      await expect(action.call()).rejects.toThrow(`CAIRN_READONLY:${action.name}`)
    }
    expect(called).toBe(0)

    const [tap] = wrapActionSpace(actions, gate, false)
    await tap!.call()
    expect(called).toBe(1)
    gate.markLeaseLost()
    await expect(tap!.call()).rejects.toThrow('CAIRN_LEASE_LOST:action')
    expect(called).toBe(1)
  })

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
