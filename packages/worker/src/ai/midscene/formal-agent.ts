import type { Page } from 'playwright'
import type { AiExecutionConfig, AiOutputSchema } from '@cairn/shared'
import { ActionGate, gateActions } from './action-gate.js'
import { beginMidsceneLogScope } from './run-dir.js'
import { buildDataDemand } from './extract.js'
import type { OpenAiLike } from './model-client.js'

export type FormalAgentHandle = {
  gate: ActionGate
  aiAct(instruction: string, signal?: AbortSignal): Promise<string | undefined>
  aiQuery(instruction: string, schema?: AiOutputSchema): Promise<unknown>
  aiAssert(instruction: string): Promise<{ pass: boolean; thought?: string; message?: string }>
  destroy(): Promise<void>
}

export function midsceneModelConfig(input: { config: AiExecutionConfig; apiKey: string }) {
  return {
    MIDSCENE_MODEL_NAME: input.config.modelName,
    MIDSCENE_MODEL_FAMILY: input.config.modelFamily,
    MIDSCENE_MODEL_API_KEY: input.apiKey,
    MIDSCENE_MODEL_BASE_URL: input.config.modelBaseUrl,
  }
}

/** 只读步骤拒绝整条动作通道（含 SDK 以后新增的动作名），不维护写操作名单；其余动作先过 gate。 */
export function wrapActionSpace<A extends { name: string; call: (...args: never[]) => unknown }>(
  actions: readonly A[],
  gate: ActionGate,
  readonly: boolean,
): A[] {
  const gated = gateActions(actions, gate)
  if (!readonly) return gated
  return gated.map((action) => ({
    ...action,
    call: (async () => {
      throw new Error(`CAIRN_READONLY:${action.name}`)
    }) as A['call'],
  }))
}

export async function createFormalMidsceneAgent(input: {
  page: Page
  gate: ActionGate
  wrapClient: (inner: OpenAiLike) => OpenAiLike
  modelConfig: ReturnType<typeof midsceneModelConfig>
  readonly: boolean
}): Promise<FormalAgentHandle> {
  const web = await import('@midscene/web/playwright/agent')
  const core = (await import('@midscene/core')) as unknown as { Agent?: unknown; default?: unknown }
  const PlaywrightWebPage = web.PlaywrightWebPage
  if (!PlaywrightWebPage) throw new Error('CAIRN_MIDSCENE_EXPORT: 找不到 PlaywrightWebPage')
  const Agent = core.Agent ?? core.default
  if (typeof Agent !== 'function') throw new Error('CAIRN_MIDSCENE_EXPORT: 找不到 Agent')
  const AgentCtor = Agent as new (
    page: unknown,
    options: {
      generateReport: boolean
      modelConfig: Record<string, string>
      createOpenAIClient: (client: OpenAiLike) => Promise<OpenAiLike>
    },
  ) => {
    aiAct(instruction: string, options?: { abortSignal?: AbortSignal }): Promise<string | undefined>
    aiQuery(dataDemand: string, options?: object): Promise<unknown>
    aiAssert(
      instruction: string,
      value?: unknown,
      options?: { keepRawResponse?: boolean },
    ): Promise<unknown>
    destroy?: () => Promise<void>
  }

  const webPage = new PlaywrightWebPage(input.page, {
    forceSameTabNavigation: false,
    forceChromeSelectRendering: false,
  })
  const originalSpace = webPage.actionSpace.bind(webPage)
  webPage.actionSpace = () => wrapActionSpace(originalSpace(), input.gate, input.readonly)

  // SDK 日志以 Agent 存活期计数，全部销毁后才轮换删除，见 run-dir.ts。
  const endLogScope = beginMidsceneLogScope()
  let agent: InstanceType<typeof AgentCtor>
  try {
    agent = new AgentCtor(webPage, {
      generateReport: false,
      modelConfig: { ...input.modelConfig },
      createOpenAIClient: async (client: OpenAiLike) => input.wrapClient(client),
    })
  } catch (error) {
    endLogScope()
    throw error
  }

  return {
    gate: input.gate,
    aiAct: (instruction, signal) => agent.aiAct(instruction, { abortSignal: signal }),
    aiQuery: (instruction, schema) => agent.aiQuery(buildDataDemand(instruction, schema)),
    aiAssert: async (instruction) => {
      const raw = await agent.aiAssert(instruction, undefined, { keepRawResponse: true })
      if (!raw || typeof raw !== 'object') {
        return { pass: false, thought: '模型没有返回断言结果' }
      }
      const record = raw as { pass?: boolean; thought?: string; message?: string }
      return {
        pass: Boolean(record.pass),
        thought: record.thought,
        message: record.message,
      }
    },
    async destroy() {
      try {
        if (typeof agent.destroy === 'function') await agent.destroy()
      } finally {
        endLogScope()
      }
    },
  }
}

/** 模型族枚举归 SDK 所有，平台不复制一份。1.12.6 只导出取值表，没有导出校验函数。 */
export async function validateBrowserAiModelFamily(family: string): Promise<void> {
  const env = (await import('@midscene/shared/env')) as unknown as {
    validateModelFamily?: (value: string) => void
    MODEL_FAMILY_VALUES?: readonly string[]
  }
  if (typeof env.validateModelFamily === 'function') {
    env.validateModelFamily(family)
    return
  }
  const values = env.MODEL_FAMILY_VALUES
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('CAIRN_MIDSCENE_EXPORT: 找不到 validateModelFamily 或 MODEL_FAMILY_VALUES')
  }
  if (!values.includes(family)) {
    throw new Error(`不在 SDK 模型族枚举内，可选值：${values.join('、')}`)
  }
}
