import type { Page } from 'playwright'
import { ActionGate, gateActions } from './action-gate.js'
import {
  PROBE_MODEL_CONFIG,
  readPlatformModelConfig,
  wrapModelClient,
  type OpenAiLike,
} from './model-client.js'

export type ManagedAgentHandle = {
  gate: ActionGate
  page: Page
  interface: {
    actionSpace(): Array<{ name: string; call: (param: unknown, context?: unknown) => unknown }>
  }
  destroy(): Promise<void>
}

/**
 * 在已纳管 Page 上构造 Midscene Agent。标志位关闭默认副作用，动作边先过 gate。
 * Engine / WorkerModule 不得 import 本文件。
 */
export async function createManagedMidsceneAgent(input: {
  page: Page
  gate: ActionGate
  modelClient: OpenAiLike
  runDir: string
}): Promise<ManagedAgentHandle> {
  const { setMidsceneRunDir } = await import('@midscene/shared/common')
  setMidsceneRunDir(input.runDir)

  try {
    const web = await import('@midscene/web/playwright/agent')
    const core = (await import('@midscene/core')) as unknown as { Agent?: unknown; default?: unknown }
    const PlaywrightWebPage = web.PlaywrightWebPage
    if (!PlaywrightWebPage) {
      throw new Error('CAIRN_MIDSCENE_EXPORT: 找不到 PlaywrightWebPage')
    }
    const Agent = core.Agent ?? core.default
    if (typeof Agent !== 'function') {
      throw new Error('CAIRN_MIDSCENE_EXPORT: 找不到 Agent')
    }
    const AgentCtor = Agent as new (
      page: unknown,
      options: {
        generateReport: boolean
        modelConfig: Record<string, string>
        createOpenAIClient: (client: OpenAiLike) => Promise<OpenAiLike>
      },
    ) => { destroy?: () => Promise<void> }

    const webPage = new PlaywrightWebPage(input.page, {
      forceSameTabNavigation: false,
      forceChromeSelectRendering: false,
    })
    const originalSpace = webPage.actionSpace.bind(webPage)
    webPage.actionSpace = () => gateActions(originalSpace(), input.gate)

    const agent = new AgentCtor(webPage, {
      generateReport: false,
      modelConfig: { ...(readPlatformModelConfig() ?? PROBE_MODEL_CONFIG) },
      createOpenAIClient: async (client: OpenAiLike) => wrapModelClient({
        gate: input.gate,
        inner: input.modelClient ?? client,
        records: [],
      }),
    })

    return {
      gate: input.gate,
      page: input.page,
      interface: webPage as ManagedAgentHandle['interface'],
      async destroy() {
        try {
          if (typeof agent.destroy === 'function') await agent.destroy()
        } finally {
          setMidsceneRunDir(undefined)
        }
      },
    }
  } catch (error) {
    setMidsceneRunDir(undefined)
    throw error
  }
}

export async function invokeGatedAction(
  handle: ManagedAgentHandle,
  name: string,
  param: unknown,
): Promise<unknown> {
  const action = handle.interface.actionSpace().find((item) => item.name === name)
  if (!action) throw new Error(`CAIRN_NO_ACTION:${name}`)
  return action.call(param)
}
