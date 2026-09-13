import { afterEach, describe, expect, it } from 'vitest'
import { ActionGate, createCallBarrier } from './action-gate.js'
import {
  createFakeChatClient,
  processModelEnvKeys,
  readPlatformModelConfig,
  wrapModelClient,
} from './model-client.js'

describe('wrapModelClient', () => {
  it('abort 后不再发模型请求', async () => {
    const controller = new AbortController()
    const gate = new ActionGate(controller.signal)
    const records: Array<{ n: number; params: unknown }> = []
    const wrapped = wrapModelClient({
      gate,
      records,
      inner: createFakeChatClient(() => ({ id: 'ok' })),
    })
    await wrapped.chat.completions.create({ model: 'x' })
    controller.abort()
    await expect(wrapped.chat.completions.create({ model: 'y' })).rejects.toThrow('CAIRN_ABORTED:model')
    expect(records).toHaveLength(1)
  })

  it('屏障扣住第 1 次调用，abort 后放行仍拒绝', async () => {
    const controller = new AbortController()
    const gate = new ActionGate(controller.signal)
    const barrier = createCallBarrier()
    const records: Array<{ n: number; params: unknown }> = []
    const wrapped = wrapModelClient({
      gate,
      records,
      barrier,
      inner: createFakeChatClient(() => ({ id: 'ok' })),
    })
    const pending = wrapped.chat.completions.create({ model: 'held' })
    controller.abort()
    barrier.release()
    await expect(pending).rejects.toThrow('CAIRN_ABORTED:model')
    expect(records).toHaveLength(1)
  })
})

describe('readPlatformModelConfig', () => {
  const keys = [
    'CAIRN_S06_MODEL_NAME',
    'CAIRN_S06_MODEL_FAMILY',
    'CAIRN_S06_MODEL_API_KEY',
    'CAIRN_S06_MODEL_BASE_URL',
  ] as const
  const saved = new Map<string, string | undefined>()

  afterEach(() => {
    for (const key of keys) {
      if (saved.has(key)) {
        const value = saved.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
        saved.delete(key)
      }
    }
  })

  function stub(env: Partial<Record<(typeof keys)[number], string>>): void {
    for (const key of keys) {
      saved.set(key, process.env[key])
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
    }
  }

  it('缺任一平台键则不用，避免半套环境', () => {
    stub({ CAIRN_S06_MODEL_NAME: 'qwen' })
    expect(readPlatformModelConfig()).toBeUndefined()
  })

  it('四键齐全时映射为 modelConfig，不写进程 MIDSCENE_*', () => {
    stub({
      CAIRN_S06_MODEL_NAME: 'qwen-vl',
      CAIRN_S06_MODEL_FAMILY: 'qwen3-vl',
      CAIRN_S06_MODEL_API_KEY: 'not-a-real-key',
      CAIRN_S06_MODEL_BASE_URL: 'http://127.0.0.1:9/v1',
    })
    expect(readPlatformModelConfig()).toEqual({
      MIDSCENE_MODEL_NAME: 'qwen-vl',
      MIDSCENE_MODEL_FAMILY: 'qwen3-vl',
      MIDSCENE_MODEL_API_KEY: 'not-a-real-key',
      MIDSCENE_MODEL_BASE_URL: 'http://127.0.0.1:9/v1',
    })
    expect(processModelEnvKeys()).toEqual([])
  })
})
