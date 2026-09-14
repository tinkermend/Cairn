import type { Page } from 'playwright'

export type BindingRequest = {
  nonce: string
  intent: string
}

export type BindingHandle = {
  calls: BindingRequest[]
  stopped: boolean
  stop(): void
}

const BINDING = 'cairnLlmInvoke'

/**
 * 页内 Agent 的最小 Worker 出口：按 Attempt 发 nonce，校验形状，stop 后拒绝。
 * 不注入官方 demo IIFE。
 */
export async function installInpageBinding(
  page: Page,
  attemptNonce: string,
  respond: (req: BindingRequest) => unknown,
): Promise<BindingHandle> {
  const calls: BindingRequest[] = []
  const handle: BindingHandle = {
    calls,
    stopped: false,
    stop() {
      handle.stopped = true
    },
  }

  await page.exposeBinding(BINDING, async (_source, raw) => {
    if (handle.stopped) throw new Error('CAIRN_STOPPED')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('CAIRN_BINDING_SHAPE')
    }
    const nonce = (raw as { nonce?: unknown }).nonce
    const intent = (raw as { intent?: unknown }).intent
    if (nonce !== attemptNonce) throw new Error('CAIRN_BINDING_DENIED')
    if (typeof intent !== 'string' || intent.length === 0 || intent.length > 512) {
      throw new Error('CAIRN_BINDING_SHAPE')
    }
    const req = { nonce, intent }
    calls.push(req)
    return respond(req)
  })

  return handle
}

export async function bootstrapInpageAgent(page: Page): Promise<void> {
  await page.evaluate(() => {
    const g = globalThis as typeof globalThis & {
      __cairnPageAgent?: unknown
      cairnLlmInvoke?: (payload: { nonce: string; intent: string }) => Promise<unknown>
    }
    g.__cairnPageAgent = {
      async run(nonce: string, intent: string) {
        if (!g.cairnLlmInvoke) throw new Error('CAIRN_BINDING_MISSING')
        return g.cairnLlmInvoke({ nonce, intent })
      },
    }
  })
}

export async function invokeInpageAgent(page: Page, nonce: string, intent: string): Promise<unknown> {
  return page.evaluate(
    async ([n, i]) => {
      const agent = (globalThis as {
        __cairnPageAgent?: { run: (nonce: string, intent: string) => Promise<unknown> }
      }).__cairnPageAgent
      if (!agent) throw new Error('CAIRN_AGENT_MISSING')
      return agent.run(n, i)
    },
    [nonce, intent] as const,
  )
}

export const INPAGE_BOOTSTRAP = `
window.__cairnPageAgent = {
  async run(nonce, intent) {
    return window.cairnLlmInvoke({ nonce, intent })
  }
}
`
