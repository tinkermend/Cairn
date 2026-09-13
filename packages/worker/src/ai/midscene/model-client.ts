import type { ActionGate } from './action-gate.js'

export type OpenAiLike = {
  chat: {
    completions: {
      create: (params: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>
    }
  }
}

export type ModelCallRecord = {
  n: number
  params: unknown
  retry?: boolean
}

/**
 * 包一层 OpenAI-compatible client：计数、屏障、gate。
 * 这是 P8 Router 要接的 createOpenAIClient 形状。
 */
export function wrapModelClient(input: {
  gate: ActionGate
  inner: OpenAiLike
  barrier?: { waitIf(n: number): Promise<void> }
  records: ModelCallRecord[]
}): OpenAiLike {
  return {
    chat: {
      completions: {
        create: async (params: unknown, options?: { signal?: AbortSignal }) => {
          input.gate.assertAllowed('model')
          const n = input.records.length + 1
          input.records.push({ n, params })
          if (input.barrier) await input.barrier.waitIf(n)
          input.gate.assertAllowed('model')
          return input.inner.chat.completions.create(params, options)
        },
      },
    },
  }
}

export function createFakeChatClient(respond: (n: number, params: unknown) => unknown): OpenAiLike {
  let n = 0
  return {
    chat: {
      completions: {
        create: async (params) => {
          n += 1
          return respond(n, params)
        },
      },
    },
  }
}

export type ProbeModelConfig = {
  MIDSCENE_MODEL_NAME: string
  MIDSCENE_MODEL_FAMILY: string
  MIDSCENE_MODEL_API_KEY: string
  MIDSCENE_MODEL_BASE_URL: string
}

/** 适配层必须传入的隔离配置，禁止依赖进程里的 MIDSCENE_*。 */
export const PROBE_MODEL_CONFIG: ProbeModelConfig = {
  MIDSCENE_MODEL_NAME: 'cairn-fake',
  MIDSCENE_MODEL_FAMILY: 'qwen3-vl',
  MIDSCENE_MODEL_API_KEY: 'cairn-probe-not-a-real-key',
  MIDSCENE_MODEL_BASE_URL: 'http://127.0.0.1:9',
}

/** 在线探针读平台键。缺任一字段则不用，避免半套环境回落 SDK 全局配置。 */
export function readPlatformModelConfig(): ProbeModelConfig | undefined {
  const name = process.env.CAIRN_S06_MODEL_NAME?.trim()
  const family = process.env.CAIRN_S06_MODEL_FAMILY?.trim()
  const apiKey = process.env.CAIRN_S06_MODEL_API_KEY?.trim()
  const baseUrl = process.env.CAIRN_S06_MODEL_BASE_URL?.trim()
  if (!name || !family || !apiKey || !baseUrl) return undefined
  return {
    MIDSCENE_MODEL_NAME: name,
    MIDSCENE_MODEL_FAMILY: family,
    MIDSCENE_MODEL_API_KEY: apiKey,
    MIDSCENE_MODEL_BASE_URL: baseUrl,
  }
}

export function processModelEnvKeys(): string[] {
  return Object.keys(process.env).filter(
    (key) => key.startsWith('MIDSCENE_') || key.startsWith('OPENAI_'),
  )
}
